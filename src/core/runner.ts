import { randomUUID } from 'node:crypto';
import type {
  AdapterSpec,
  BudgetConfig,
  CheckResult,
  ConditionId,
  DomainDefinition,
  RunConfig,
  RunMode,
  RunRecord,
  Split,
  StateDiff,
  TaskDefinition,
  ToolCallRecord,
  TraceTurn,
  TrialRecord,
  TrialStatus,
  ModelConfig,
} from './types.js';
import { CONDITIONS } from './types.js';
import { AnvilError, errorMessage } from './errors.js';
import { requireDomain } from '../domains/index.js';
import { getDefaultAdapter } from '../domains/adapters.js';
import { buildConditionInterface, executeConditionTool, maxUnderlyingCallsFor, rawToolSchemaMap, readOnlyToolNames, type ConditionInterface } from './interfaces.js';
import { validateAdapter } from './adapter.js';
import { computeRunSummary } from './metrics.js';
import { hashJson, deepClone, nowIso, isPlainObject, truncate } from './util.js';
import { APP_VERSION } from './version.js';
import { Store } from './store.js';
import { buildSystemPrompt, createTransport, ModelTransportError, type ModelTransport, type WireMessage } from './model.js';

export const DEFAULT_BUDGET: BudgetConfig = {
  maxTurnsPerTrial: 8,
  maxUnderlyingToolCallsPerTrial: 6,
  maxUnderlyingToolCallsTotal: 120,
  maxTotalTokens: 250_000,
  maxWallClockMsPerTrial: 180_000,
  countPolicy: 'count-all-attempts',
};

export const DEFAULT_MODEL: Omit<ModelConfig, 'apiKey'> = {
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: 'qwen2.5:7b',
  temperature: 0,
  maxTokensPerCompletion: 900,
};

export interface StartExperimentInput {
  mode: RunMode;
  domain: string;
  split: Split;
  taskIds?: string[];
  conditions?: ConditionId[];
  trialsPerTask?: number;
  budget?: Partial<BudgetConfig>;
  adapterSource?: 'default' | 'saved';
  sessionNote?: string;
}

export interface RunnerOptions {
  store: Store;
  transportFactory?: (config: ModelConfig, timeoutMs: number) => ModelTransport;
}

interface ActiveRun {
  abort: AbortController;
  promise: Promise<void>;
}

interface BudgetState {
  underlyingCalls: number;
  totalTokens: number;
}

