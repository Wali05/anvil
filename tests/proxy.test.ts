import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { normalizeUpstreamSchema } from '../src/proxy/schema.js';
import { buildProxyCatalog } from '../src/proxy/catalog.js';
import { globMatch, resolveProxyConfig, type ResolvedProxyConfig } from '../src/proxy/config.js';
import { interpolateEnv, toExecResult, type UpstreamTool } from '../src/proxy/upstream.js';
import { inspectCatalog, inspectTool } from '../src/proxy/inspect.js';
import { scaffoldAdapter, toSnakeCase } from '../src/proxy/scaffold.js';
import { summarizeCallLog } from '../src/proxy/report.js';
import { parseArgs, proxyConfigFromArgs } from '../src/proxy/cli.js';
import { startProxyRuntime } from '../src/proxy/server.js';
import { getDefaultAdapter } from '../src/domains/adapters.js';
import { calendarDomain } from '../src/domains/calendar/index.js';
import { issueDomain } from '../src/domains/issues/index.js';
import { buildConditionInterface, executeConditionTool } from '../src/core/interfaces.js';
import type { DomainDefinition } from '../src/core/types.js';

const tsxAvailable = existsSync(resolve('node_modules/tsx'));
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'anvil-proxy-test-'));
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

function fixtureTools(domain: DomainDefinition): UpstreamTool[] {
  return domain.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as unknown as Record<string, unknown>,
    annotations: tool.annotations,
  }));
}

function toolOptions(overrides: Partial<ResolvedProxyConfig['tools']> = {}): ResolvedProxyConfig['tools'] {
  return { passthrough: 'all', include: [], exclude: [], keepTargets: false, overrides: {}, ...overrides };
}

/** The raw fixture tools served by a separate MCP process: a real upstream with nested, model-hostile schemas. */
function fixtureUpstream(domain: string) {
  return {
    command: process.execPath,
    args: ['--import', 'tsx', resolve('src/cli.ts'), 'mcp', '--domain', domain, '--condition', 'original', '--data-dir', join(dir, 'data')],
  };
}

describe('upstream schema normalization', () => {
  it('inlines local $refs, collapses nullable unions and type arrays', () => {
    const schema = normalizeUpstreamSchema({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        event: { $ref: '#/$defs/Event' },
        note: { anyOf: [{ type: 'string', maxLength: 10 }, { type: 'null' }], description: 'optional note' },
        count: { type: ['integer', 'null'] },
      },
      $defs: {
        Event: { properties: { start: { $ref: '#/$defs/When' } }, required: ['start'] },
        When: { type: 'object', properties: { dateTime: { type: 'string', format: 'date-time' } } },
      },
    }) as unknown as Record<string, any>;
    expect(schema.$defs).toBeUndefined();
    expect(schema.$schema).toBeUndefined();
    expect(schema.properties.event.type).toBe('object');
    expect(schema.properties.event.properties.start.properties.dateTime.format).toBe('date-time');
    expect(schema.properties.note).toEqual({ type: 'string', maxLength: 10, description: 'optional note' });
    expect(schema.properties.count.type).toBe('integer');
  });

  it('survives a recursive $ref', () => {
    const schema = normalizeUpstreamSchema({
      type: 'object',
      properties: { node: { $ref: '#/$defs/Node' } },
      $defs: { Node: { type: 'object', properties: { child: { $ref: '#/$defs/Node' } } } },
    });
    expect(schema.type).toBe('object');
  });
});

