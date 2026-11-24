import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import type { AdapterSpec } from '../core/types.js';
import { isPlainObject } from '../core/util.js';
import { normalizeUpstreamSchema } from './schema.js';
import { inspectCatalog, formatInspectReport, type InspectReport } from './inspect.js';
import { scaffoldAdapter } from './scaffold.js';
import type { ToolOverride } from './config.js';
import type { UpstreamTool } from './upstream.js';

export interface InitPlan {
  report: InspectReport;
  adapter: AdapterSpec | null;
  scaffoldNotes: string[];
  overrides: Record<string, ToolOverride>;
  config: Record<string, unknown>;
  tasks: Record<string, unknown>;
}

/**
 * Description fixes that are safe to make mechanically: a limit the schema
 * enforces but the description doesn't mention. Tools the adapter replaces are
 * skipped (the scaffold states the maximum in its own field descriptions).
 */
export function mechanicalOverrides(tools: UpstreamTool[], report: InspectReport, replaced: Set<string>): Record<string, ToolOverride> {
  const overrides: Record<string, ToolOverride> = {};
  for (const toolReport of report.tools) {
    if (replaced.has(toolReport.name)) continue;
    const limits = toolReport.findings.filter((finding) => finding.rule === 'hidden-maximum' && finding.param);
    if (limits.length === 0) continue;
    const tool = tools.find((entry) => entry.name === toolReport.name);
    if (!tool) continue;
    const schema = normalizeUpstreamSchema(tool.inputSchema) as unknown as Record<string, unknown>;
    const sentences = limits
      .map((finding) => {
        let node: unknown = schema;
        for (const segment of finding.param!.split('.')) node = isPlainObject(node) && isPlainObject(node.properties) ? node.properties[segment] : undefined;
        const max = isPlainObject(node) && typeof node.maximum === 'number' ? node.maximum : null;
        return max === null ? null : `\`${finding.param}\` is at most ${max}.`;
      })
      .filter((sentence): sentence is string => sentence !== null);
    if (sentences.length === 0) continue;
    const base = (tool.description ?? '').trim();
    overrides[tool.name] = { description: `${base}${base.length > 0 && !/[.!?]$/.test(base) ? '.' : ''} ${sentences.join(' ')}`.trim() };
  }
  return overrides;
}

export function planInit(input: {
  tools: UpstreamTool[];
  server: InspectReport['server'];
  /** The upstream exactly as the user wrote it: `${VAR}` references stay unexpanded. */
  upstream: Record<string, unknown>;
  name: string;
}): InitPlan {
  const report = inspectCatalog(input.tools, input.server);
  const scaffold = scaffoldAdapter(input.tools, { serverName: input.server.name });
  const replaced = new Set((scaffold.adapter?.tools ?? []).map((tool) => tool.target));
  const overrides = mechanicalOverrides(input.tools, report, replaced);
  const config: Record<string, unknown> = {
    schema: 'anvil.proxy/v1',
    name: input.name,
    upstream: input.upstream,
    ...(scaffold.adapter ? { adapter: './adapter.json' } : {}),
    tools: {
      passthrough: 'all',
      exclude: [],
      ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
    },
    log: { file: './calls.jsonl' },
  };
  const readOnly = input.tools.find((tool) => tool.annotations?.readOnlyHint === true) ?? input.tools[0];
  const tasks = {
    schema: 'anvil.tasks/v1',
    system: 'Context every task shares: account names, ids, the time zone. Replace or delete.',
    tasks: readOnly
      ? [
          {
            id: 'example-read',
            family: 'query',
            prompt: `Replace with a real request that needs ${readOnly.name}, and say what JSON to reply with, e.g. {"count": <number>}.`,
            checks: [
              { kind: 'called', tool: readOnly.name, label: `the model used ${readOnly.name}` },
              { kind: 'answer', json: { count: 0 }, label: 'replace with the exact expected answer' },
            ],
          },
        ]
      : [],
  };
  return { report, adapter: scaffold.adapter, scaffoldNotes: scaffold.notes, overrides, config, tasks };
}

export interface InitResult {
  dir: string;
  written: string[];
  plan: InitPlan;
}

export async function writeInit(plan: InitPlan, dirArg: string, force: boolean): Promise<InitResult> {
  const dir = resolve(dirArg);
  const files: Array<[string, string]> = [
    ['anvil.proxy.json', `${JSON.stringify(plan.config, null, 2)}\n`],
    ['inspect.txt', formatInspectReport(plan.report, { verbose: true })],
    ['tasks.json', `${JSON.stringify(plan.tasks, null, 2)}\n`],
  ];
  if (plan.adapter) files.push(['adapter.json', `${JSON.stringify(plan.adapter, null, 2)}\n`]);
  const existing = files.map(([name]) => join(dir, name)).filter((path) => existsSync(path));
  if (existing.length > 0 && !force) {
    throw new Error(`Refusing to overwrite ${existing.map((path) => relative(process.cwd(), path) || path).join(', ')}. Pass --force, or pick another --dir.`);
  }
  await mkdir(dir, { recursive: true });
  for (const [name, text] of files) await writeFile(join(dir, name), text, 'utf8');
  return { dir, written: files.map(([name]) => name), plan };
}