interface TrialBuild {
  status: TrialStatus;
  statusReason: string | null;
  error: { code: string; message: string; detail?: unknown } | null;
  turns: TraceTurn[];
  toolCalls: ToolCallRecord[];
  finalAnswer: string;
  usage: TrialRecord['usage'];
  model: TrialRecord['model'];
  notes: string[];
  checks: CheckResult[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function statusFromChecks(checks: CheckResult[]): { status: TrialStatus; reason: string | null } {
  const failed = checks.filter((check) => !check.ok);
  if (failed.length === 0) return { status: 'pass', reason: null };
  return { status: 'fail', reason: `${failed.length} independent check(s) failed.` };
}

export function normalizeBudget(input: Partial<BudgetConfig> | undefined, plannedTrials: number): BudgetConfig {
  return {
    maxTurnsPerTrial: clamp(Math.round(input?.maxTurnsPerTrial ?? DEFAULT_BUDGET.maxTurnsPerTrial), 1, 20),
    maxUnderlyingToolCallsPerTrial: clamp(
      Math.round(input?.maxUnderlyingToolCallsPerTrial ?? DEFAULT_BUDGET.maxUnderlyingToolCallsPerTrial),
      1,
      24,
    ),
    maxUnderlyingToolCallsTotal: clamp(
      Math.round(input?.maxUnderlyingToolCallsTotal ?? Math.max(40, plannedTrials * 4)),
      1,
      2000,
    ),
    maxTotalTokens: clamp(Math.round(input?.maxTotalTokens ?? DEFAULT_BUDGET.maxTotalTokens), 1000, 2_000_000),
    maxWallClockMsPerTrial: clamp(
      Math.round(input?.maxWallClockMsPerTrial ?? DEFAULT_BUDGET.maxWallClockMsPerTrial),
      5_000,
      600_000,
    ),
    countPolicy: 'count-all-attempts',
  };
}

export class ExperimentRunner {
  private readonly store: Store;
  private readonly transportFactory: (config: ModelConfig, timeoutMs: number) => ModelTransport;
  private readonly active = new Map<string, ActiveRun>();
  private readonly listeners = new Map<string, Set<(run: RunRecord) => void>>();

  constructor(options: RunnerOptions) {
    this.store = options.store;
    this.transportFactory = options.transportFactory ?? createTransport;
  }

  async start(
    input: StartExperimentInput,
    modelConfig: ModelConfig,
    options: { startedBy?: 'workbench' | 'mcp' | 'cli' } = {},
  ): Promise<RunRecord> {
    const domain = requireDomain(input.domain);
    if (input.mode !== 'live' && input.mode !== 'simulation') {
      throw new AnvilError('invalid_mode', 'mode must be "live" or "simulation".');
    }
    if (input.split !== 'dev' && input.split !== 'eval' && input.split !== 'eval2') {
      throw new AnvilError('invalid_split', 'split must be "dev", "eval" or "eval2".');
    }
    const splitTasks = domain.tasks.filter((task) => task.split === input.split);
    if (splitTasks.length === 0) throw new AnvilError('empty_split', `No tasks exist in the ${input.split} split.`);
    const requestedIds = input.taskIds && input.taskIds.length > 0 ? [...new Set(input.taskIds)] : splitTasks.map((task) => task.id);
    const tasks: TaskDefinition[] = [];
    for (const id of requestedIds) {
      const task = splitTasks.find((candidate) => candidate.id === id);
      if (!task) throw new AnvilError('invalid_task', `Task "${id}" is not in the ${input.split} split for ${domain.id}.`);
      tasks.push(task);
    }
    const conditions = (input.conditions && input.conditions.length > 0 ? [...new Set(input.conditions)] : CONDITIONS) as ConditionId[];
    for (const condition of conditions) {
      if (!CONDITIONS.includes(condition)) throw new AnvilError('invalid_condition', `Unknown condition "${condition}".`);
    }
    if (!conditions.includes('adapted')) {
      throw new AnvilError('missing_adapted', 'The experiment must include the adapted condition; this workbench compares all three interfaces.');
    }
    const trialsPerTask = clamp(Math.round(input.trialsPerTask ?? 1), 1, 5);
    const plannedTrials = tasks.length * conditions.length * trialsPerTask;
    const budget = normalizeBudget(input.budget, plannedTrials);

    if (input.mode === 'live') {
      if (!modelConfig.model || modelConfig.model.trim().length === 0) {
        throw new AnvilError('model_not_configured', 'Configure a model before running a live experiment.');
      }
      try {
        const url = new URL(modelConfig.baseUrl);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('bad protocol');
      } catch {
        throw new AnvilError('invalid_base_url', 'The model base URL must be an absolute http(s) URL.');
      }
      if (!Number.isFinite(modelConfig.temperature) || modelConfig.temperature < 0 || modelConfig.temperature > 2) {
        throw new AnvilError('invalid_temperature', 'temperature must be between 0 and 2.');
      }
      if (!Number.isFinite(modelConfig.maxTokensPerCompletion) || modelConfig.maxTokensPerCompletion < 32) {
        throw new AnvilError('invalid_max_tokens', 'maxTokensPerCompletion must be at least 32.');
      }
    }

    let adapter: AdapterSpec | null = null;
    if (conditions.includes('adapted')) {
      const source = input.adapterSource ?? 'default';
      let selected: AdapterSpec | undefined;
      if (source === 'saved') {
        const saved = await this.store.getSavedAdapter(domain.id);
        selected = saved?.spec;
        if (!selected) throw new AnvilError('adapter_missing', `No saved adapter exists for ${domain.id}. Validate and save one first.`);
      } else {
        selected = getDefaultAdapter(domain.id);
        if (!selected) throw new AnvilError('adapter_missing', `No default adapter exists for ${domain.id}.`);
      }
      const validation = validateAdapter(selected, {
        toolSchemas: rawToolSchemaMap(domain),
        rawToolNames: domain.tools.map((tool) => tool.name),
        readOnlyTools: readOnlyToolNames(domain),
      });
      if (!validation.ok) {
        throw new AnvilError('adapter_invalid', 'The adapter is invalid and cannot be used in an experiment.', 400, {
          issues: validation.issues.filter((issue) => issue.severity === 'error'),
        });
      }
      if (selected.domain !== domain.id) {
        throw new AnvilError('adapter_domain_mismatch', `The adapter targets "${selected.domain}" but the run domain is "${domain.id}".`);
      }
      adapter = selected;
    }

    const interfaces = new Map<ConditionId, ConditionInterface>();
    for (const condition of conditions) {
      interfaces.set(condition, buildConditionInterface(domain, condition, condition === 'adapted' ? adapter : null));
    }

    const id = `run_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${randomUUID().slice(0, 8)}`;
    const config: RunConfig = {
      mode: input.mode,
      domain: domain.id,
      split: input.split,
      taskIds: tasks.map((task) => task.id),
      conditions,
      trialsPerTask,
      model: {
        provider: modelConfig.provider,
        baseUrl: modelConfig.baseUrl,
        model: modelConfig.model,
        temperature: modelConfig.temperature,
        maxTokensPerCompletion: modelConfig.maxTokensPerCompletion,
      },
      budget,
      adapterSource: input.adapterSource ?? 'default',
      ...(input.sessionNote ? { sessionNote: input.sessionNote.slice(0, 300) } : {}),
    };
    const interfaceHashes: Partial<Record<ConditionId, string>> = {};
    for (const condition of conditions) interfaceHashes[condition] = interfaces.get(condition)!.hash;

    const run: RunRecord = {
      id,
      mode: input.mode,
      status: 'running',
      createdAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      config,
      taskIds: tasks.map((task) => task.id),
      provenance: {
        appVersion: APP_VERSION,
        taskSetVersion: domain.taskSetVersion,
        interfaceHashes,
        adapterHash: adapter ? hashJson(adapter) : null,
        adapterSource: input.adapterSource ?? 'default',
        evidenceClass: input.mode === 'live' ? 'live-model' : 'scripted-simulation',
        startedBy: options.startedBy ?? 'workbench',
        modelIdentity: null,
        providerReportedCostAvailable: false,
      },
      trials: [],
      summary: computeRunSummary([], conditions, input.mode),
      cancelRequestedAt: null,
      error: null,
    };

    await this.store.saveRun(run);
    const abort = new AbortController();
    const promise = this.execute({ run, domain, tasks, interfaces, modelConfig, adapter, signal: abort.signal }).catch(async (error) => {
      run.status = 'failed';
      run.error = errorMessage(error);
      run.finishedAt = nowIso();
      run.summary = computeRunSummary(run.trials, conditions, input.mode);
      await this.store.saveRun(run).catch(() => undefined);
      this.emit(run);
    });
    this.active.set(run.id, { abort, promise });
    void promise.finally(() => this.active.delete(run.id));
    return run;
  }

  async cancel(runId: string): Promise<RunRecord> {
    const run = this.store.getRun(runId);
    if (!run) throw new AnvilError('run_not_found', `Run ${runId} was not found.`, 404);
    const active = this.active.get(runId);
    if (active) {
      run.cancelRequestedAt = nowIso();
      active.abort.abort();
      await this.store.saveRun(run);
      this.emit(run);
      return run;
    }
    if (run.status === 'running') {
      run.status = 'canceled';
      run.finishedAt = nowIso();
      run.cancelRequestedAt = nowIso();
      run.summary = computeRunSummary(run.trials, run.config.conditions, run.mode);
      await this.store.saveRun(run);
      this.emit(run);
    }
    return run;
  }

  subscribe(runId: string, listener: (run: RunRecord) => void): () => void {
    let set = this.listeners.get(runId);
    if (!set) {
      set = new Set();
      this.listeners.set(runId, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.listeners.delete(runId);
    };
  }

  private emit(run: RunRecord): void {
    const set = this.listeners.get(run.id);
    if (!set) return;
    for (const listener of set) {
      try {
        listener(run);
      } catch {
        // A broken SSE client must not break the experiment.
      }
    }
  }

  private async execute(args: {
    run: RunRecord;
    domain: DomainDefinition;
    tasks: TaskDefinition[];
    interfaces: Map<ConditionId, ConditionInterface>;
    modelConfig: ModelConfig;
    adapter: AdapterSpec | null;
    signal: AbortSignal;
  }): Promise<void> {
    const { run, domain, tasks, interfaces, modelConfig, signal } = args;
    const budget: BudgetState = { underlyingCalls: 0, totalTokens: 0 };
    run.status = 'running';
    run.startedAt = nowIso();
    await this.store.saveRun(run);
    this.emit(run);

    let transport: ModelTransport | null = null;
    if (run.mode === 'live') {
      transport = this.transportFactory(modelConfig, Math.min(run.config.budget.maxWallClockMsPerTrial, 300_000));
    }

    try {
      outer: for (const task of tasks) {
        for (let trialIndex = 1; trialIndex <= run.config.trialsPerTask; trialIndex += 1) {
          for (const condition of run.config.conditions) {
            if (signal.aborted || run.cancelRequestedAt) {
              run.status = 'canceled';
              break outer;
            }
            const iface = interfaces.get(condition);
            if (!iface) throw new Error(`Missing interface for condition ${condition}.`);
            const trial = await this.runTrial({
              run,
              domain,
              task,
              condition,
              trialIndex,
              iface,
              transport,
              signal,
              budget,
            });
            run.trials.push(trial);
            run.summary = computeRunSummary(run.trials, run.config.conditions, run.mode);
            await this.store.saveRun(run);
            this.emit(run);
          }
        }
      }
      if (run.cancelRequestedAt || signal.aborted) run.status = 'canceled';
      else run.status = 'completed';
    } catch (error) {
      run.status = 'failed';
      run.error = errorMessage(error);
    } finally {
      run.finishedAt = nowIso();
      run.summary = computeRunSummary(run.trials, run.config.conditions, run.mode);
      if (run.cancelRequestedAt) {
        run.status = run.status === 'failed' ? 'failed' : 'canceled';
        if (!run.summary.notes.some((note) => note.toLowerCase().includes('cancel'))) {
          run.summary.notes.push('The run was canceled by the operator.');
        }
      }
      const liveTrial = run.trials.find((trial) => trial.mode === 'live');
      run.provenance.modelIdentity = liveTrial
        ? liveTrial.model
        : {
            requested: 'scripted policy (no model called)',
            reported: null,
            provider: 'anvil-scripted',
            baseUrl: 'local://fixture',
            responseId: null,
          };
      run.provenance.providerReportedCostAvailable = run.trials.some((trial) => trial.usage.providerReportedCostUsd !== null);
      await this.store.saveRun(run);
      this.emit(run);
    }
  }

  private async runTrial(args: {
    run: RunRecord;
    domain: DomainDefinition;
    task: TaskDefinition;
    condition: ConditionId;
    trialIndex: number;
    iface: ConditionInterface;
    transport: ModelTransport | null;
    signal: AbortSignal;
    budget: BudgetState;
  }): Promise<TrialRecord> {
    const { run, domain, task, condition, trialIndex, iface, transport, signal, budget } = args;
    const state = deepClone(domain.initialState());
    const initialSnapshot = deepClone(state);
    const startedAt = nowIso();
    const startedMs = Date.now();
    const modelIdentity: TrialRecord['model'] =
      run.mode === 'simulation'
        ? {
            requested: 'scripted policy (no model called)',
            reported: null,
            provider: 'anvil-scripted',
            baseUrl: 'local://fixture',
            responseId: null,
          }
        : {
            requested: run.config.model.model,
            reported: null,
            provider: run.config.model.provider,
            baseUrl: run.config.model.baseUrl,
            responseId: null,
          };
    const notes: string[] = [];
    const turns: TraceTurn[] = [];
    const toolCalls: ToolCallRecord[] = [];
    let finalAnswer = '';
    let status: TrialStatus = 'pass';
    let statusReason: string | null = null;
    let error: TrialBuild['error'] = null;
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let costKnown = 0;
    let hadProviderCost = false;

    const recordInjection = (result: unknown) => {
      const text = JSON.stringify(result) ?? '';
      if (/ignore\s+(all\s+)?(previous|prior)\s+instructions/i.test(text) && !notes.some((note) => note.includes('instruction-like'))) {
        notes.push('A tool output contained instruction-like text; it was returned to the model as data only and never treated as system guidance.');
      }
    };

    if (run.mode === 'simulation') {
      try {
        const sim = this.simulateTrial({ run, domain, task, condition, iface, state, toolCalls, notes, budget, signal });
        finalAnswer = sim.finalAnswer;
        status = sim.status;
        statusReason = sim.reason;
      } catch (caught) {
        status = 'error';
        statusReason = null;
        error = { code: 'simulation_error', message: errorMessage(caught) };
      }
    } else if (transport) {
      const messages: WireMessage[] = [
        { role: 'system', content: buildSystemPrompt(domain.environment) },
        { role: 'user', content: task.prompt },
      ];
      const deadline = startedMs + run.config.budget.maxWallClockMsPerTrial;
      let localUnderlying = 0;
      let stopLoop = false;
      let finishedNaturally = false;
      for (let turnIndex = 1; turnIndex <= run.config.budget.maxTurnsPerTrial; turnIndex += 1) {
        if (signal.aborted || run.cancelRequestedAt) {
          status = 'canceled';
          statusReason = 'Canceled by the operator.';
          stopLoop = true;
          break;
        }
        if (Date.now() > deadline) {
          status = 'error';
          error = { code: 'trial_timeout', message: `The trial exceeded ${run.config.budget.maxWallClockMsPerTrial} ms.` };
          statusReason = 'Trial wall-clock timeout.';
          stopLoop = true;
          break;
        }
        const requestStarted = Date.now();
        let response;
        try {
          response = await transport.complete({ messages, tools: iface.tools, signal });
        } catch (caught) {
          if (signal.aborted || run.cancelRequestedAt) {
            status = 'canceled';
            statusReason = 'Canceled by the operator.';
          } else if (caught instanceof ModelTransportError && caught.code === 'timeout') {
            status = 'error';
            error = { code: 'trial_timeout', message: caught.message };
            statusReason = 'Provider timeout.';
          } else if (Date.now() > deadline) {
            status = 'error';
            error = { code: 'trial_timeout', message: 'The trial exceeded its wall-clock limit.' };
            statusReason = 'Trial wall-clock timeout.';
          } else {
            status = 'error';
            error = {
              code: caught instanceof ModelTransportError ? caught.code : 'provider_error',
              message: errorMessage(caught),
              detail: caught instanceof ModelTransportError ? caught.detail : null,
            };
            statusReason = 'The model call failed.';
          }
          stopLoop = true;
          break;
        }
        const latencyMs = Date.now() - requestStarted;
        if (response.reportedModel) modelIdentity.reported = response.reportedModel;
        if (response.responseId) modelIdentity.responseId = response.responseId;
        if (response.usage.promptTokens !== null) promptTokens += response.usage.promptTokens;
        if (response.usage.completionTokens !== null) completionTokens += response.usage.completionTokens;
        if (response.usage.totalTokens !== null) {
          totalTokens += response.usage.totalTokens;
          budget.totalTokens += response.usage.totalTokens;
        }
        if (response.usage.providerReportedCostUsd !== null) {
          hadProviderCost = true;
          costKnown += response.usage.providerReportedCostUsd;
        }
        turns.push({
          turn: turnIndex,
          startedAt: new Date(requestStarted).toISOString(),
          latencyMs,
          finishReason: response.finishReason,
          content: response.content,
          toolCalls: response.toolCalls,
          usage: response.usage,
          requestSummary: {
            messageCount: messages.length,
            toolCount: iface.tools.length,
            model: run.config.model.model,
            condition,
          },
          ...(response.warnings.length > 0 ? { notes: response.warnings } : {}),
        });
        if (response.warnings.length > 0 && notes.length < 20) {
          notes.push(...response.warnings.filter((warning) => !notes.includes(warning)));
        }
        if (budget.totalTokens > run.config.budget.maxTotalTokens) {
          status = 'invalid';
          statusReason = `Run token budget exhausted (${budget.totalTokens} > ${run.config.budget.maxTotalTokens}).`;
          finalAnswer = response.content;
          stopLoop = true;
          break;
        }
        const calls = response.toolCalls;
        messages.push({
          role: 'assistant',
          content: response.content,
          ...(calls.length > 0
            ? {
                tool_calls: calls.map((call) => ({
                  id: call.id,
                  type: 'function' as const,
                  function: { name: call.name, arguments: call.argumentsRaw },
                })),
              }
            : {}),
        });
        if (response.content.trim().length > 0) finalAnswer = response.content;

        if (calls.length === 0) {
          finishedNaturally = true;
          if (response.content.trim().length === 0) {
            status = 'invalid';
            statusReason = 'The model returned an empty final message with no tool calls.';
          }
          break;
        }

        for (const call of calls) {
          if (signal.aborted || run.cancelRequestedAt) {
            status = 'canceled';
            statusReason = 'Canceled by the operator.';
            stopLoop = true;
            break;
          }
          const knownTool = Boolean(iface.publicTool(call.name));
          // Reserve the worst case before executing: a v2 lookup tool may make two original calls.
          const reserve = knownTool ? maxUnderlyingCallsFor(iface, call.name) : 0;
          if (knownTool && (localUnderlying + reserve > run.config.budget.maxUnderlyingToolCallsPerTrial || budget.underlyingCalls + reserve > run.config.budget.maxUnderlyingToolCallsTotal)) {
            status = 'invalid';
            statusReason = `Underlying tool-call budget exhausted before calling ${call.name}.`;
            stopLoop = true;
            break;
          }
          let proposed: unknown = call.argumentsRaw;
          let parsedArgs: Record<string, unknown> | null = null;
          let parseError: string | null = null;
          try {
            const parsed = JSON.parse(call.argumentsRaw.length > 0 ? call.argumentsRaw : '{}') as unknown;
            if (!isPlainObject(parsed)) throw new Error('tool arguments must be a JSON object');
            parsedArgs = parsed;
            proposed = parsed;
          } catch (caught) {
            parseError = errorMessage(caught);
          }
          const callStarted = nowIso();
          const callStartedMs = Date.now();
          let record: ToolCallRecord;
          if (parseError || !parsedArgs) {
            record = {
              index: toolCalls.length,
              turn: turnIndex,
              publicTool: call.name,
              proposedInput: proposed,
              adaptedCompilation: null,
              validation: { ok: false, errors: [parseError ?? 'arguments were not an object'] },
              result: {
                ok: false,
                error: { code: 'malformed_tool_arguments', message: `Tool arguments were not valid JSON: ${parseError ?? 'not an object'}` },
              },
              startedAt: callStarted,
              durationMs: Date.now() - callStartedMs,
              countedUnderlying: knownTool,
              source: 'model',
            };
            notes.push(`Model emitted malformed arguments for ${call.name}; the model received a tool error.`);
          } else {
            const execution = executeConditionTool({
              iface,
              domain,
              state,
              toolName: call.name,
              args: parsedArgs,
              now: (state as { now?: string }).now ?? new Date().toISOString(),
              trialId: run.id,
            });
            record = {
              index: toolCalls.length,
              turn: turnIndex,
              publicTool: call.name,
              proposedInput: proposed,
              adaptedCompilation: execution.compilation
                ? {
                    target: execution.compilation.target,
                    input: execution.compilation.input,
                    transformNotes: execution.compilation.notes,
                  }
                : null,
              adaptedLookup: execution.lookup,
              validation: execution.validation,
              result: execution.result,
              startedAt: callStarted,
              durationMs: Date.now() - callStartedMs,
              countedUnderlying: execution.countedUnderlying,
              underlyingCalls: execution.underlyingCalls,
              source: 'model',
            };
            recordInjection(execution.result);
          }
          toolCalls.push(record);
          const spent = record.underlyingCalls ?? (record.countedUnderlying ? 1 : 0);
          localUnderlying += spent;
          budget.underlyingCalls += spent;
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: truncate(
              JSON.stringify(record.result.ok ? record.result.content : { error: record.result.error }),
              12_000,
            ),
          });
        }
        if (stopLoop) break;
      }
      if (!stopLoop && !finishedNaturally && status === 'pass') {
        status = 'invalid';
        statusReason = `The model did not finish within ${run.config.budget.maxTurnsPerTrial} turns.`;
      }
    } else {
      status = 'error';
      error = { code: 'no_transport', message: 'No model transport was configured for a live run.' };
    }

    let diff: StateDiff;
    try {
      diff = domain.diff(initialSnapshot, state);
    } catch (caught) {
      diff = { domain: domain.id, changes: [], unchangedCount: 0, summary: `Diff failed: ${errorMessage(caught)}` };
      if (!error) {
        error = { code: 'diff_error', message: errorMessage(caught) };
        status = 'error';
      }
    }
    let checks: CheckResult[] = [];
    try {
      checks = task.validate(initialSnapshot, deepClone(state), finalAnswer);
    } catch (caught) {
      checks = [
        {
          id: 'validator-error',
          label: 'Independent validator failed to run',
          ok: false,
          detail: errorMessage(caught),
          kind: 'hygiene',
        },
      ];
      status = 'error';
      error = { code: 'validator_error', message: errorMessage(caught) };
    }
    if (status === 'pass') {
      const verdict = statusFromChecks(checks);
      status = verdict.status;
      statusReason = verdict.reason;
    }

    const usage = {
      promptTokens: promptTokens > 0 ? promptTokens : null,
      completionTokens: completionTokens > 0 ? completionTokens : null,
      totalTokens: totalTokens > 0 ? totalTokens : null,
      underlyingToolCalls: toolCalls.reduce((sum, call) => sum + (call.underlyingCalls ?? (call.countedUnderlying ? 1 : 0)), 0),
      providerReportedCostUsd: hadProviderCost ? costKnown : null,
    };

    return {
      id: `trial_${randomUUID().slice(0, 12)}`,
      runId: run.id,
      taskId: task.id,
      taskTitle: task.title,
      family: task.family,
      domain: domain.id,
      condition,
      trial: trialIndex,
      mode: run.mode,
      status,
      statusReason,
      startedAt,
      finishedAt: nowIso(),
      durationMs: Date.now() - startedMs,
      model: modelIdentity,
      interfaceHash: iface.hash,
      adapterHash: iface.adapter ? hashJson(iface.adapter) : null,
      usage,
      turns,
      toolCalls,
      initialState: initialSnapshot,
      finalState: deepClone(state),
      stateDiff: diff,
      checks,
      finalAnswer,
      error,
      notes,
      evidenceClass: run.mode === 'live' ? 'live-model' : 'scripted-simulation',
    };
  }

  private simulateTrial(args: {
    run: RunRecord;
    domain: DomainDefinition;
    task: TaskDefinition;
    condition: ConditionId;
    iface: ConditionInterface;
    state: unknown;
    toolCalls: ToolCallRecord[];
    notes: string[];
    budget: BudgetState;
    signal: AbortSignal;
  }): { finalAnswer: string; status: TrialStatus; reason: string | null } {
    const { run, domain, task, condition, iface, state, toolCalls, notes, budget, signal } = args;
    const memory: Record<string, unknown> = {};
    let localUnderlying = 0;
    let finalAnswer = '';
    let status: TrialStatus = 'pass';
    let reason: string | null = null;
    const maxSteps = task.simulation.length + 2;
    let halted = false;

    for (let stepIndex = 0; stepIndex < maxSteps; stepIndex += 1) {
      if (signal.aborted || run.cancelRequestedAt) {
        status = 'canceled';
        reason = 'Canceled by the operator.';
        break;
      }
      const lastCall = toolCalls.at(-1);
      if (lastCall && !lastCall.result.ok) {
        halted = true;
        notes.push(`The scripted policy halted after a tool error: ${lastCall.result.error?.message ?? 'unknown error'}`);
        finalAnswer = `Scripted policy halted after a tool error: ${lastCall.result.error?.message ?? 'unknown error'}`;
        break;
      }
      const step = task.simulation[stepIndex];
      if (!step) {
        status = 'invalid';
        reason = 'The scripted policy ran out of steps before answering.';
        break;
      }
      const action = domain.simulate(step, { state, memory, toolCalls: toolCalls.map((call) => ({ tool: call.publicTool, args: call.proposedInput as Record<string, unknown>, result: call.result })), stepIndex, condition });
      if (action.tool) {
        const known = Boolean(iface.publicTool(action.tool));
        const reserve = known ? maxUnderlyingCallsFor(iface, action.tool) : 0;
        if (
          known &&
          (localUnderlying + reserve > run.config.budget.maxUnderlyingToolCallsPerTrial ||
            budget.underlyingCalls + reserve > run.config.budget.maxUnderlyingToolCallsTotal)
        ) {
          status = 'invalid';
          reason = 'Underlying tool-call budget exhausted during the scripted rehearsal.';
          break;
        }
        const callStarted = nowIso();
        const callStartedMs = Date.now();
        const execution = executeConditionTool({
          iface,
          domain,
          state,
          toolName: action.tool,
          args: action.args ?? {},
          now: (state as { now?: string }).now ?? new Date().toISOString(),
          trialId: run.id,
        });
        toolCalls.push({
          index: toolCalls.length,
          turn: stepIndex + 1,
          publicTool: action.tool,
          proposedInput: action.args ?? {},
          adaptedCompilation: execution.compilation
            ? { target: execution.compilation.target, input: execution.compilation.input, transformNotes: execution.compilation.notes }
            : null,
          adaptedLookup: execution.lookup,
          validation: execution.validation,
          result: execution.result,
          startedAt: callStarted,
          durationMs: Date.now() - callStartedMs,
          countedUnderlying: execution.countedUnderlying,
          underlyingCalls: execution.underlyingCalls,
          source: 'simulation',
        });
        localUnderlying += execution.underlyingCalls;
        budget.underlyingCalls += execution.underlyingCalls;
        const text = JSON.stringify(execution.result);
        if (/ignore\s+(all\s+)?(previous|prior)\s+instructions/i.test(text ?? '') && !notes.some((note) => note.includes('instruction-like'))) {
          notes.push('A tool output contained instruction-like text; the scripted policy ignored it and treated it as data.');
        }
        if (!known) {
          notes.push(`The scripted policy requested unknown tool "${action.tool}".`);
        }
        continue;
      }
      if (action.answer !== undefined) {
        finalAnswer = action.answer;
        break;
      }
      status = 'invalid';
      reason = 'The scripted policy produced neither a tool call nor an answer.';
      break;
    }
    if (halted) status = 'fail';
    if (status === 'pass' && finalAnswer.trim().length === 0) {
      status = 'invalid';
      reason = 'The scripted policy ended without a final answer.';
    }
    return { finalAnswer, status, reason };
  }
}

export function plannedAttempts(input: Pick<StartExperimentInput, 'trialsPerTask' | 'taskIds' | 'conditions'>, taskCount: number): {
  trials: number;
  maxUnderlyingToolCalls: number;
  maxTurns: number;
} {
  const trials = Math.max(1, taskCount) * (input.conditions?.length ?? 3) * (input.trialsPerTask ?? 1);
  return {
    trials,
    maxUnderlyingToolCalls: trials * (DEFAULT_BUDGET.maxUnderlyingToolCallsPerTrial),
    maxTurns: trials * DEFAULT_BUDGET.maxTurnsPerTrial,
  };
}