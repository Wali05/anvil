export type ConditionId = 'original' | 'descriptions' | 'adapted';
/**
 * dev: adapter iteration. eval: the first held-out set, inspected after the
 * 26 Oct pilot and therefore labelled "eval v1 (seen)". eval2: a fresh sealed
 * set written before any run on it; never tuned against.
 */
export type Split = 'dev' | 'eval' | 'eval2';
export type RunMode = 'live' | 'simulation';
export type TrialStatus = 'pass' | 'fail' | 'invalid' | 'error' | 'canceled';
export type RunStatus = 'running' | 'completed' | 'canceled' | 'interrupted' | 'failed';

export const CONDITIONS: ConditionId[] = ['original', 'descriptions', 'adapted'];

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * The subset of JSON Schema Anvil authors and validates itself. `additionalProperties`
 * is always an explicit boolean so compiled calls cannot silently smuggle fields.
 */
export interface JsonSchema {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
  description?: string;
}

export type JsonSchemaProperty =
  | {
      type: 'string';
      description?: string;
      enum?: string[];
      format?: string;
      minLength?: number;
      maxLength?: number;
      pattern?: string;
    }
  | {
      type: 'integer' | 'number';
      description?: string;
      minimum?: number;
      maximum?: number;
      enum?: number[];
    }
  | { type: 'boolean'; description?: string }
  | {
      type: 'array';
      description?: string;
      items: JsonSchemaProperty;
      minItems?: number;
      maxItems?: number;
    }
  | { type: 'object'; description?: string; properties: Record<string, JsonSchemaProperty>; required?: string[]; additionalProperties?: boolean };

export interface ToolPermission {
  /** Human-readable scope, e.g. "calendar.events:write". */
  scope: string;
  /** Whether the tool mutates fixture state. */
  write: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputDescription: string;
  permissions: ToolPermission[];
  annotations: { readOnlyHint: boolean; destructiveHint: boolean };
}

export interface ToolExecResult {
  ok: boolean;
  content?: unknown;
  error?: { code: string; message: string; details?: unknown };
}

export interface ToolCallContext {
  /** Deterministic fixture clock, never wall-clock, so trials are reproducible. */
  now: string;
  /** Set to the trial id by the runner; adapters cannot read it. */
  trialId?: string;
  /** Set to the condition; available to the executor for logging only. */
  condition?: ConditionId;
  /** Underlying-call counter the executor can read, never write. */
  underlyingCalls?: number;
}

export interface DomainTool extends ToolDefinition {
  execute(state: unknown, args: Record<string, unknown>, ctx: ToolCallContext): ToolExecResult;
}

export interface CheckResult {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  kind: 'intent' | 'preservation' | 'contract' | 'hygiene';
}

export interface OutputContract {
  description: string;
  /** Example included in the task prompt so the format is explicit. */
  example: string;
  parse(finalAnswer: string): { ok: true; value: unknown } | { ok: false; reason: string };
}

export interface SimulationStep {
  intent: string;
  params?: Record<string, unknown>;
}

export interface TaskDefinition {
  id: string;
  domain: string;
  family: string;
  split: Split;
  title: string;
  /** The entire user instruction. It must not contain answers or validator hints. */
  prompt: string;
  outputContract?: OutputContract;
  /** Independent state checks. Receives initial/final fixture state and the final answer. */
  validate(initial: unknown, final: unknown, finalAnswer: string): CheckResult[];
  /** Deterministic scripted plan used only by the clearly labelled simulation mode. */
  simulation: SimulationStep[];
  notes?: string;
}

export interface DomainDefinition {
  id: string;
  name: string;
  shortName: string;
  description: string;
  /** Interface constants (ids, timezone, repos) shown identically in every condition. */
  environment: string;
  taskSetVersion: string;
  initialState(): unknown;
  tools: DomainTool[];
  tasks: TaskDefinition[];
  diff(initial: unknown, final: unknown): StateDiff;
  describeToolField(toolName: string, fieldPath: string): string | undefined;
  /** Domain-specific formatter used by the labelled scripted transport. */
  simulate(step: SimulationStep, context: SimulationContext): SimulatedAction;
}

export interface SimulatedAction {
  /** Name of the public tool in the current condition, if a call is required. */
  tool?: string;
  args?: Record<string, unknown>;
  /** Final assistant text, if the scripted policy answers now. */
  answer?: string;
  /** Simulator bookkeeping (e.g. matched entity ids from a previous result). */
  memory?: Record<string, unknown>;
}

export interface SimulationContext {
  state: unknown;
  memory: Record<string, unknown>;
  toolCalls: Array<{ tool: string; args: Record<string, unknown>; result: ToolExecResult }>;
  stepIndex: number;
  condition: ConditionId;
}

export interface StateChange {
  entity: string;
  kind: 'added' | 'removed' | 'changed';
  fields: Array<{ field: string; before: unknown; after: unknown }>;
}

export interface StateDiff {
  domain: string;
  changes: StateChange[];
  unchangedCount: number;
  summary: string;
}

/* -------------------------------------------------------------------------- */
/* Adapter specification                                                       */
/* -------------------------------------------------------------------------- */

