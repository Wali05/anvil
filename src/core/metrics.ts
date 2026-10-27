import type { ConditionId, ConditionSummary, PairedSummary, RunSummary, TrialRecord, TrialStatus } from './types.js';

export function wilson95(pass: number, attempts: number): [number, number] | null {
  if (attempts < 5) return null;
  const z = 1.959963984540054;
  const p = pass / attempts;
  const denominator = 1 + (z * z) / attempts;
  const center = p + (z * z) / (2 * attempts);
  const spread = z * Math.sqrt((p * (1 - p)) / attempts + (z * z) / (4 * attempts * attempts));
  return [Math.max(0, (center - spread) / denominator), Math.min(1, (center + spread) / denominator)];
}

export function conditionSummary(trials: TrialRecord[]): ConditionSummary {
  const count = (status: TrialStatus) => trials.filter((trial) => trial.status === status).length;
  const pass = count('pass');
  const fail = count('fail');
  const invalid = count('invalid');
  const error = count('error');
  const canceled = count('canceled');
  const attempts = trials.length;
  const totalTokens = trials.some((trial) => trial.usage.totalTokens !== null)
    ? trials.reduce((sum, trial) => sum + (trial.usage.totalTokens ?? 0), 0)
    : null;
  return {
    attempts,
    pass,
    fail,
    invalid,
    error,
    canceled,
    passRate: attempts > 0 ? pass / attempts : null,
    decisivePassRate: pass + fail > 0 ? pass / (pass + fail) : null,
    wilson95: wilson95(pass, attempts),
    underlyingToolCalls: trials.reduce((sum, trial) => sum + trial.usage.underlyingToolCalls, 0),
    totalTokens,
  };
}

export function computeRunSummary(trials: TrialRecord[], conditions: ConditionId[], mode: 'live' | 'simulation'): RunSummary {
  const byCondition: Partial<Record<ConditionId, ConditionSummary>> = {};
  for (const condition of conditions) {
    const subset = trials.filter((trial) => trial.condition === condition);
    if (subset.length > 0) byCondition[condition] = conditionSummary(subset);
  }
  const taskIds = [...new Set(trials.map((trial) => trial.taskId))];
  const paired: PairedSummary[] = taskIds.map((taskId) => {
    const pass = {} as Record<ConditionId, number>;
    const decisive = {} as Record<ConditionId, number>;
    let trialsPerCondition = 0;
    for (const condition of conditions) {
      const subset = trials.filter((trial) => trial.taskId === taskId && trial.condition === condition);
      pass[condition] = subset.filter((trial) => trial.status === 'pass').length;
      decisive[condition] = subset.filter((trial) => trial.status === 'pass' || trial.status === 'fail').length;
      trialsPerCondition = Math.max(trialsPerCondition, subset.length);
    }
    const comparable = conditions.length >= 2 && conditions.every((condition) => (decisive[condition] ?? 0) > 0);
    return { taskId, trialsPerCondition, pass, decisive, comparable };
  });

  const notes: string[] = [];
  if (mode === 'simulation') {
    notes.push('Scripted simulation. A deterministic policy drove the tool interface; no model was called. This is a rehearsal and is excluded from all live performance claims.');
  } else {
    notes.push('Live model evidence. Counts are descriptive; a small pilot does not establish statistical superiority.');
    const attempts = trials.length;
    if (attempts > 0 && attempts < 20) {
      notes.push(`Only ${attempts} live attempt(s) were recorded. Treat differences as provisional, not a benchmark result.`);
    }
    const costKnown = trials.filter((trial) => trial.usage.providerReportedCostUsd !== null).length;
    if (costKnown === 0) notes.push('The provider reported no cost, so cost is unknown rather than zero.');
  }
  const errored = trials.filter((trial) => trial.status === 'error').length;
  if (errored > 0) notes.push(`${errored} attempt(s) ended in a provider or runtime error and are not wins or losses.`);
  const invalid = trials.filter((trial) => trial.status === 'invalid').length;
  if (invalid > 0) notes.push(`${invalid} attempt(s) were invalid (budget or malformed output) and are excluded from decisive rates.`);
  const canceled = trials.filter((trial) => trial.status === 'canceled').length;
  if (canceled > 0) notes.push(`${canceled} attempt(s) were canceled.`);

  return {
    mode,
    liveEligible: mode === 'live',
    byCondition,
    paired,
    notes,
    computedAt: new Date().toISOString(),
  };
}

export function conditionCountsLabel(summary: ConditionSummary): string {
  return `${summary.pass} pass · ${summary.fail} fail · ${summary.invalid} invalid · ${summary.error} error · ${summary.canceled} canceled`;
}