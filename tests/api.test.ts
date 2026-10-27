import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../src/server/start.js';

let running: RunningServer;
let dataDir: string;
let base: string;

async function request<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T; headers: Headers }> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as T, headers: response.headers };
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'anvil-api-test-'));
  running = await startServer({ port: 0, dataDir, host: '127.0.0.1' });
  base = running.url;
});

afterAll(async () => {
  await running?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

describe('HTTP API', () => {
  it('reports honest health and domain metadata', async () => {
    const health = await request<{ ok: boolean; model: { configured: boolean }; storage: { dataDir: string } }>('/api/health');
    expect(health.status).toBe(200);
    expect(health.body.ok).toBe(true);
    expect(health.body.model.configured).toBe(false);
    expect(health.body.storage.dataDir).toBe(dataDir);

    const domains = await request<{ domains: Array<{ id: string; tasks: { dev: number; eval: number } }> }>('/api/domains');
    expect(domains.body.domains.map((domain) => domain.id)).toEqual(['calendar', 'issues']);
    expect(domains.body.domains[0]!.tasks.dev).toBeGreaterThan(0);
  });

  it('exposes three interfaces with a valid adapter', async () => {
    const response = await request<{
      conditions: Array<{ condition: string; tools: unknown[] }>;
      adapter: { source: string; validation: { ok: boolean } };
    }>('/api/interfaces?domain=issues');
    expect(response.status).toBe(200);
    expect(response.body.conditions.map((condition) => condition.condition)).toEqual(['original', 'descriptions', 'adapted']);
    expect(response.body.adapter.validation.ok).toBe(true);
    expect(response.body.adapter.source).toBe('default');
  });

  it('rejects a live run without a configured model', async () => {
    const response = await request<{ code: string }>('/api/runs', {
      method: 'POST',
      body: JSON.stringify({ mode: 'live', domain: 'calendar', split: 'dev', taskIds: ['cal-dev-create-basic'] }),
    });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('model_not_configured');
  });

  it('rejects an invalid split and unknown task', async () => {
    const badSplit = await request<{ code: string }>('/api/runs/plan', {
      method: 'POST',
      body: JSON.stringify({ domain: 'calendar', split: 'production' }),
    });
    expect(badSplit.status).toBe(400);
    const badTask = await request<{ code: string }>('/api/runs/plan', {
      method: 'POST',
      body: JSON.stringify({ domain: 'calendar', split: 'dev', taskIds: ['cal-eval-create'] }),
    });
    expect(badTask.status).toBe(400);
    expect(badTask.body.code).toBe('invalid_tasks');
  });

  it('runs, persists, exports and reports a simulation without live claims', async () => {
    const started = await request<{ run: { id: string } }>('/api/runs', {
      method: 'POST',
      body: JSON.stringify({
        mode: 'simulation',
        domain: 'issues',
        split: 'dev',
        taskIds: ['iss-dev-close'],
        trialsPerTask: 1,
      }),
    });
    expect(started.status).toBe(201);
    const id = started.body.run.id;

    type RunShape = {
      status: string;
      trials: Array<{ status: string; evidenceClass: string }>;
      summary: { liveEligible: boolean };
    };
    let run: RunShape | null = null;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const response = await request<{ run: RunShape }>(`/api/runs/${id}`);
      run = response.body.run;
      if (run?.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(run?.status).toBe('completed');
    expect(run?.trials).toHaveLength(3);
    expect(run?.trials.every((trial) => trial.status === 'pass')).toBe(true);
    expect(run?.trials.every((trial) => trial.evidenceClass === 'scripted-simulation')).toBe(true);
    expect(run?.summary.liveEligible).toBe(false);

    const list = await request<{ runs: Array<{ id: string }> }>('/api/runs');
    expect(list.body.runs.some((item) => item.id === id)).toBe(true);

    const evidence = await request<Record<string, unknown>>(`/api/runs/${id}/export`);
    expect(evidence.status).toBe(200);
    expect(evidence.headers.get('content-type')).toContain('application/json');
    expect(evidence.headers.get('content-disposition')).toContain('anvil-evidence-');
    expect(JSON.stringify(evidence.body)).not.toContain('apiKey');

    let restarted: { status?: string } | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const restartStore = new (await import('../src/core/store.js')).Store(dataDir);
      await restartStore.init();
      restarted = restartStore.getRun(id);
      if (restarted?.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(restarted?.status).toBe('completed');
  });

  it('validates and previews an adapter, and blocks unsafe mappings', async () => {
    const interfaces = await request<{ adapter: { spec: Record<string, unknown> } }>('/api/interfaces?domain=calendar');
    const validation = await request<{ ok: boolean }>('/api/adapters/validate', {
      method: 'POST',
      body: JSON.stringify({ domain: 'calendar', adapter: interfaces.body.adapter.spec }),
    });
    expect(validation.body.ok).toBe(true);

    const preview = await request<{
      ok: boolean;
      originalCall: { tool: string; input: { event_id: string } };
      lookupCall: { tool: string } | null;
      executed: boolean;
    }>('/api/adapters/preview', {
      method: 'POST',
      body: JSON.stringify({
        domain: 'calendar',
        adapter: interfaces.body.adapter.spec,
        tool: 'update_event',
        args: { title: 'Vendor sync', date: '2026-11-05', location: 'Room 4B' },
      }),
    });
    expect(preview.body.ok).toBe(true);
    expect(preview.body.executed).toBe(false);
    expect(preview.body.lookupCall?.tool).toBe('calendar_list_events');
    expect(preview.body.originalCall.tool).toBe('calendar_patch_event');
    expect(preview.body.originalCall.input.event_id).toContain('single exact match');

    const unsafe = JSON.parse(JSON.stringify(interfaces.body.adapter.spec)) as { tools: Array<{ arguments: unknown[] }> };
    unsafe.tools[0]!.arguments.push({ to: 'constructor.prototype.x', from: 'from' });
    const rejected = await request<{ ok: boolean }>('/api/adapters/validate', {
      method: 'POST',
      body: JSON.stringify({ domain: 'calendar', adapter: unsafe }),
    });
    expect(rejected.body.ok).toBe(false);
  });

  it('saves and resets an adapter, and exports it with the right filename', async () => {
    const interfaces = await request<{ adapter: { spec: Record<string, unknown> } }>('/api/interfaces?domain=calendar');
    const save = await request<{ ok: boolean; savedAt: string }>('/api/adapters', {
      method: 'POST',
      body: JSON.stringify({ domain: 'calendar', adapter: interfaces.body.adapter.spec }),
    });
    expect(save.body.ok).toBe(true);
    const loaded = await request<{ saved: { savedAt: string } | null; source: string }>('/api/adapters/calendar');
    expect(loaded.body.source).toBe('saved');
    expect(loaded.body.saved?.savedAt).toBe(save.body.savedAt);

    const exported = await request<Record<string, unknown>>('/api/export/adapter?domain=calendar&kind=bundle');
    expect(exported.status).toBe(200);
    expect(exported.body.schema).toBe('anvil.adapter-bundle/v1');
    expect(exported.headers.get('content-disposition')).toContain('anvil-adapter-calendar.json');
    expect(JSON.stringify(exported.body)).not.toContain('apiKey');

    const reset = await request<{ source: string }>('/api/adapters/calendar', { method: 'DELETE' });
    expect(reset.body.source).toBe('default');
  });

  it('returns a JSON 404 for an unknown run', async () => {
    const response = await request<{ code: string }>('/api/runs/run_missing');
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('run_not_found');
  });

  it('keeps the API free of CORS wildcards and reports integration honestly', async () => {
    const integration = await request<{
      plugin: { installed: boolean };
      deployment: { deployed: boolean };
      local: { cliBuilt: boolean };
    }>('/api/integration');
    expect(integration.status).toBe(200);
    expect(integration.body.plugin.installed).toBe(false);
    expect(integration.body.deployment.deployed).toBe(false);
    const health = await request('/api/health');
    expect(health.headers.get('access-control-allow-origin')).toBeNull();
  });
});