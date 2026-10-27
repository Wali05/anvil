import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const port = 4399;
const dataDir = await mkdtemp(join(tmpdir(), 'anvil-api-'));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [resolve('dist/server/index.js')], {
  env: { ...process.env, ANVIL_PORT: String(port), ANVIL_DATA_DIR: dataDir, ANVIL_HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (chunk: Buffer) => { serverLog += chunk.toString(); });
server.stderr.on('data', (chunk: Buffer) => { serverLog += chunk.toString(); });
let failures = 0;
const check = (condition: boolean, label: string) => {
  if (condition) console.log(`  ok  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL ${label}`);
  }
};

async function waitForHealth(): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`server did not start\n${serverLog}`);
}

async function json<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T; headers: Headers }> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as T, headers: response.headers };
}

try {
  await waitForHealth();
  console.log('server started');

  const health = await json<{ ok: boolean; app: string; model: { configured: boolean } }>('/api/health');
  check(health.body.ok && health.body.app === 'Anvil', 'health endpoint');

  const index = await fetch(base);
  const indexText = await index.text();
  check(index.status === 200 && indexText.toLowerCase().includes('anvil'), 'compiled dashboard served');

  const domains = await json<{ domains: Array<{ id: string; tasks: { dev: number; eval: number } }> }>('/api/domains');
  check(domains.body.domains.length === 2 && domains.body.domains[0]?.tasks.dev! > 0, 'two domains with tasks');

  const interfaces = await json<{ conditions: unknown[]; adapter: { spec: unknown; validation: { ok: boolean } } }>('/api/interfaces?domain=calendar');
  check(interfaces.body.conditions.length === 3 && interfaces.body.adapter.validation.ok, 'three interfaces and valid adapter');

  const validation = await json<{ ok: boolean }>('/api/adapters/validate', {
    method: 'POST',
    body: JSON.stringify({ domain: 'calendar', adapter: interfaces.body.adapter.spec }),
  });
  check(validation.body.ok, 'adapter validation endpoint');

  const invalidAdapter = JSON.parse(JSON.stringify(interfaces.body.adapter.spec)) as { tools: Array<{ name: string; arguments: Array<{ to: string; from?: string; const?: unknown }> }> };
  invalidAdapter.tools[0]!.arguments.push({ to: 'unsafe.__proto__', from: 'from' });
  const invalid = await json<{ ok: boolean; issues: Array<{ severity: string }> }>('/api/adapters/validate', {
    method: 'POST',
    body: JSON.stringify({ domain: 'calendar', adapter: invalidAdapter }),
  });
  check(!invalid.body.ok && invalid.body.issues.some((issue) => issue.severity === 'error'), 'adapter rejects unsafe keys');

  const preview = await json<{ ok: boolean; originalCall: { tool: string } }>('/api/adapters/preview', {
    method: 'POST',
    body: JSON.stringify({
      domain: 'calendar',
      adapter: interfaces.body.adapter.spec,
      tool: 'schedule_event',
      args: { title: 'API smoke', start: '2026-12-02T09:00', duration_minutes: 30, attendees: ['sam@acme.test'] },
    }),
  });
  check(preview.body.ok && preview.body.originalCall.tool === 'calendar_create_event', 'mapping preview compiles to original call');

  const plan = await json<{ plannedTrials: number }>('/api/runs/plan', {
    method: 'POST',
    body: JSON.stringify({ domain: 'calendar', split: 'eval', taskIds: ['cal-eval-create', 'cal-eval-query-range'], trialsPerTask: 1 }),
  });
  check(plan.body.plannedTrials === 6, 'run plan reports six attempts');

  const started = await json<{ run: { id: string; mode: string } }>('/api/runs', {
    method: 'POST',
    body: JSON.stringify({
      mode: 'simulation',
      domain: 'calendar',
      split: 'eval',
      taskIds: ['cal-eval-create', 'cal-eval-query-range'],
      trialsPerTask: 1,
    }),
  });
  check(started.status === 201 && started.body.run.mode === 'simulation', 'simulation run started');
  const runId = started.body.run.id;

  let run: Record<string, unknown> | null = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await json<{ run: Record<string, unknown> }>(`/api/runs/${runId}`);
    run = response.body.run;
    if (run.status !== 'running') break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  check(Boolean(run) && run?.status === 'completed', 'run completed');
  const trials = (run?.trials ?? []) as Array<{ status: string; evidenceClass: string; toolCalls: Array<{ source: string }> }>;
  check(trials.length === 6 && trials.every((trial) => trial.status === 'pass'), 'all six scripted attempts pass');
  check(trials.every((trial) => trial.evidenceClass === 'scripted-simulation'), 'trials are labelled scripted-simulation');
  const summary = run?.summary as { liveEligible?: boolean; notes?: string[] } | undefined;
  check(summary?.liveEligible === false && Boolean(summary?.notes?.some((note) => note.includes('excluded from all live performance claims'))), 'summary excludes simulation from live claims');

  const evidence = await json<Record<string, unknown>>(`/api/runs/${runId}/export`);
  check(evidence.status === 200, 'evidence export responds');
  check((evidence.headers.get('content-disposition') ?? '').includes('anvil-evidence-'), 'evidence download filename');
  check((evidence.headers.get('content-type') ?? '').includes('application/json'), 'evidence MIME is JSON');
  check(!JSON.stringify(evidence.body).includes('apiKey'), 'evidence contains no apiKey field');

  const adapterExport = await json<Record<string, unknown>>('/api/export/adapter?domain=calendar&kind=bundle');
  check(adapterExport.status === 200 && adapterExport.body.schema === 'anvil.adapter-bundle/v1', 'adapter bundle export');
  check((adapterExport.headers.get('content-disposition') ?? '').includes('anvil-adapter-calendar.json'), 'adapter download filename');

  const liveWithoutConfig = await json<{ code?: string }>('/api/runs', {
    method: 'POST',
    body: JSON.stringify({ mode: 'live', domain: 'calendar', split: 'dev', taskIds: ['cal-dev-create-basic'] }),
  });
  check(liveWithoutConfig.status === 400, 'live run rejected without configured model');

  const configured = await json<{ status: { configured: boolean; keyInMemory: boolean } }>('/api/config/model', {
    method: 'POST',
    body: JSON.stringify({
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen2.5:7b',
      apiKey: 'smoke-secret-value',
      temperature: 0,
      maxTokensPerCompletion: 256,
    }),
  });
  check(configured.body.status.configured && configured.body.status.keyInMemory, 'model configured in memory');
  const test = await json<{ ok: boolean; modelCount: number }>('/api/config/test', { method: 'POST' });
  check(test.body.ok && test.body.modelCount > 0, 'local Ollama model listing');

  const files = await readdir(join(dataDir, 'runs'));
  let leaked = false;
  for (const file of files) {
    const content = await readFile(join(dataDir, 'runs', file), 'utf8');
    if (content.includes('smoke-secret-value')) leaked = true;
  }
  check(!leaked, 'API key never persisted to run files');
  await json('/api/config/model', { method: 'DELETE' });

  const integration = await json<{ local: { cliBuilt: boolean }; plugin: { installed: boolean }; deployment: { deployed: boolean } }>('/api/integration');
  check(integration.body.local.cliBuilt && integration.body.plugin.installed === false && integration.body.deployment.deployed === false, 'integration status is honest');

  const mcpCheck = await json<{ ok: boolean; result: { tools: unknown[]; ok: boolean } }>('/api/integration/check', { method: 'POST' });
  check(mcpCheck.body.ok && mcpCheck.body.result.ok && mcpCheck.body.result.tools.length === 8, 'live MCP handshake through API');

  const missing = await json('/api/runs/does-not-exist');
  check(missing.status === 404, 'unknown run returns 404');
} catch (error) {
  failures += 1;
  console.error(`API smoke failed: ${(error as Error).message}`);
  console.error(serverLog.slice(-3000));
} finally {
  server.kill();
  await rm(dataDir, { recursive: true, force: true });
}
if (failures > 0) {
  console.error(`\n${failures} API smoke failure(s)`);
  process.exitCode = 1;
} else {
  console.log('\nAPI smoke passed');
}