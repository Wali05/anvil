import { describe, expect, it } from 'vitest';
import { capArrays, pickPaths, shapeResult } from '../src/proxy/output.js';
import { validateOutputShape } from '../src/core/output.js';
import { parseAdapterSpec } from '../src/core/adapter.js';
import { resolveProxyConfig } from '../src/proxy/config.js';
import { buildProxyCatalog } from '../src/proxy/catalog.js';
import { getDefaultAdapter } from '../src/domains/adapters.js';
import { summarizeCallLog } from '../src/proxy/report.js';
import { issueDomain } from '../src/domains/issues/index.js';

const issue = (number: number) => ({ number, title: `Issue ${number}`, state: 'open', user: { login: 'sam', id: 1, avatar_url: 'https://x' }, labels: [{ name: 'bug', color: 'f00' }], body: 'x'.repeat(500) });

describe('output shaping', () => {
  it('picks nested paths and maps over arrays with []', () => {
    const value = { total_count: 2, items: [issue(1), issue(2)], incomplete_results: false };
    expect(pickPaths(value, ['total_count', 'items[].number', 'items[].title', 'items[].user.login', 'items[].labels[].name'])).toEqual({
      total_count: 2,
      items: [
        { number: 1, title: 'Issue 1', user: { login: 'sam' }, labels: [{ name: 'bug' }] },
        { number: 2, title: 'Issue 2', user: { login: 'sam' }, labels: [{ name: 'bug' }] },
      ],
    });
    // A root array, and absent paths that are skipped rather than invented.
    expect(pickPaths([{ a: 1, b: 2 }, { b: 3 }], ['[].a'])).toEqual([{ a: 1 }, {}]);
    expect(pickPaths({ a: 1 }, ['missing.deep'])).toEqual({});
  });

  it('caps every array and reports what was cut', () => {
    const notes: string[] = [];
    expect(capArrays({ items: [1, 2, 3, 4], nested: { list: [1, 2, 3] } }, 2, '', notes)).toEqual({ items: [1, 2], nested: { list: [1, 2] } });
    expect(notes).toEqual(['items: showing 2 of 4 items', 'nested.list: showing 2 of 3 items']);
  });

  it('shapes JSON text results, tells the model about truncation, and never shapes errors', () => {
    const raw = { content: [{ type: 'text', text: JSON.stringify({ total_count: 30, items: Array.from({ length: 30 }, (_, i) => issue(i + 1)) }) }] };
    const shaped = shapeResult(raw, { pick: ['total_count', 'items[].number', 'items[].title'], maxItems: 5 });
    const body = JSON.parse(shaped.result.content![0]!.text as string);
    expect(body.items).toHaveLength(5);
    expect(body.items[0]).toEqual({ number: 1, title: 'Issue 1' });
    expect(shaped.result.content![1]!.text).toContain('items: showing 5 of 30 items');
    expect((shaped.result.content![0]!.text as string).length).toBeLessThan(raw.content[0]!.text.length / 20);

    const error = { content: [{ type: 'text', text: 'ERR_LIMIT: max 20' }], isError: true };
    expect(shapeResult(error, { maxChars: 200 }).result).toBe(error);
  });

  it('keeps structuredContent in step with the text and drops it when the text is cut', () => {
    const structured = { content: [{ type: 'text', text: '{}' }], structuredContent: { a: 1, b: 'x'.repeat(1000) } };
    const picked = shapeResult(structured, { pick: ['a'] });
    expect(picked.result.structuredContent).toEqual({ a: 1 });
    const cut = shapeResult(structured, { maxChars: 300 });
    expect(cut.result.structuredContent).toBeUndefined();
    expect(cut.result.content![1]!.text).toContain('truncated to 300');
    // Plain text is only length-capped.
    const text = shapeResult({ content: [{ type: 'text', text: 'y'.repeat(500) }] }, { pick: ['a'], maxChars: 200 });
    expect((text.result.content![0]!.text as string).startsWith('y'.repeat(200))).toBe(true);
  });

  it('validates shapes in adapters and proxy configs', () => {
    expect(validateOutputShape({ pick: ['items[].title'], maxItems: 20, maxChars: 4000 }, 'o')).toEqual([]);
    expect(validateOutputShape({ pick: ['a..b'], maxItems: 0, extra: 1 }, 'o')).toHaveLength(3);
    const adapter = structuredClone(getDefaultAdapter('issues')!);
    adapter.tools[0]!.output = { pick: ['items[].number'], maxItems: 0 };
    expect(parseAdapterSpec(adapter).issues.some((issue) => issue.path === '$.tools[0].output')).toBe(true);
  });

  it('applies a passthrough override shape and drops the outputSchema it would break', async () => {
    const config = await resolveProxyConfig(
      { upstream: { command: 'x' }, tools: { overrides: { issues_search: { output: { pick: ['items[].number'] } } } } },
      '.',
      {},
    );
    const tools = issueDomain.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as unknown as Record<string, unknown>,
      outputSchema: { type: 'object', properties: {} },
      annotations: tool.annotations,
    }));
    const catalog = buildProxyCatalog(tools, { adapter: null, tools: config.tools });
    const search = catalog.entries.find((entry) => entry.name === 'issues_search')!;
    expect(search.kind === 'passthrough' && search.output).toEqual({ pick: ['items[].number'] });
    expect(search.kind === 'passthrough' && search.outputSchema).toBeUndefined();
    const create = catalog.entries.find((entry) => entry.name === 'issues_create')!;
    expect(create.kind === 'passthrough' && create.outputSchema).toBeTruthy();
    await expect(resolveProxyConfig({ upstream: { command: 'x' }, tools: { overrides: { a: { output: { maxChars: 5 } } } } }, '.', {})).rejects.toThrow(/maxChars/);
  });

  it('reports result sizes and recommends a shape for large results', () => {
    const line = (resultChars: number, upstreamChars: number) =>
      JSON.stringify({ event: 'anvil_proxy_call', tool: 'list_issues', kind: 'passthrough', target: 'list_issues', ok: true, stage: 'ok', durationMs: 3, underlyingCalls: 1, lookupMatches: null, resultChars, upstreamChars });
    const report = summarizeCallLog([line(40_000, 40_000), line(48_000, 48_000), line(44_000, 44_000)].join('\n'));
    expect(report.tools[0]!.medianResultChars).toBe(44_000);
    expect(report.advice.some((advice) => advice.startsWith('list_issues: returns ~11,000 tokens per call'))).toBe(true);
  });
});
