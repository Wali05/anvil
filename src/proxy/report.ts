import { readFile } from 'node:fs/promises';
import { AnvilError } from '../core/errors.js';
import { isPlainObject } from '../core/util.js';
import type { ProxyCallLog } from './server.js';

export interface ToolUsage {
  tool: string;
  kind: 'adapted' | 'passthrough';
  calls: number;
  failures: number;
  failureRate: number;
  byStage: Record<string, number>;
  topErrors: Array<{ error: string; count: number }>;
  medianMs: number | null;
}

export interface UsageReport {
  schema: 'anvil.report/v1';
  calls: number;
  failures: number;
  tools: ToolUsage[];
  skippedLines: number;
  advice: string[];
}

/** Collapse ids, numbers and quoted values so the same mistake groups together. */
export function errorShape(message: string): string {
  return message
    .replace(/(?:[A-Za-z]:)?(?:[\\/][\w.@~-]+){2,}[\\/]?/g, '<path>')
    .replace(/"[^"]{0,200}"/g, '"…"')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
    .replace(/\b\d+(\.\d+)?\b/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

export function summarizeCallLog(text: string): UsageReport {
  const byTool = new Map<string, { kind: ToolUsage['kind']; calls: number; failures: number; stages: Map<string, number>; errors: Map<string, number>; durations: number[] }>();
  let skipped = 0;
  let calls = 0;
  let failures = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim().replace(/^\[anvil-proxy\]\s*/, '');
    if (!trimmed.startsWith('{')) {
      if (trimmed.length > 0) skipped += 1;
      continue;
    }
    let entry: ProxyCallLog;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!isPlainObject(parsed) || parsed.event !== 'anvil_proxy_call' || typeof parsed.tool !== 'string') {
        skipped += 1;
        continue;
      }
      entry = parsed as unknown as ProxyCallLog;
    } catch {
      skipped += 1;
      continue;
    }
    calls += 1;
    let bucket = byTool.get(entry.tool);
    if (!bucket) {
      bucket = { kind: entry.kind, calls: 0, failures: 0, stages: new Map(), errors: new Map(), durations: [] };
      byTool.set(entry.tool, bucket);
    }
    bucket.calls += 1;
    if (typeof entry.durationMs === 'number') bucket.durations.push(entry.durationMs);
    if (!entry.ok) {
      failures += 1;
      bucket.failures += 1;
      bucket.stages.set(entry.stage, (bucket.stages.get(entry.stage) ?? 0) + 1);
      const shape = errorShape(entry.error ?? entry.errorCode ?? 'unknown error');
      bucket.errors.set(shape, (bucket.errors.get(shape) ?? 0) + 1);
    }
  }
  const tools: ToolUsage[] = [...byTool.entries()]
    .map(([tool, bucket]) => {
      const sorted = [...bucket.durations].sort((a, b) => a - b);
      return {
        tool,
        kind: bucket.kind,
        calls: bucket.calls,
        failures: bucket.failures,
        failureRate: bucket.calls > 0 ? bucket.failures / bucket.calls : 0,
        byStage: Object.fromEntries(bucket.stages),
        topErrors: [...bucket.errors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([error, count]) => ({ error, count })),
        medianMs: sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)]! : null,
      };
    })
    .sort((a, b) => b.failures - a.failures || b.calls - a.calls);

  const advice: string[] = [];
  for (const tool of tools) {
    if (tool.calls < 3 || tool.failureRate < 0.25) continue;
    if (tool.kind === 'passthrough') {
      advice.push(`${tool.tool}: ${Math.round(tool.failureRate * 100)}% of ${tool.calls} calls fail upstream. Run \`anvil inspect\` on it and consider an adapted tool.`);
    } else if ((tool.byStage.lookup ?? 0) >= tool.failures / 2) {
      advice.push(`${tool.tool}: most failures are lookups that matched zero or several records. Add a match field (e.g. a date or time) or improve the field descriptions.`);
    } else if (tool.topErrors.some((error) => error.error.startsWith('called a tool'))) {
      advice.push(`${tool.tool}: the model keeps calling a tool that is not exposed. Expose it, or give the closest exposed tool a description that covers this use.`);
    } else if ((tool.byStage.input ?? 0) >= tool.failures / 2) {
      advice.push(`${tool.tool}: most failures are arguments that break the schema. The top errors show which field; give it an example in its description, an enum, or a default.`);
    } else if ((tool.byStage.adapter ?? 0) >= tool.failures / 2) {
      advice.push(`${tool.tool}: most failures are rejected before reaching the upstream (bad formats or missing fields). Tighten the input descriptions or add defaults.`);
    } else {
      advice.push(`${tool.tool}: ${Math.round(tool.failureRate * 100)}% of ${tool.calls} calls fail upstream after compiling. Check the mapping with the workbench preview.`);
    }
  }
  return { schema: 'anvil.report/v1', calls, failures, tools, skippedLines: skipped, advice };
}

export async function summarizeCallLogFile(path: string): Promise<UsageReport> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new AnvilError('log_unreadable', `Could not read ${path}: ${(error as Error).message}`);
  }
  return summarizeCallLog(text);
}

export function formatUsageReport(report: UsageReport): string {
  const lines: string[] = [];
  const pct = (value: number) => `${Math.round(value * 100)}%`;
  lines.push(`Anvil report — ${report.calls} calls, ${report.failures} failed${report.calls > 0 ? ` (${pct(report.failures / report.calls)})` : ''}`);
  lines.push('');
  if (report.tools.length === 0) lines.push('No anvil_proxy_call entries found. Run `anvil proxy --log-file calls.jsonl …` to record some.');
  for (const tool of report.tools) {
    const stages = Object.entries(tool.byStage).map(([stage, count]) => `${stage} ${count}`).join(', ');
    lines.push(`${tool.tool} [${tool.kind}]  ${tool.calls} calls, ${tool.failures} failed (${pct(tool.failureRate)})${stages ? ` — ${stages}` : ''}${tool.medianMs !== null ? `, median ${tool.medianMs} ms` : ''}`);
    for (const error of tool.topErrors) lines.push(`    ${error.count}× ${error.error}`);
  }
  if (report.advice.length > 0) {
    lines.push('');
    lines.push('Suggestions:');
    for (const line of report.advice) lines.push(`  - ${line}`);
  }
  if (report.skippedLines > 0) lines.push(`\n(${report.skippedLines} non-call line(s) ignored)`);
  return `${lines.join('\n')}\n`;
}
