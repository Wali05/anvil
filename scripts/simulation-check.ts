import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/core/store.js';
import { ExperimentRunner, DEFAULT_MODEL, type StartExperimentInput } from '../src/core/runner.js';
import { validateAdapter } from '../src/core/adapter.js';
import { rawToolSchemaMap, readOnlyToolNames } from '../src/core/interfaces.js';
import { getDefaultAdapter } from '../src/domains/adapters.js';
import { requireDomain } from '../src/domains/index.js';

async function waitForRun(store: Store, id: string): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const run = store.getRun(id);
    if (run && run.status !== 'running') return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`run ${id} did not finish`);
}

const dataDir = await mkdtemp(join(tmpdir(), 'anvil-sim-'));
const store = new Store(dataDir);
await store.init();
const runner = new ExperimentRunner({ store });
let failures = 0;
try {
  for (const domainId of ['calendar', 'issues']) {
    const domain = requireDomain(domainId);
    const adapter = getDefaultAdapter(domainId)!;
    const validation = validateAdapter(adapter, {
      toolSchemas: rawToolSchemaMap(domain),
      rawToolNames: domain.tools.map((tool) => tool.name),
      readOnlyTools: readOnlyToolNames(domain),
    });
    console.log(`${domainId}: adapter valid=${validation.ok}`);
    if (!validation.ok) {
      failures += 1;
      for (const issue of validation.issues) console.log(`  ${issue.severity} ${issue.path}: ${issue.message}`);
      continue;
    }
    const input: StartExperimentInput = {
      mode: 'simulation',
      domain: domainId,
      split: domain.tasks.some((task) => task.split === 'dev') ? 'dev' : 'eval',
      trialsPerTask: 1,
    };
    const run = await runner.start(input, { ...DEFAULT_MODEL, apiKey: undefined, baseUrl: 'http://127.0.0.1:11434/v1' });
    await waitForRun(store, run.id);
    const finished = store.getRun(run.id)!;
    const bad = finished.trials.filter((trial) => trial.status !== 'pass');
    console.log(`${domainId}: run ${finished.status}, ${finished.trials.length} trials, ${bad.length} non-pass`);
    for (const trial of bad) {
      failures += 1;
      console.log(`  ${trial.taskId} [${trial.condition}] ${trial.status} ${trial.statusReason ?? ''}`);
      for (const check of trial.checks.filter((entry) => !entry.ok)) console.log(`     FAIL ${check.id}: ${check.detail}`);
      for (const call of trial.toolCalls.filter((entry) => !entry.result.ok)) {
        console.log(`     tool ${call.publicTool}: ${call.result.error?.message}`);
      }
    }
    for (const heldOut of ['eval', 'eval2'] as const) {
      if (!domain.tasks.some((task) => task.split === heldOut)) continue;
      const evalInput: StartExperimentInput = { mode: 'simulation', domain: domainId, split: heldOut, trialsPerTask: 1 };
      const evalRun = await runner.start(evalInput, DEFAULT_MODEL);
      await waitForRun(store, evalRun.id);
      const evalFinished = store.getRun(evalRun.id)!;
      const evalBad = evalFinished.trials.filter((trial) => trial.status !== 'pass');
      console.log(`${domainId}: ${heldOut} split ${evalFinished.status}, ${evalFinished.trials.length} trials, ${evalBad.length} non-pass`);
      for (const trial of evalBad) {
        failures += 1;
        console.log(`  ${trial.taskId} [${trial.condition}] ${trial.status} ${trial.statusReason ?? ''}`);
        for (const check of trial.checks.filter((entry) => !entry.ok)) console.log(`     FAIL ${check.id}: ${check.detail}`);
        for (const call of trial.toolCalls.filter((entry) => !entry.result.ok)) {
          console.log(`     tool ${call.publicTool}: ${call.result.error?.message}`);
        }
      }
    }
  }
} finally {
  await rm(dataDir, { recursive: true, force: true });
}
if (failures > 0) {
  console.error(`${failures} simulation problem(s)`);
  process.exitCode = 1;
} else {
  console.log('all scripted rehearsals passed');
}