describe('proxy config', () => {
  it('interpolates ${VAR} and ${VAR:-fallback}, and refuses a missing variable', () => {
    expect(interpolateEnv('Bearer ${TOKEN}', { TOKEN: 'abc' })).toBe('Bearer abc');
    expect(interpolateEnv('${HOST:-localhost}', {})).toBe('localhost');
    expect(() => interpolateEnv('${NOPE}', {})).toThrow(/NOPE/);
  });

  it('resolves an HTTP upstream with env headers and rejects a config with both command and url', async () => {
    const config = await resolveProxyConfig(
      { schema: 'anvil.proxy/v1', upstream: { url: 'https://example.test/mcp', headers: { Authorization: 'Bearer ${GH}' } }, tools: { exclude: ['delete_*'] } },
      dir,
      { GH: 'secret' },
    );
    expect(config.upstream).toEqual({ kind: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer secret' }, transport: 'auto' });
    expect(config.tools.exclude).toEqual(['delete_*']);
    await expect(resolveProxyConfig({ upstream: { command: 'x', url: 'https://example.test' } }, dir, {})).rejects.toThrow(/not both/);
  });

  it('parses repeatable flags and the upstream command after --', async () => {
    const args = parseArgs(['--include', 'a,b', '--include', 'c', '--log-args', '--', 'npx', '-y', 'server', '--flag']);
    expect(args.multi.include).toEqual(['a,b', 'c']);
    expect(args.flags['log-args']).toBe('true');
    expect(args.upstreamCommand).toEqual(['npx', '-y', 'server', '--flag']);
    const config = await proxyConfigFromArgs(args, {});
    expect(config.upstream).toMatchObject({ kind: 'stdio', command: 'npx', args: ['-y', 'server', '--flag'] });
    expect(config.tools.include).toEqual(['a', 'b', 'c']);
    expect(config.log.includeArguments).toBe(true);
  });

  it('matches * globs exactly', () => {
    expect(globMatch('delete_*', 'delete_repo')).toBe(true);
    expect(globMatch('delete_*', 'undelete_repo')).toBe(false);
    expect(globMatch('*.admin', 'x.admin')).toBe(true);
    expect(globMatch('get_me', 'get_me')).toBe(true);
  });
});

describe('proxy catalog', () => {
  const tools = fixtureTools(issueDomain);

  it('exposes adapted tools and hides the originals they replace', () => {
    const catalog = buildProxyCatalog(tools, { adapter: getDefaultAdapter('issues')!, tools: toolOptions() });
    const names = catalog.entries.map((entry) => entry.name);
    expect(names).toContain('search_issues');
    expect(names).not.toContain('issues_search');
    expect(catalog.hidden.every((entry) => entry.reason === 'replaced by an adapted tool')).toBe(true);
    // Adapted tools inherit the target's safety hints.
    const close = catalog.entries.find((entry) => entry.name === 'close_issue');
    expect(close?.annotations).toEqual(expect.objectContaining({ readOnlyHint: false }));
  });

  it('can keep targets, filter passthrough tools and re-describe them', () => {
    const catalog = buildProxyCatalog(tools, {
      adapter: null,
      tools: toolOptions({ exclude: ['issues_comment'], overrides: { issues_search: { name: 'find_issues', description: 'Find issues. limit is at most 50.' } } }),
    });
    expect(catalog.entries.map((entry) => entry.name)).toEqual(['find_issues', 'issues_create', 'issues_update']);
    expect(catalog.entries[0]!.description).toContain('at most 50');
    expect(catalog.hidden).toEqual([{ name: 'issues_comment', reason: 'excluded' }]);
    const kept = buildProxyCatalog(tools, { adapter: getDefaultAdapter('issues')!, tools: toolOptions({ keepTargets: true }) });
    expect(kept.entries.map((entry) => entry.name)).toContain('issues_search');
  });

  it('exposes adapted tools only with passthrough none, and warns on unknown overrides', () => {
    const catalog = buildProxyCatalog(tools, { adapter: getDefaultAdapter('issues')!, tools: toolOptions({ passthrough: 'none', overrides: { nope: { description: 'x' } } }) });
    expect(catalog.entries.every((entry) => entry.kind === 'adapted')).toBe(true);
    expect(catalog.warnings.some((warning) => warning.includes('"nope"'))).toBe(true);
  });

  it('refuses an adapter that does not fit the upstream schemas', () => {
    const adapter = structuredClone(getDefaultAdapter('issues')!);
    adapter.tools[0]!.target = 'issues_missing';
    expect(() => buildProxyCatalog(tools, { adapter, tools: toolOptions() })).toThrow(/does not fit this upstream/);
  });

  it('refuses a lookup tool the upstream does not annotate read-only', () => {
    const calendar = fixtureTools(calendarDomain).map((tool) => ({ ...tool, annotations: undefined }));
    expect(() => buildProxyCatalog(calendar, { adapter: getDefaultAdapter('calendar')!, tools: toolOptions() })).toThrow(/read-only/);
  });

  it('lets an adapted tool replace its own target name but never shadow another tool', () => {
    const adapter = structuredClone(getDefaultAdapter('issues')!);
    adapter.tools[0]!.name = 'issues_search';
    expect(() => buildProxyCatalog(tools, { adapter, tools: toolOptions() })).not.toThrow();
    adapter.tools[0]!.name = 'issues_create';
    expect(() => buildProxyCatalog(tools, { adapter, tools: toolOptions() })).toThrow(/collides/);
  });
});

describe('MCP result parsing', () => {
  it('prefers structuredContent, parses JSON text, keeps plain text and surfaces errors', () => {
    expect(toExecResult({ content: [{ type: 'text', text: 'ignored' }], structuredContent: { a: 1 } })).toEqual({ ok: true, content: { a: 1 } });
    expect(toExecResult({ content: [{ type: 'text', text: '{"items":[1]}' }] })).toEqual({ ok: true, content: { items: [1] } });
    expect(toExecResult({ content: [{ type: 'text', text: 'hello' }] })).toEqual({ ok: true, content: 'hello' });
    const error = toExecResult({ content: [{ type: 'text', text: 'boom' }], isError: true });
    expect(error.ok).toBe(false);
    expect(error.error?.message).toBe('boom');
  });
});

describe('anvil inspect', () => {
  it('finds the two causes of the documented issue-search failure', () => {
    const report = inspectCatalog(fixtureTools(issueDomain), { name: 'issues', version: null, source: 'test' });
    const search = report.tools.find((tool) => tool.name === 'issues_search')!;
    const rules = search.findings.map((finding) => `${finding.rule}:${finding.param}`);
    expect(rules).toContain('hidden-maximum:limit');
    expect(rules).toContain('query-dialect:q');
  });

  it('flags nesting and opaque ids on writes, but not a time zone field', () => {
    const report = inspectTool(fixtureTools(calendarDomain).find((tool) => tool.name === 'calendar_patch_event')!);
    const rules = report.findings.map((finding) => `${finding.rule}:${finding.param ?? ''}`);
    expect(rules).toContain('nested-input:patch');
    expect(rules).toContain('opaque-id-required:event_id');
    expect(rules.some((rule) => rule.includes('timeZone'))).toBe(false);
    expect(report.maxDepth).toBe(3);
  });

  it('reports portability errors and large catalogs', () => {
    const tools: UpstreamTool[] = Array.from({ length: 45 }, (_, index) => ({ name: `tool_${index}`, description: 'A tool that does one documented thing.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }));
    tools.push({ name: 'bad name!', inputSchema: { anyOf: [{ type: 'object' }, { type: 'object' }] } });
    tools.push({ name: 'Tool_0', description: 'Same name, other case, for testing.', inputSchema: { type: 'object', properties: {} } });
    const report = inspectCatalog(tools, { name: null, version: null, source: 'test' });
    expect(report.catalogFindings.map((finding) => finding.rule)).toEqual(expect.arrayContaining(['too-many-tools', 'duplicate-names']));
    const bad = report.tools.find((tool) => tool.name === 'bad name!')!;
    expect(bad.findings.map((finding) => finding.rule)).toEqual(expect.arrayContaining(['name-not-portable', 'top-level-union', 'description-missing']));
    expect(report.counts.error).toBeGreaterThanOrEqual(3);
  });
});

describe('anvil scaffold', () => {
  it('flattens nested inputs into a valid adapter with unique snake_case fields', () => {
    const result = scaffoldAdapter(fixtureTools(calendarDomain), { serverName: 'Calendar Fixture' });
    expect(result.adapter).not.toBeNull();
    const create = result.adapter!.tools.find((tool) => tool.target === 'calendar_create_event')!;
    expect(create.name).toBe('calendar_create_event');
    expect(Object.keys(create.inputSchema.properties)).toEqual(expect.arrayContaining(['summary', 'start_date_time', 'end_date_time', 'start_time_zone']));
    expect(create.arguments).toContainEqual({ from: 'start_date_time', to: 'event.start.dateTime', required: true });
    expect(result.adapter!.domain).toBe('calendar-fixture');
    // Flat tools are not scaffolded unless asked for.
    expect(result.adapter!.tools.some((tool) => tool.target === 'calendar_delete_event')).toBe(false);
    // The scaffolded adapter is accepted by the proxy against the same schemas.
    expect(() => buildProxyCatalog(fixtureTools(calendarDomain), { adapter: result.adapter, tools: toolOptions() })).not.toThrow();
  });

  it('scaffolds named tools, states hidden maxima and skips unmappable ones', () => {
    const tools: UpstreamTool[] = [
      { name: 'listThings', description: 'List things in a project.', inputSchema: { type: 'object', properties: { per_page: { type: 'integer', maximum: 50 } } } },
      { name: 'weird', description: 'Takes a union at the root.', inputSchema: { type: 'object', properties: { 'bad-key': { type: 'string' } }, required: ['bad-key'] } },
    ];
    const result = scaffoldAdapter(tools, { select: ['*'] });
    expect(result.adapter!.tools.map((tool) => tool.name)).toEqual(['list_things']);
    expect(result.adapter!.tools[0]!.inputSchema.properties.per_page).toEqual({ type: 'integer', maximum: 50, description: '(max 50)' });
    expect(result.notes.some((note) => note.startsWith('weird: skipped'))).toBe(true);
    expect(toSnakeCase('createPullRequest')).toBe('create_pull_request');
    expect(toSnakeCase('get-sum')).toBe('get_sum');
  });

  it('keeps tools whose fields carry value constraints a placeholder cannot satisfy', () => {
    const tools: UpstreamTool[] = [
      {
        name: 'gzip-file',
        description: 'Compress a file fetched from a URL.',
        inputSchema: {
          type: 'object',
          properties: {
            target: {
              type: 'object',
              properties: { url: { type: 'string', format: 'uri' }, ref: { type: 'string', pattern: '^[A-Z]{3}-\\d+$' } },
              required: ['url', 'ref'],
            },
          },
          required: ['target'],
        },
      },
    ];
    const result = scaffoldAdapter(tools);
    expect(result.adapter?.tools.map((tool) => tool.name)).toEqual(['gzip_file']);
    const catalog = buildProxyCatalog(tools, { adapter: result.adapter, tools: toolOptions() });
    expect(catalog.adapterIssues.some((issue) => issue.severity === 'warning' && issue.message.startsWith('not verifiable with a sample value'))).toBe(true);
    expect(toSnakeCase('2fa-reset')).toBe('t_2fa_reset');
  });
});

describe('anvil report', () => {
  it('groups failures by tool, stage and error shape', () => {
    const line = (tool: string, ok: boolean, stage: string, error: string | null) =>
      `[anvil-proxy] ${JSON.stringify({ event: 'anvil_proxy_call', tool, kind: 'adapted', target: 't', ok, stage, errorCode: ok ? null : 'x', error, durationMs: 5, underlyingCalls: 1, lookupMatches: null })}`;
    const text = [
      line('cancel_event', false, 'lookup', 'No record matched summary = "A" exactly.'),
      line('cancel_event', false, 'lookup', 'No record matched summary = "B" exactly.'),
      line('cancel_event', true, 'ok', null),
      line('find_events', true, 'ok', null),
      'some unrelated stderr line',
    ].join('\n');
    const report = summarizeCallLog(text);
    expect(report.calls).toBe(4);
    expect(report.failures).toBe(2);
    expect(report.tools[0]).toMatchObject({ tool: 'cancel_event', failures: 2, byStage: { lookup: 2 } });
    expect(report.tools[0]!.topErrors).toEqual([{ error: 'No record matched summary = "…" exactly.', count: 2 }]);
    expect(report.advice[0]).toContain('lookups');
    expect(report.skippedLines).toBe(1);
  });
});

describe('proxy end to end against a real upstream MCP process', () => {
  it('compiles adapted calls into the upstream original calls with the same effect as the in-process adapter', async () => {
    if (!tsxAvailable) return;
    const config = await resolveProxyConfig(
      { schema: 'anvil.proxy/v1', upstream: fixtureUpstream('issues'), adapter: getDefaultAdapter('issues'), log: { file: join(dir, 'calls.jsonl'), includeArguments: true } },
      dir,
    );
    const runtime = await startProxyRuntime(config, { timeoutMs: 25_000 });
    try {
      const tool = (name: string) => runtime.tools.find((entry) => entry.name === name)!;
      const args = { repo: 'acme/orbit', status: 'open', priority: 'P2', label: 'bug' };
      const viaProxy = await tool('search_issues').rawHandler!(args);
      const parsed = toExecResult(viaProxy as never);
      // The same call through the in-process engine, on a fresh fixture.
      const iface = buildConditionInterface(issueDomain, 'adapted', getDefaultAdapter('issues')!);
      const local = executeConditionTool({ iface, domain: issueDomain, state: issueDomain.initialState(), toolName: 'search_issues', args, now: '2026-11-02T09:00:00+05:30' });
      expect(parsed.ok).toBe(true);
      expect(parsed.content).toEqual(local.result.content);
      expect((parsed.content as { items: Array<{ number: number }> }).items.map((item) => item.number).sort((a, b) => a - b)).toEqual([7, 9, 12, 22]);

      const bad = await tool('search_issues').rawHandler!({ repo: 'acme/orbit', status: 'opened' });
      expect(bad.isError).toBe(true);
      expect(JSON.stringify(bad)).toContain('Invalid arguments for search_issues');
    } finally {
      await runtime.close();
    }
    const log = await readFile(join(dir, 'calls.jsonl'), 'utf8');
    const entries = log.trim().split('\n').map((entry) => JSON.parse(entry));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ tool: 'search_issues', target: 'issues_search', ok: true, stage: 'ok' });
    expect(entries[0].compiledInput.q).toContain('priority:P2');
    expect(entries[1]).toMatchObject({ ok: false, stage: 'input', underlyingCalls: 0 });
  }, 40_000);

  it('serves the proxy over stdio: lookup writes on one match and refuses on none', async () => {
    if (!tsxAvailable) return;
    const adapterFile = join(dir, 'calendar-adapter.json');
    await writeFile(adapterFile, JSON.stringify(getDefaultAdapter('calendar')), 'utf8');
    const upstream = fixtureUpstream('calendar');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', resolve('src/cli.ts'), 'proxy', '--adapter', adapterFile, '--', upstream.command, ...upstream.args],
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const client = new Client({ name: 'anvil-proxy-test', version: '0.1.0' }, { capabilities: {} });
    try {
      await client.connect(transport);
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining(['find_events', 'move_event', 'cancel_event', 'anvil_fixture_state']));
      expect(names).not.toContain('calendar_patch_event');

      const moved = await client.callTool({ name: 'move_event', arguments: { title: 'Design review', date: '2026-11-03', new_start: '2026-11-04T14:00' } });
      expect(moved.isError).toBeFalsy();
      const missing = await client.callTool({ name: 'cancel_event', arguments: { title: 'No such meeting', date: '2026-11-03' } });
      expect(missing.isError).toBe(true);
      expect(JSON.stringify(missing.content)).toContain('Nothing was changed');

      const state = await client.callTool({ name: 'anvil_fixture_state', arguments: {} });
      const events = JSON.parse((state.content as Array<{ text: string }>)[0]!.text).state.events as Array<{ summary: string; start: string; end: string; status: string }>;
      const review = events.find((event) => event.summary === 'Design review')!;
      // Moved, and the matched event's own one-hour duration was kept.
      expect(review.start).toBe('2026-11-04T14:00:00+05:30');
      expect(review.end).toBe('2026-11-04T15:00:00+05:30');
      const hidden = await client.callTool({ name: 'calendar_patch_event', arguments: {} });
      expect(hidden.isError).toBe(true);
      expect(stderr).toContain('"errorCode":"unknown_tool"');
      expect(stderr).toContain('called a tool the proxy hides (replaced by an adapted tool)');
      expect(stderr).toContain('"tool":"move_event"');
      expect(stderr).toContain('"underlyingCalls":2');
    } finally {
      await client.close().catch(() => undefined);
    }
  }, 40_000);
});

describe('shipped examples', () => {
  it('parse as proxy configs and keep the example adapters identical to the frozen defaults', async () => {
    const env = { HOME: '/home/someone', GITHUB_TOKEN: 'test-token' };
    for (const file of ['fixture-calendar.proxy.json', 'filesystem-readonly.proxy.json', 'github-remote.proxy.json']) {
      const raw = JSON.parse(await readFile(resolve('examples', file), 'utf8'));
      const config = await resolveProxyConfig(raw, resolve('examples'), env);
      expect(config.name).toBeTruthy();
    }
    const github = await resolveProxyConfig(JSON.parse(await readFile(resolve('examples/github-remote.proxy.json'), 'utf8')), resolve('examples'), env);
    expect(github.upstream).toMatchObject({ kind: 'http', headers: { Authorization: 'Bearer test-token' } });
    for (const domain of ['calendar', 'issues'] as const) {
      const example = JSON.parse(await readFile(resolve(`examples/adapters/${domain}.adapter.json`), 'utf8'));
      expect(example).toEqual(getDefaultAdapter(domain));
    }
  });
});