export type AdapterTransform =
  | { kind: 'identity' }
  | { kind: 'isoDateTime'; assumeOffset: string }
  /** Local date YYYY-MM-DD → start of that day as an ISO date-time with offset. */
  | { kind: 'dayStart'; assumeOffset: string }
  /** Local date YYYY-MM-DD → start of the next day (exclusive bound) with offset. */
  | { kind: 'dayEnd'; assumeOffset: string }
  /**
   * v2, lookup tools only: new local start + the matched record's own duration
   * (itemEnd - itemStart) → new end date-time. `from` is the new start input.
   */
  | { kind: 'keepDurationEnd'; itemStart: string; itemEnd: string; assumeOffset: string }
  | {
      kind: 'durationEnd';
      /** Adapted-input path holding the local start date-time. */
      startField: string;
      /** Adapted-input path holding the duration in minutes. */
      durationField: string;
      assumeOffset: string;
    }
  | { kind: 'wrapEmail' }
  | { kind: 'unwrapEmail' }
  | {
      kind: 'issueQuery';
      parts: Array<{
        literal?: string;
        input?: string;
        prefix?: string;
        valueMap?: Record<string, string>;
      }>;
    };

export interface AdapterArgMapping {
  /** Dot path into the original tool input, e.g. `event.start.dateTime`. */
  to: string;
  /** Dot path into the adapted tool input. Mutually exclusive with `const`. */
  from?: string;
  const?: JsonValue;
  /** Applied after reading `from`. */
  transform?: AdapterTransform;
  /** Enum translation for a scalar string input. */
  valueMap?: Record<string, string>;
  /** Explicit fallback for an absent input. */
  default?: JsonValue;
  /** Fail the call if the adapted input did not supply a value. */
  required?: boolean;
}

/**
 * anvil.adapter/v2 only. Resolve the target record with exactly one read-only
 * original call before the single original write call. Zero or several matches
 * stop the invocation with no write and return the candidates to the model.
 */
export interface AdapterLookupSpec {
  /** Original read-only tool used to find the target record. */
  tool: string;
  /** Mappings from adapted input into the lookup tool's input. */
  arguments: AdapterArgMapping[];
  /** Dot path to the result array in the lookup tool's output, e.g. `items`. */
  resultsPath: string;
  /**
   * Exact equality filters (trimmed, case-insensitive) applied to each returned item.
   * `localTime` compares an adapted "HH:MM" input with the HH:MM of an item's
   * ISO date-time as written (its own offset). A rule on an optional input is
   * skipped when that input is absent; at least one rule must use a required input.
   */
  match: Array<{ field: string; from: string; compare?: 'exact' | 'localTime' }>;
  /** Dot path to the id inside the matched item. */
  idField: string;
  /** Target input path that receives the matched id. */
  bindTo: string;
  /** Item fields shown to the model when zero or several items match. */
  display: string[];
}

export interface AdaptedToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** Exactly one original write/read tool executed per invocation. */
  target: string;
  arguments: AdapterArgMapping[];
  /** v2 only: one read-only lookup call before the target call. */
  lookup?: AdapterLookupSpec;
  notes?: string;
}

export interface AdapterSpec {
  schema: 'anvil.adapter/v1' | 'anvil.adapter/v2';
  domain: string;
  version: string;
  description: string;
  limits: {
    /** v1: always true. v2: false when any tool declares a lookup. */
    oneToOne: boolean;
    maxTools: number;
    /** v1: 1. v2: 2 when any tool declares a lookup (one read + one target call). */
    maxUnderlyingCallsPerInvocation: 1 | 2;
  };
  tools: AdaptedToolSpec[];
}

