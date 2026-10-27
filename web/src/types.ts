export type ConditionId = 'original' | 'descriptions' | 'adapted';
export type Split = 'dev' | 'eval' | 'eval2';

export function splitName(split: Split): string {
  if (split === 'eval') return 'eval v1 (seen)';
  if (split === 'eval2') return 'sealed eval v2';
  return 'development';
}
export type RunMode = 'live' | 'simulation';
export type TrialStatus = 'pass' | 'fail' | 'invalid' | 'error' | 'canceled';
export type RunStatus = 'running' | 'completed' | 'canceled' | 'interrupted' | 'failed';

export interface ModelStatus {
  configured: boolean;
  provider: string | null;
  baseUrl: string | null;
  model: string | null;
  keyInMemory: boolean;
  keyPersisted: false;
}

export interface DomainInfo {
  id: string;
  name: string;
  shortName: string;
  description: string;
  environment: string;
  taskSetVersion: string;
  tasks: { dev: number; eval: number; eval2?: number };
  families: string[];
}

export interface TaskMeta {
  id: string;
  domain: string;
  family: string;
  split: Split;
  title: string;
  prompt: string;
  outputContract: { description: string; example: string } | null;
  notes: string | null;
}

export interface CheckResult {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  kind: 'intent' | 'preservation' | 'contract' | 'hygiene';
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputDescription: string;
  permissions: Array<{ scope: string; write: boolean }>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean };
}

export interface TraceTurn {
  turn: number;
  startedAt: string;
  latencyMs: number;
  finishReason: string | null;
  content: string;
  toolCalls: Array<{ id: string; name: string; argumentsRaw: string }>;
  usage: { promptTokens: number | null; completionTokens: number | null; totalTokens: number | null; providerReportedCostUsd: number | null };
  requestSummary: { messageCount: number; toolCount: number; model: string; condition: ConditionId };
  notes?: string[];
}

export interface ToolCallRecord {
  index: number;
  turn: number;
  publicTool: string;
  proposedInput: unknown;
  adaptedCompilation: { target: string; input: unknown; transformNotes: string[] } | null;
  adaptedLookup?: {
    tool: string;
    input: unknown;
    ok: boolean;
    matchedId: string | null;
    matchCount: number;
    candidates: Array<Record<string, unknown>>;
    error: string | null;
  } | null;
  validation: { ok: boolean; errors: string[] };
  result: { ok: boolean; content?: unknown; error?: { code: string; message: string; details?: unknown } };
  startedAt: string;
  durationMs: number;
  countedUnderlying: boolean;
  underlyingCalls?: number;
  source: 'model' | 'simulation';
}

export interface StateDiff {
  domain: string;
  changes: Array<{ entity: string; kind: 'added' | 'removed' | 'changed'; fields: Array<{ field: string; before: unknown; after: unknown }> }>;
  unchangedCount: number;
  summary: string;
}

export interface Trial {
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
  model: { requested: string; reported: string | null; provider: string; baseUrl: string; responseId: string | null };
  interfaceHash: string;
  adapterHash: string | null;
  usage: { promptTokens: number | null; completionTokens: number | null; totalTokens: number | null; underlyingToolCalls: number; providerReportedCostUsd: number | null };
  turns: TraceTurn[];
  toolCalls: ToolCallRecord[];
  initialState: unknown;
  finalState: unknown;
  stateDiff: StateDiff;
  checks: CheckResult[];
  finalAnswer: string;
  error: { code: string; message: string; detail?: unknown } | null;
  notes: string[];
  evidenceClass: 'live-model' | 'scripted-simulation';
}

export interface ConditionSummary {
  attempts: number;
  pass: number;
  fail: number;
  invalid: number;
  error: number;
  canceled: number;
  passRate: number | null;
  decisivePassRate: number | null;
  wilson95: [number, number] | null;
  underlyingToolCalls: number;
  totalTokens: number | null;
}

export interface Run {
  id: string;
  mode: RunMode;
  status: RunStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  config: {
    mode: RunMode;
    domain: string;
    split: Split;
    taskIds: string[];
    conditions: ConditionId[];
    trialsPerTask: number;
    model: Record<string, unknown> & { model: string; provider: string; baseUrl: string; temperature: number; maxTokensPerCompletion: number };
    budget: Record<string, number | string>;
    adapterSource: 'default' | 'saved';
    sessionNote?: string;
  };
  taskIds: string[];
  provenance: {
    appVersion: string;
    taskSetVersion: string;
    interfaceHashes: Partial<Record<ConditionId, string>>;
    adapterHash: string | null;
    adapterSource: 'default' | 'saved';
    evidenceClass: 'live-model' | 'scripted-simulation';
    startedBy: string;
    modelIdentity: { requested: string; reported: string | null; provider: string; baseUrl: string; responseId: string | null } | null;
    providerReportedCostAvailable: boolean;
  };
  trials: Trial[];
  summary: {
    mode: RunMode;
    liveEligible: boolean;
    byCondition: Partial<Record<ConditionId, ConditionSummary>>;
    paired: Array<{ taskId: string; trialsPerCondition: number; pass: Record<ConditionId, number>; decisive: Record<ConditionId, number>; comparable: boolean }>;
    notes: string[];
    computedAt: string;
  };
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

export interface AdapterIssue {
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface InterfaceResponse {
  ok: true;
  domain: string;
  environment: string;
  conditions: Array<{ condition: ConditionId; hash: string; tools: ToolDefinition[]; limits: string[] }>;
  adapter: {
    spec: Record<string, unknown>;
    source: 'default' | 'saved';
    savedAt: string | null;
    validation: { ok: boolean; issues: AdapterIssue[]; toolCount: number; interfaceHash: string };
    limits: string[];
  };
}

export interface IntegrationInfo {
  ok: true;
  local: {
    cliBuilt: boolean;
    cliPath: string;
    workbenchCommand: string;
    calendarAdapterCommand: string;
    issuesAdapterCommand: string;
    fileAdapterCommand: string;
    compatibleWith: string;
    alanDesktopStatus: string;
  };
  plugin: {
    directory: string;
    manifestPath: string;
    marketplacePath: string;
    mcpPath: string;
    manifestPresent: boolean;
    manifest: unknown;
    installed: false;
    note: string;
  };
  deployment: { deployed: false; requiredTransport: string; placeholderUrl: string; note: string };
  lastCheck: (Record<string, unknown> & { at?: string; ok?: boolean; tools?: Array<{ name: string }>; error?: string | null }) | null;
}

export interface RunPlan {
  ok: true;
  domain: string;
  tasks: string[];
  conditions: ConditionId[];
  trialsPerTask: number;
  plannedTrials: number;
  maxUnderlyingToolCalls: number;
  budget: Record<string, number | string>;
  defaultBudget: Record<string, number | string>;
}

export interface McpCheck {
  ok: boolean;
  serverName: string | null;
  serverVersion: string | null;
  tools: Array<{ name: string; description: string }>;
  latencyMs: number;
  stderrTail: string;
  error: string | null;
}