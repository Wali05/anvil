/**
 * Writes docs/evidence/eval-v2-manifest.json: sha256 of the eval v2 task files
 * and of the frozen default adapters, plus task ids and families. Run once
 * BEFORE the first live eval v2 run; `--check` verifies nothing changed since.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { calendarDomain } from '../src/domains/calendar/index.js';
import { issueDomain } from '../src/domains/issues/index.js';
import { getDefaultAdapter } from '../src/domains/adapters.js';
import { hashJson } from '../src/core/util.js';

const FILES = ['src/domains/calendar/tasks-eval2.ts', 'src/domains/issues/tasks-eval2.ts', 'src/domains/calendar/state.ts', 'src/domains/issues/state.ts'];
const OUT = 'docs/evidence/eval-v2-manifest.json';

const sha = async (path: string) => createHash('sha256').update((await readFile(path, 'utf8')).replace(/\r\n/g, '\n')).digest('hex');

const files: Record<string, string> = {};
for (const file of FILES) files[file] = await sha(file);
const adapters = { calendar: hashJson(getDefaultAdapter('calendar')), issues: hashJson(getDefaultAdapter('issues')) };
const tasks = [calendarDomain, issueDomain].flatMap((domain) =>
  domain.tasks.filter((task) => task.split === 'eval2').map((task) => ({ id: task.id, domain: domain.id, family: task.family })),
);

if (process.argv.includes('--check')) {
  const sealed = JSON.parse(await readFile(OUT, 'utf8')) as { files: Record<string, string>; adapters: Record<string, string> };
  const drift = [
    ...Object.entries(sealed.files).filter(([file, hash]) => files[file] !== hash).map(([file]) => `file ${file}`),
    ...Object.entries(sealed.adapters).filter(([domain, hash]) => adapters[domain as 'calendar' | 'issues'] !== hash).map(([domain]) => `adapter ${domain}`),
  ];
  if (drift.length > 0) {
    console.error(`eval v2 seal broken: ${drift.join(', ')}`);
    process.exit(1);
  }
  console.log('eval v2 seal intact: task files, fixtures and frozen adapters match the manifest.');
} else {
  await mkdir('docs/evidence', { recursive: true });
  const manifest = {
    schema: 'anvil.eval-seal/v1',
    sealedAt: new Date().toISOString(),
    note: 'Written before any model run on eval v2. Task files, fixtures and default adapters must not change after this point; run `npm run seal:check` to verify.',
    taskSetVersions: { calendar: calendarDomain.taskSetVersion, issues: issueDomain.taskSetVersion },
    files,
    adapters,
    tasks,
  };
  await writeFile(OUT, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`sealed ${tasks.length} eval v2 tasks -> ${OUT}`);
}