export interface AdapterIssue {
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface AdapterValidation {
  ok: boolean;
  issues: AdapterIssue[];
  toolCount: number;
  targets: Record<string, number>;
  interfaceHash: string;
}

/* -------------------------------------------------------------------------- */
/* Experiment configuration and records                                        */
/* -------------------------------------------------------------------------- */

export interface ModelConfig {
  provider: 'ollama' | 'openai-compatible';
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokensPerCompletion: number;
  /** Never persisted. Held by the server process only. */
  apiKey?: string;
}

export interface BudgetConfig {
  maxTurnsPerTrial: number;
  maxUnderlyingToolCallsPerTrial: number;
  maxUnderlyingToolCallsTotal: number;
  maxTotalTokens: number;
  maxWallClockMsPerTrial: number;
  /** Policy is fixed and inspectable: every attempted underlying call counts. */
  countPolicy: 'count-all-attempts';
}

export interface RunConfig {
  mode: RunMode;
  domain: string;
  split: Split;
  taskIds: string[];
  conditions: ConditionId[];
  trialsPerTask: number;
  model: Omit<ModelConfig, 'apiKey'>;
  budget: BudgetConfig;
  adapterSource: 'default' | 'saved';
  sessionNote?: string;
}

export interface UsageRecord {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  underlyingToolCalls: number;
  /** Provider-reported cost only. Unknown stays null. */
  providerReportedCostUsd: number | null;
}

export interface TraceToolCall {
  id: string;
  name: string;
  argumentsRaw: string;
}

export interface TraceTurn {
  turn: number;
  startedAt: string;
  latencyMs: number;
  finishReason: string | null;
  content: string;
  toolCalls: TraceToolCall[];
  usage: {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
    providerReportedCostUsd: number | null;
  };
  requestSummary: {
    messageCount: number;
    toolCount: number;
    model: string;
    condition: ConditionId;
  };
  /** Provider-specific warning (e.g. reasoning tokens) without secrets. */
  notes?: string[];
}

export interface AdaptedLookupRecord {
  tool: string;
  input: unknown;
  ok: boolean;
  matchedId: string | null;
  matchCount: number;
  candidates: Array<Record<string, unknown>>;
  error: string | null;
}

export interface ToolCallRecord {
  index: number;
  turn: number;
  publicTool: string;
  proposedInput: unknown;
  adaptedCompilation: {
    target: string;
    input: unknown;
    transformNotes: string[];
  } | null;
  /** v2 lookup step, when the adapted tool declares one. */
  adaptedLookup?: AdaptedLookupRecord | null;
  validation: { ok: boolean; errors: string[] };
  result: ToolExecResult;
  startedAt: string;
  durationMs: number;
  countedUnderlying: boolean;
  /** Underlying original calls made by this public call (absent in older records = 1 when counted). */
  underlyingCalls?: number;
  source: 'model' | 'simulation';
}

export interface ModelIdentity {
  requested: string;
  reported: string | null;
  provider: string;
  baseUrl: string;
  /** Set when the provider response exposes a fixed reported model id. */
  responseId: string | null;
}

export interface TrialRecord {
  id: string;
  runId: string;
  taskId: string;
  taskTitle: string;
  family: string;
  domain: string;
  condition: ConditionId;
  trial: number;
  mode: RunMode;
  status: TrialStatus;
  statusReason: string | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  model: ModelIdentity;
  interfaceHash: string;
  adapterHash: string | null;
  usage: UsageRecord;
  turns: TraceTurn[];
  toolCalls: ToolCallRecord[];
  initialState: unknown;
  finalState: unknown;
  stateDiff: StateDiff;
  checks: CheckResult[];
  finalAnswer: string;
  error: { code: string; message: string; detail?: unknown } | null;
  notes: string[];
  /** Explicit provenance; a simulation is never a live model benchmark. */
  evidenceClass: 'live-model' | 'scripted-simulation';
}

export interface ConditionSummary {
  attempts: number;
  pass: number;
  fail: number;
  invalid: number;
  error: number;
  canceled: number;
  /** pass / attempts, null when attempts === 0. */
  passRate: number | null;
  /** pass / (pass + fail), null when no decisive verdicts. */
  decisivePassRate: number | null;
  /** Wilson 95% interval on attempts, only when attempts >= 5. */
  wilson95: [number, number] | null;
  underlyingToolCalls: number;
  totalTokens: number | null;
}

export interface PairedSummary {
  taskId: string;
  trialsPerCondition: number;
  pass: Record<ConditionId, number>;
  decisive: Record<ConditionId, number>;
  /** True when every included condition has at least one decisive verdict. */
  comparable: boolean;
}

export interface RunSummary {
  mode: RunMode;
  liveEligible: boolean;
  byCondition: Partial<Record<ConditionId, ConditionSummary>>;
  paired: PairedSummary[];
  notes: string[];
  computedAt: string;
}

export interface RunProvenance {
  appVersion: string;
  taskSetVersion: string;
  interfaceHashes: Partial<Record<ConditionId, string>>;
  adapterHash: string | null;
  adapterSource: 'default' | 'saved';
  evidenceClass: 'live-model' | 'scripted-simulation';
  startedBy: 'workbench' | 'mcp' | 'cli';
  modelIdentity: ModelIdentity | null;
  providerReportedCostAvailable: boolean;
}

export interface RunRecord {
  id: string;
  mode: RunMode;
  status: RunStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  config: RunConfig;
  taskIds: string[];
  provenance: RunProvenance;
  trials: TrialRecord[];
  summary: RunSummary;
  cancelRequestedAt: string | null;
  error: string | null;
}

export interface RunListItem {
  id: string;
  mode: RunMode;
  status: RunStatus;
  domain: string;
  split: Split;
  model: string;
  createdAt: string;
  finishedAt: string | null;
  attempts: number;
  pass: number;
  fail: number;
  invalid: number;
  error: number;
  canceled: number;
}

export interface TaskMetadata {
  id: string;
  domain: string;
  family: string;
  split: Split;
  title: string;
  prompt: string;
  outputContract: { description: string; example: string } | null;
  notes: string | null;
}

export interface InterfaceView {
  domain: string;
  condition: ConditionId;
  tools: ToolDefinition[];
  hash: string;
  adapter: AdapterSpec | null;
  limits: string[];
}

export interface ModelStatus {
  configured: boolean;
  provider: string | null;
  baseUrl: string | null;
  model: string | null;
  keyInMemory: boolean;
  keyPersisted: false;
}