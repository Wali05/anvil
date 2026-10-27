import { resolve } from 'node:path';
import type { AdapterSpec, ConditionId, RunRecord } from '../core/types.js';
import { CONDITIONS } from '../core/types.js';
import { Store } from '../core/store.js';
import { ExperimentRunner, DEFAULT_MODEL, plannedAttempts, normalizeBudget, type StartExperimentInput } from '../core/runner.js';
import { ModelConfigManager } from '../server/modelConfig.js';
import { domainList, requireDomain } from '../domains/index.js';
import { getDefaultAdapter } from '../domains/adapters.js';
import { buildConditionInterface, rawToolSchemaMap, readOnlyToolNames } from '../core/interfaces.js';
import { previewAdapterCall, parseAdapterSpec, validateAdapter } from '../core/adapter.js';
import { validateAgainstSchema } from '../core/schema.js';
import { hashJson } from '../core/util.js';
import { AnvilError } from '../core/errors.js';
import { adapterBundle } from './export.js';
import { APP_VERSION } from '../core/version.js';
import { loadProjectEnv } from '../core/env.js';
import { objectSchema, serveStdioMcp, type McpTool } from './common.js';

export async function runWorkbenchMcp(): Promise<void> {
  loadProjectEnv();
const dataDir = resolve(process.env.ANVIL_DATA_DIR ?? '.anvil');
const store = new Store(dataDir);
await store.init();
const runner = new ExperimentRunner({ store });
const models = new ModelConfigManager();
models.applyEnvironment(process.env);

async function currentAdapter(domain: string): Promise<{ spec: AdapterSpec; source: 'default' | 'saved' }> {
  const saved = await store.getSavedAdapter(domain);
  if (saved) return { spec: saved.spec, source: 'saved' };
  const fallback = getDefaultAdapter(domain);
  if (!fallback) throw new AnvilError('adapter_missing', `No adapter exists for ${domain}.`);
  return { spec: fallback, source: 'default' };
}

function compactRun(run: RunRecord) {
  return {
    id: run.id,
    mode: run.mode,
    status: run.status,
    evidenceClass: run.provenance.evidenceClass,
    domain: run.config.domain,
    split: run.config.split,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
    model: run.provenance.modelIdentity,
    summary: run.summary,
    trials: run.trials.map((trial) => ({
      id: trial.id,
      taskId: trial.taskId,
      condition: trial.condition,
      status: trial.status,
      statusReason: trial.statusReason,
      checks: trial.checks.map((check) => ({ id: check.id, ok: check.ok, label: check.label })),
      toolCalls: trial.toolCalls.length,
      finalAnswer: trial.finalAnswer.length > 500 ? `${trial.finalAnswer.slice(0, 500)}…` : trial.finalAnswer,
    })),
  };
}

const tools: McpTool[] = [
  {
    name: 'anvil_list_domains',
    title: 'List Anvil fixture domains',
    description: 'List the local fixture domains, task counts and split families available to Anvil. No model is called.',
    inputSchema: objectSchema({}),
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler() {
      return {
        domains: domainList.map((domain) => ({
          id: domain.id,
          name: domain.name,
          description: domain.description,
          taskSetVersion: domain.taskSetVersion,
          tools: domain.tools.map((tool) => tool.name),
          tasks: {
            dev: domain.tasks.filter((task) => task.split === 'dev').length,
            eval: domain.tasks.filter((task) => task.split === 'eval').length,
            eval2: domain.tasks.filter((task) => task.split === 'eval2').length,
          },
          families: [...new Set(domain.tasks.map((task) => task.family))],
        })),
        note: 'All state is a disposable local fixture. No external calendar or issue tracker is touched.',
      };
    },
  },
  {
    name: 'anvil_list_interfaces',
    title: 'Inspect raw, described and adapted interfaces',
    description:
      'Return the exact tool catalog for a domain in the original, descriptions-only and adapted conditions, including hashes and adapter limits.',
    inputSchema: objectSchema(
      {
        domain: { type: 'string', enum: ['calendar', 'issues'] },
        includeSchemas: { type: 'boolean', description: 'Include full input JSON Schemas.' },
      },
      ['domain'],
    ),
    annotations: { readOnlyHint: true, openWorldHint: false },
    async handler(args) {
      const domain = requireDomain(String(args.domain));
      const adapter = (await currentAdapter(domain.id)).spec;
      return {
        domain: domain.id,
        taskSetVersion: domain.taskSetVersion,
        conditions: CONDITIONS.map((condition: ConditionId) => {
          const iface = buildConditionInterface(domain, condition, condition === 'adapted' ? adapter : null);
          return {
            condition,
            interfaceHash: iface.hash,
            toolCount: iface.tools.length,
            tools: iface.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              hash: hashJson({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }),
              ...(args.includeSchemas ? { inputSchema: tool.inputSchema, outputDescription: tool.outputDescription } : {}),
              ...(condition === 'adapted' ? { target: adapter.tools.find((entry) => entry.name === tool.name)?.target } : {}),
            })),
          };
        }),
        adapter: {
          version: adapter.version,
          hash: hashJson(adapter),
          limits: adapter.limits,
          notes: 'One public call compiles to exactly one original call; outputs are not remapped.',
        },
        environment: domain.environment,
      };
    },
  },
  {
    name: 'anvil_validate_adapter',
    title: 'Validate an adapter specification',
    description:
      'Validate an anvil.adapter/v1 or v2 object against a domain (v2 adds one exact-match read-only lookup): names, target references, paths, required fields, transforms, schema safety and compiled sample calls. Does not save or run it.',
    inputSchema: objectSchema(
      {
        domain: { type: 'string', enum: ['calendar', 'issues'] },
        adapter: { type: 'object', description: 'The adapter specification to validate.' },
      },
      ['domain', 'adapter'],
    ),
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler(args) {
      const domain = requireDomain(String(args.domain));
      const parsed = parseAdapterSpec(args.adapter);
      if (!parsed.ok || !parsed.spec) {
        return { ok: false, parseIssues: parsed.issues };
      }
      const validation = validateAdapter(parsed.spec, {
        toolSchemas: rawToolSchemaMap(domain),
        rawToolNames: domain.tools.map((tool) => tool.name),
        readOnlyTools: readOnlyToolNames(domain),
      });
      return {
        ok: validation.ok,
        issues: validation.issues,
        toolCount: validation.toolCount,
        targets: validation.targets,
        adapterHash: validation.interfaceHash,
        note: validation.ok ? 'Valid. Nothing was saved or executed.' : 'The adapter cannot be used until all error issues are fixed.',
      };
    },
  },
  {
    name: 'anvil_preview_mapping',
    title: 'Preview an adapted call mapping',
    description:
      'Compile one adapted tool call into its original tool call without executing it. Returns the original call and any validation errors.',
    inputSchema: objectSchema(
      {
        domain: { type: 'string', enum: ['calendar', 'issues'] },
        tool: { type: 'string', description: 'Adapted public tool name.' },
        args: { type: 'object', description: 'Adapted arguments to compile.' },
        adapter: { type: 'object', description: 'Optional adapter; defaults to the saved or built-in adapter.' },
      },
      ['domain', 'tool', 'args'],
    ),
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (args) => {
      const domain = requireDomain(String(args.domain));
      let spec: AdapterSpec;
      if (args.adapter) {
        const parsed = parseAdapterSpec(args.adapter);
        if (!parsed.ok || !parsed.spec) throw new AnvilError('adapter_invalid', 'The supplied adapter is invalid.', 400, parsed.issues);
        spec = parsed.spec;
      } else {
        spec = (await currentAdapter(domain.id)).spec;
      }
      const adapted = spec.tools.find((tool) => tool.name === String(args.tool));
      if (!adapted) throw new AnvilError('tool_not_found', `Adapter has no tool "${String(args.tool)}".`);
      const inputValidation = validateAgainstSchema(adapted.inputSchema, args.args);
      if (!inputValidation.ok) return { ok: false, errors: inputValidation.errors };
      const preview = previewAdapterCall(adapted, args.args as Record<string, unknown>, rawToolSchemaMap(domain));
      return {
        ok: preview.ok,
        lookupCall: preview.lookupCall,
        originalCall: preview.originalCall,
        notes: preview.notes,
        errors: preview.errors,
        executed: false,
      };
    },
  },
  {
    name: 'anvil_list_experiments',
    title: 'List saved Anvil experiments',
    description: 'List persisted experiments with evidence class, model identity, attempt counts and per-condition summary. Simulation runs are not live evidence.',
    inputSchema: objectSchema({
      limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum runs to return (default 20).' },
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler(args) {
      const limit = typeof args.limit === 'number' ? args.limit : 20;
      return { runs: store.listRuns().slice(0, limit) };
    },
  },
  {
    name: 'anvil_get_experiment',
    title: 'Read one experiment',
    description:
      'Read a persisted experiment: condition counts, paired task outcomes, and every trial status with independent checks. Set includeFull=true for transcripts and states.',
    inputSchema: objectSchema(
      {
        runId: { type: 'string' },
        includeFull: { type: 'boolean', description: 'Include turns, tool calls and fixture states.' },
      },
      ['runId'],
    ),
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler(args) {
      const run = store.getRun(String(args.runId));
      if (!run) throw new AnvilError('run_not_found', `No run ${String(args.runId)}.`, 404);
      return args.includeFull ? run : compactRun(run);
    },
  },
  {
    name: 'anvil_start_experiment',
    title: 'Start a bounded Anvil experiment',
    description:
      'Start an explicit experiment. Simulation is a labelled scripted rehearsal. Live mode calls the configured open model and requires allowLive=true plus ANVIL_MODEL_* environment configuration. Runs asynchronously; poll anvil_get_experiment. Limited to 8 tasks and 2 trials per task.',
    inputSchema: objectSchema(
      {
        domain: { type: 'string', enum: ['calendar', 'issues'] },
        split: { type: 'string', enum: ['dev', 'eval', 'eval2'], description: 'dev = iteration; eval = eval v1 (seen); eval2 = fresh sealed set.' },
        mode: { type: 'string', enum: ['simulation', 'live'] },
        trialsPerTask: { type: 'integer', minimum: 1, maximum: 2 },
        taskIds: { type: 'array', items: { type: 'string' }, maxItems: 8 },
        conditions: { type: 'array', items: { type: 'string', enum: ['original', 'descriptions', 'adapted'] } },
        maxUnderlyingToolCallsTotal: { type: 'integer', minimum: 1, maximum: 300 },
        allowLive: { type: 'boolean', description: 'Must be true to permit a live model run.' },
        sessionNote: { type: 'string', maxLength: 300 },
      },
      ['domain', 'split', 'mode'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async handler(args) {
      const mode = args.mode === 'live' ? 'live' : 'simulation';
      if (mode === 'live' && args.allowLive !== true) {
        throw new AnvilError('live_not_allowed', 'Live runs require allowLive=true; they spend model tokens.');
      }
      if (mode === 'live' && !models.isConfigured()) {
        throw new AnvilError(
          'model_not_configured',
          'No live model is configured. Set ANVIL_MODEL_PROVIDER, ANVIL_MODEL_BASE_URL, ANVIL_MODEL and optionally ANVIL_MODEL_API_KEY for this MCP server.',
        );
      }
      const taskIds = Array.isArray(args.taskIds) ? (args.taskIds as string[]) : undefined;
      if (taskIds && taskIds.length > 8) throw new AnvilError('too_many_tasks', 'At most 8 tasks per MCP experiment.');
      const conditions = Array.isArray(args.conditions) ? (args.conditions as ConditionId[]) : undefined;
      if (conditions && !conditions.includes('adapted')) {
        throw new AnvilError('missing_adapted', 'MCP experiments must include the adapted condition.');
      }
      const modelConfig = mode === 'live' ? models.requireConfigured() : { ...DEFAULT_MODEL };
      const input: StartExperimentInput = {
        mode,
        domain: String(args.domain),
        split: args.split === 'eval' || args.split === 'eval2' ? args.split : 'dev',
        trialsPerTask: args.trialsPerTask === 2 ? 2 : 1,
        ...(taskIds ? { taskIds } : {}),
        ...(conditions ? { conditions } : {}),
        budget: {
          maxUnderlyingToolCallsTotal: typeof args.maxUnderlyingToolCallsTotal === 'number' ? args.maxUnderlyingToolCallsTotal : 120,
        },
        ...(typeof args.sessionNote === 'string' ? { sessionNote: args.sessionNote } : {}),
      };
      const domain = requireDomain(input.domain);
      const taskCount = taskIds?.length ?? domain.tasks.filter((task) => task.split === input.split).length;
      const budget = normalizeBudget(input.budget, taskCount * (conditions?.length ?? 3) * (input.trialsPerTask ?? 1));
      const run = await runner.start(input, modelConfig, { startedBy: 'mcp' });
      return {
        runId: run.id,
        status: run.status,
        mode: run.mode,
        evidenceClass: run.provenance.evidenceClass,
        plannedAttempts: plannedAttempts(input, taskCount),
        budget,
        pollWith: 'anvil_get_experiment',
        notice:
          mode === 'simulation'
            ? 'Labelled scripted rehearsal. No model was called; results are excluded from live evidence.'
            : `Live run against ${modelConfig.model} at ${modelConfig.baseUrl}. Tokens may be spent.`,
      };
    },
  },
  {
    name: 'anvil_export_adapter',
    title: 'Export a runnable adapter bundle',
    description:
      'Return an anvil.adapter-bundle/v1 object containing the adapter, interface hashes, declared limits, MCP config and optional run evidence. This does not publish or deploy anything.',
    inputSchema: objectSchema(
      {
        domain: { type: 'string', enum: ['calendar', 'issues'] },
        source: { type: 'string', enum: ['saved', 'default'] },
        runId: { type: 'string', description: 'Optional run whose evidence is included.' },
      },
      ['domain'],
    ),
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async (args) => {
      const domain = requireDomain(String(args.domain));
      let spec: AdapterSpec;
      let source: 'saved' | 'default';
      if (args.source === 'default') {
        const fallback = getDefaultAdapter(domain.id);
        if (!fallback) throw new AnvilError('adapter_missing', `No default adapter for ${domain.id}.`);
        spec = fallback;
        source = 'default';
      } else {
        const current = await currentAdapter(domain.id);
        spec = current.spec;
        source = current.source;
      }
      const run = typeof args.runId === 'string' ? store.getRun(args.runId) ?? null : null;
      if (args.runId && !run) throw new AnvilError('run_not_found', `No run ${String(args.runId)}.`, 404);
      return adapterBundle({ spec, adapterSource: source, rootDir: resolve('.'), run });
    },
  },
];

await serveStdioMcp({
  name: 'anvil-workbench',
  version: APP_VERSION,
  instructions:
    'Anvil is a local tool-interface workbench. Simulation runs are labelled rehearsals and never model evidence. Live runs require explicit allowLive and environment-configured open-model credentials. Nothing is pushed or deployed.',
  tools,
});
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && /workbench\.(js|ts)$/.test(process.argv[1].replace(/\\/g, '/'));
if (invokedDirectly) {
  await runWorkbenchMcp();
}
