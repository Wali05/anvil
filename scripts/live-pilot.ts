import { resolve } from 'node:path';
import { Store } from '../src/core/store.js';
import { ExperimentRunner, type StartExperimentInput } from '../src/core/runner.js';

const domainArg = process.argv[2] ?? 'calendar';
const splitArg = (process.argv[3] ?? 'dev') as 'dev' | 'eval' | 'eval2';
if (!['dev', 'eval', 'eval2'].includes(splitArg)) {
  console.error('split must be dev, eval or eval2');
  process.exit(1);
}
const rawTaskArg = process.argv[4];
const taskIdsArg = rawTaskArg && rawTaskArg !== 'all' ? rawTaskArg.split(',').filter(Boolean) : undefined;
const trialsArg = Number(process.argv[5] ?? '1');
const modelId = process.env.ANVIL_MODEL ?? 'qwen2.5:7b';
const baseUrl = process.env.ANVIL_MODEL_BASE_URL ?? 'http://127.0.0.1:11434/v1';

if (splitArg === 'eval2') {
  // Refuse to run the sealed set if its tasks, fixtures or frozen adapters changed since sealing.
  const { spawnSync } = await import('node:child_process');
  const check = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/seal-eval2.ts', '--check'], { stdio: 'inherit' });
  if (check.status !== 0) {
    console.error('eval v2 seal check failed; not running.');
    process.exit(1);
  }
}

const store = new Store(resolve(process.env.ANVIL_DATA_DIR ?? '.anvil'));
await store.init();
const runner = new ExperimentRunner({ store });

const input: StartExperimentInput = {
  mode: 'live',
  domain: domainArg,
  split: splitArg,
  ...(taskIdsArg ? { taskIds: taskIdsArg } : {}),
  trialsPerTask: trials1(trialsArg),
  budget: {
    maxTurnsPerTrial: 8,
    maxUnderlyingToolCallsPerTrial: 6,
    // Run-wide cap high enough that late trials are never cut off (27 trials × 6 = 162 worst case).
    maxUnderlyingToolCallsTotal: 300,
    maxTotalTokens: 600_000,
    maxWallClockMsPerTrial: 180_000,
  },
};

function trials1(value: number): number {
  return Number.isFinite(value) && value >= 1 && value <= 3 ? Math.round(value) : 1;
}

const run = await runner.start(
  input,
  {
    provider: 'ollama',
    baseUrl,
    model: modelId,
    temperature: 0,
    maxTokensPerCompletion: 900,
  },
  { startedBy: 'cli' },
);
console.log(`started ${run.id} (${run.mode}) against ${modelId} at ${baseUrl}`);

// Poll for up to 3 hours; a local 7B model can take ~1 minute per trial.
for (let attempt = 0; attempt < 3 * 60 * 60; attempt += 1) {
  const current = store.getRun(run.id);
  if (!current) break;
  if (current.status !== 'running') {
    console.log(`\nrun ${current.status} in ${current.trials.length} attempts`);
    for (const trial of current.trials) {
      console.log(`- ${trial.taskId} [${trial.condition}] ${trial.status} ${trial.statusReason ?? ''}`);
      for (const check of trial.checks.filter((entry) => !entry.ok)) {
        console.log(`    FAIL ${check.id}: ${check.detail}`);
      }
      for (const call of trial.toolCalls.filter((entry) => !entry.result.ok)) {
        console.log(`    tool ${call.publicTool}: ${call.result.error?.message?.slice(0, 200)}`);
      }
      if (trial.error) console.log(`    error ${trial.error.code}: ${trial.error.message.slice(0, 200)}`);
    }
    const summary = current.summary.byCondition;
    for (const [condition, value] of Object.entries(summary)) {
      if (!value) continue;
      console.log(
        `${condition}: ${value.pass}/${value.attempts} pass · ${value.fail} fail · ${value.invalid} invalid · ${value.error} error · ${value.underlyingToolCalls} calls · ${value.totalTokens ?? 'unknown'} tokens`,
      );
    }
    console.log(`model identity: ${JSON.stringify(current.provenance.modelIdentity)}`);
    break;
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
}
process.exit(0);