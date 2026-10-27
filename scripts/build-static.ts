/**
 * npm run build:static — builds dist-static/, a read-only "recorded replay" of
 * the dashboard for static hosting (e.g. Vercel). It starts the real Anvil
 * server in-process over a temporary copy of the committed run records
 * (docs/evidence/runs, falling back to .anvil/runs), captures every read-only
 * API response the dashboard uses, and bundles the dashboard in replay mode.
 * Nothing in the output can call a model. No keys are read or written.
 */
import { cp, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { startServer } from '../src/server/start.js';
import { replayFileName, replayKey } from '../web/src/replayKeys.js';

const root = resolve('.');
const outDir = join(root, 'dist-static');
const sources = [join(root, 'docs', 'evidence', 'runs'), join(root, '.anvil', 'runs')];
const sourceDir = sources.find((dir) => existsSync(dir));
if (!sourceDir) {
  console.error('No run records found in docs/evidence/runs or .anvil/runs.');
  process.exit(1);
}

const dataDir = await mkdtemp(join(tmpdir(), 'anvil-replay-'));
await mkdir(join(dataDir, 'runs'), { recursive: true });
for (const file of (await readdir(sourceDir)).filter((name) => name.endsWith('.json'))) {
  await cp(join(sourceDir, file), join(dataDir, 'runs', file));
}

const running = await startServer({ port: 0, host: '127.0.0.1', dataDir, rootDir: root });
const responses: Record<string, unknown> = {};
const files: Array<{ path: string; body: string }> = [];
// Downloads the server refused with 409 (e.g. a run whose recorded adapter no
// longer matches the current one). The replay hides their download links.
const skippedDownloads: Array<{ path: string; status: number; reason: string }> = [];
const get = async (path: string): Promise<unknown> => {
  const response = await fetch(`${running.url}${path}`);
  if (!response.ok) throw new Error(`GET ${path} → HTTP ${response.status}`);
  const body = (await response.json()) as unknown;
  responses[replayKey(path)] = body;
  return body;
};
const download = async (path: string) => {
  const response = await fetch(`${running.url}${path}`);
  if (response.status === 409) {
    const body = await response.text();
    let reason = body.slice(0, 300);
    try {
      const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
      reason = String(parsed.error ?? parsed.message ?? reason);
    } catch {
      // keep the raw text
    }
    console.warn(`warning: skipping download ${path} (HTTP 409: ${reason})`);
    skippedDownloads.push({ path, status: 409, reason });
    return;
  }
  if (!response.ok) throw new Error(`GET ${path} → HTTP ${response.status}`);
  files.push({ path, body: await response.text() });
};

try {
  await get('/api/health');
  await get('/api/config/model');
  await get('/api/integration');
  const domains = (await get('/api/domains')) as { domains: Array<{ id: string }> };
  for (const domain of domains.domains) {
    await get(`/api/interfaces?domain=${domain.id}`);
    await get(`/api/tasks?domain=${domain.id}`);
    await get(`/api/adapters/${domain.id}`);
    for (const kind of ['bundle', 'spec', 'mcp-config']) await download(`/api/export/adapter?domain=${domain.id}&kind=${kind}`);
  }
  const list = (await get('/api/runs')) as { runs: Array<{ id: string; mode: string; domain: string; split: string }> };
  for (const run of list.runs) {
    await get(`/api/runs/${run.id}`);
    await download(`/api/runs/${run.id}/export`);
  }

  // Scrub machine-specific absolute paths captured from the build host.
  const scrub = (text: string) => text.split(root).join('<repo>').split(dataDir).join('<replay-data>');
  const data = {
    schema: 'anvil.replay/v1',
    builtAt: new Date().toISOString(),
    sourceRuns: list.runs.map((run) => ({ id: run.id, mode: run.mode, domain: run.domain, split: run.split })),
    responses,
    skippedDownloads: skippedDownloads.map((item) => replayKey(item.path)),
  };

  await build({ configFile: join(root, 'vite.config.ts'), mode: 'replay', logLevel: 'warn' });
  await mkdir(join(outDir, 'replay', 'files'), { recursive: true });
  await writeFile(join(outDir, 'replay', 'data.json'), scrub(JSON.stringify(data)), 'utf8');
  for (const file of files) await writeFile(join(outDir, 'replay', 'files', replayFileName(file.path)), scrub(file.body), 'utf8');
  console.log(
    `dist-static/ written: ${list.runs.length} recorded runs (${list.runs.filter((run) => run.mode === 'live').length} live), ` +
      `${Object.keys(responses).length} captured responses, ${files.length} downloads` +
      (skippedDownloads.length ? `, ${skippedDownloads.length} skipped (HTTP 409).` : '.'),
  );
} finally {
  await running.close();
  await rm(dataDir, { recursive: true, force: true });
}
