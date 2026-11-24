import type { EvalCondition, EvalRun, TaskLintResult } from './runner.js';

const LABEL: Record<EvalCondition, string> = { original: 'original', descriptions: 'descriptions', adapted: 'adapted' };

function pct(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : `${text}${' '.repeat(width - text.length)}`;
}

export function formatEvalRun(run: EvalRun, options: { verbose?: boolean } = {}): string {
  const lines: string[] = [];
  const conditions = run.conditions;
  const taskCount = run.summary.paired.length;
  lines.push(`Anvil eval — ${run.upstream.name ?? 'upstream'}${run.adapter ? ` · adapter ${run.adapter.domain}@${run.adapter.version}` : ''}`);
  lines.push(`model ${run.model.reported ?? run.model.model} (${run.model.provider}) · ${taskCount} task(s) × ${run.attempts} attempt(s) · ${run.reset === 'restart' ? 'fresh upstream per trial' : 'shared upstream'}`);
  lines.push('');
  const width = Math.max(14, ...conditions.map((condition) => LABEL[condition].length + 2));
  const firstCol = Math.max(22, ...run.summary.paired.map((row) => row.taskId.length + 2));
  lines.push(`${pad('', firstCol)}${conditions.map((condition) => pad(LABEL[condition], width)).join('')}`);
  const row = (label: string, value: (condition: EvalCondition) => string) => lines.push(`${pad(label, firstCol)}${conditions.map((condition) => pad(value(condition), width)).join('')}`);
  const by = run.summary.byCondition;
  row('passed', (condition) => (by[condition] ? `${by[condition]!.pass}/${by[condition]!.attempts}` : '—'));
  row('pass rate', (condition) => pct(by[condition]?.passRate ?? null));
  row('failed checks', (condition) => String(by[condition]?.fail ?? 0));
  row('no verdict', (condition) => String((by[condition]?.invalid ?? 0) + (by[condition]?.error ?? 0)));
  row('upstream calls', (condition) => String(by[condition]?.upstreamCalls ?? 0));
  row('tokens', (condition) => (by[condition]?.totalTokens === null || by[condition]?.totalTokens === undefined ? '—' : by[condition]!.totalTokens!.toLocaleString('en-US')));
  if (conditions.some((condition) => by[condition]?.wilson95)) {
    row('Wilson 95%', (condition) => {
      const interval = by[condition]?.wilson95;
      return interval ? `${pct(interval[0])}–${pct(interval[1])}` : '—';
    });
  }
  lines.push('');
  lines.push('Per task (passes)');
  for (const pair of run.summary.paired) {
    const cells = conditions.map((condition) => pad(`${pair.pass[condition] ?? 0}/${pair.attempts}`, width)).join('');
    const values = conditions.map((condition) => pair.pass[condition] ?? 0);
    const marker = values.length > 1 && values[values.length - 1]! > values[0]! ? '  ▲' : values.length > 1 && values[values.length - 1]! < values[0]! ? '  ▼' : '';
    lines.push(`  ${pad(pair.taskId, firstCol - 2)}${cells}${marker}`);
  }
  const problems = run.trials.filter((trial) => trial.status !== 'pass');
  if (problems.length > 0) {
    lines.push('');
    lines.push('Why trials did not pass');
    for (const trial of options.verbose ? problems : problems.slice(0, 12)) {
      lines.push(`  ${trial.taskId} · ${trial.condition} #${trial.attempt}: ${trial.status}${trial.reason ? ` — ${trial.reason}` : ''}`);
      for (const check of trial.checks.filter((entry) => !entry.ok).slice(0, 3)) lines.push(`      ✖ ${check.label}: ${check.detail}`);
      const lastError = [...trial.calls].reverse().find((call) => !call.ok);
      if (lastError?.error) lines.push(`      last tool error (${lastError.tool}, ${lastError.stage}): ${lastError.error.slice(0, 200)}`);
    }
    if (!options.verbose && problems.length > 12) lines.push(`  … ${problems.length - 12} more (use --verbose, or read the JSON record)`);
  }
  for (const note of run.summary.notes) lines.push(`\nNote: ${note}`);
  if (run.attempts * taskCount < 10) lines.push('\nSmall sample: treat differences as a signal to investigate, not a result. Add tasks and --attempts for a firmer comparison.');
  return `${lines.join('\n')}\n`;
}

export function formatTaskLint(results: TaskLintResult[]): string {
  const lines = ['Task check (every task graded against an untouched upstream with an empty answer):', ''];
  let problems = 0;
  for (const result of results) {
    if (result.brokenStateChecks.length > 0) {
      problems += 1;
      lines.push(`  ✖ ${result.taskId}: a state check can't read the upstream`);
      for (const broken of result.brokenStateChecks) lines.push(`      ${broken.label}: ${broken.detail}`);
    } else if (result.passesUntouched) {
      problems += 1;
      lines.push(`  ▲ ${result.taskId}: passes without any action, so it can't tell conditions apart. Add a check that needs the work done.`);
    } else {
      lines.push(`  ✓ ${result.taskId}: fails untouched (${result.checks.filter((check) => !check.ok).length} of ${result.checks.length} checks), as it should`);
    }
  }
  lines.push('');
  lines.push(problems === 0 ? 'All tasks discriminate.' : `${problems} task(s) need attention.`);
  return `${lines.join('\n')}\n`;
}
