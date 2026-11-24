import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planInit, writeInit } from '../src/proxy/init.js';
import { resolveProxyConfig } from '../src/proxy/config.js';
import { buildProxyCatalog } from '../src/proxy/catalog.js';
import { parseAdapterSpec } from '../src/core/adapter.js';
import { calendarDomain } from '../src/domains/calendar/index.js';
import { issueDomain } from '../src/domains/issues/index.js';
import type { DomainDefinition } from '../src/core/types.js';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'anvil-init-test-'));
});
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const toolsOf = (domain: DomainDefinition) =>
  domain.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema as unknown as Record<string, unknown>, annotations: tool.annotations }));

describe('anvil init', () => {
  it('plans an adapter, a stated-limit fix and a config that keeps ${VAR} references', async () => {
    const plan = planInit({
      tools: toolsOf(issueDomain),
      server: { name: 'issues', version: null, source: 'test' },
      upstream: { url: 'https://example.test/mcp', headers: { Authorization: 'Bearer ${ISSUES_TOKEN}' } },
      name: 'issues-via-anvil',
    });
    expect((plan.config.upstream as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer ${ISSUES_TOKEN}');
    expect(plan.overrides.issues_search?.description).toMatch(/`limit` is at most 50\.$/);
    expect(plan.adapter?.tools.map((tool) => tool.target)).toEqual(['issues_create', 'issues_update', 'issues_comment']);
    expect(parseAdapterSpec(plan.adapter).ok).toBe(true);
    // The written config is valid, and its catalog builds against the same tools.
    const resolved = await resolveProxyConfig({ ...plan.config, adapter: plan.adapter }, dir, { ISSUES_TOKEN: 't' });
    expect(() => buildProxyCatalog(toolsOf(issueDomain), resolved)).not.toThrow();
  });

  it('never states a limit on a tool the adapter replaces, and writes the files without overwriting', async () => {
    const plan = planInit({ tools: toolsOf(calendarDomain), server: { name: 'calendar', version: null, source: 'test' }, upstream: { command: 'cal-server' }, name: 'cal' });
    for (const tool of plan.adapter?.tools ?? []) expect(plan.overrides[tool.target]).toBeUndefined();
    const result = await writeInit(plan, join(dir, 'cal'), false);
    expect(result.written.sort()).toEqual(['adapter.json', 'anvil.proxy.json', 'inspect.txt', 'tasks.json']);
    const config = JSON.parse(await readFile(join(dir, 'cal', 'anvil.proxy.json'), 'utf8'));
    expect(config).toMatchObject({ schema: 'anvil.proxy/v1', adapter: './adapter.json', log: { file: './calls.jsonl' } });
    await expect(writeInit(plan, join(dir, 'cal'), false)).rejects.toThrow(/Refusing to overwrite/);
    await expect(writeInit(plan, join(dir, 'cal'), true)).resolves.toBeTruthy();
  });
});
