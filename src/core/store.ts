import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { AdapterSpec, RunListItem, RunRecord } from './types.js';
import { computeRunSummary } from './metrics.js';
import { nowIso } from './util.js';

export interface SavedAdapter {
  savedAt: string;
  spec: AdapterSpec;
}

export class Store {
  readonly dataDir: string;
  readonly runsDir: string;
  readonly adaptersDir: string;
  private readonly runs = new Map<string, RunRecord>();
  private initialized = false;
  private readonly pendingWrites = new Map<string, Promise<void>>();
  private tempCounter = 0;

  constructor(dataDir = '.anvil') {
    this.dataDir = resolve(dataDir);
    this.runsDir = join(this.dataDir, 'runs');
    this.adaptersDir = join(this.dataDir, 'adapters');
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.runsDir, { recursive: true });
    await mkdir(this.adaptersDir, { recursive: true });
    const entries = await readdir(this.runsDir).catch(() => [] as string[]);
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const path = join(this.runsDir, entry);
      try {
        const parsed = JSON.parse(await readFile(path, 'utf8')) as RunRecord;
        if (!parsed || typeof parsed.id !== 'string' || !Array.isArray(parsed.trials)) continue;
        if (parsed.status === 'running') {
          parsed.status = 'interrupted';
          parsed.finishedAt = nowIso();
          parsed.error = 'The server stopped before this run finished. Completed trials are preserved.';
          parsed.summary = computeRunSummary(parsed.trials, parsed.config.conditions, parsed.mode);
          parsed.summary.notes.unshift('This run was interrupted by a process restart and was not resumed.');
          await this.writeJson(path, parsed);
        }
        this.runs.set(parsed.id, parsed);
      } catch (error) {
        // A corrupt run file is left on disk but does not take down the workbench.
        process.stderr.write(`[anvil] skipped unreadable run file ${entry}: ${(error as Error).message}\n`);
      }
    }
    this.initialized = true;
  }

  /**
   * Writes to the same path are serialized: concurrent saves of one run (for
   * example a trial completing while a cancel is persisted) would otherwise
   * race on rename. Each write also gets a unique temp name.
   */
  private writeJson(path: string, value: unknown): Promise<void> {
    const previous = this.pendingWrites.get(path) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.writeJsonNow(path, value));
    this.pendingWrites.set(path, next);
    void next.finally(() => {
      if (this.pendingWrites.get(path) === next) this.pendingWrites.delete(path);
    }).catch(() => undefined);
    return next;
  }

  private async writeJsonNow(path: string, value: unknown): Promise<void> {
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    if (serialized.includes('"apiKey"')) {
      throw new Error('Refusing to persist a record containing an apiKey field.');
    }
    const temp = `${path}.${process.pid}.${Date.now()}.${++this.tempCounter}.tmp`;
    await writeFile(temp, serialized, 'utf8');
    try {
      await rename(temp, path);
    } catch (error) {
      await unlink(path).catch(() => undefined);
      try {
        await rename(temp, path);
      } catch {
        await unlink(temp).catch(() => undefined);
        throw error;
      }
    }
  }

  runPath(id: string): string {
    return join(this.runsDir, `${id}.json`);
  }

  async saveRun(run: RunRecord): Promise<void> {
    await mkdir(this.runsDir, { recursive: true });
    this.runs.set(run.id, run);
    await this.writeJson(this.runPath(run.id), run);
  }

  getRun(id: string): RunRecord | undefined {
    return this.runs.get(id);
  }

  listRuns(): RunListItem[] {
    return [...this.runs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((run) => ({
        id: run.id,
        mode: run.mode,
        status: run.status,
        domain: run.config.domain,
        split: run.config.split,
        model: run.mode === 'simulation' ? 'scripted simulation' : run.config.model.model,
        createdAt: run.createdAt,
        finishedAt: run.finishedAt,
        attempts: run.trials.length,
        pass: run.trials.filter((trial) => trial.status === 'pass').length,
        fail: run.trials.filter((trial) => trial.status === 'fail').length,
        invalid: run.trials.filter((trial) => trial.status === 'invalid').length,
        error: run.trials.filter((trial) => trial.status === 'error').length,
        canceled: run.trials.filter((trial) => trial.status === 'canceled').length,
      }));
  }

  async saveAdapter(domain: string, spec: AdapterSpec): Promise<SavedAdapter> {
    await mkdir(this.adaptersDir, { recursive: true });
    const envelope: SavedAdapter = { savedAt: nowIso(), spec };
    await this.writeJson(join(this.adaptersDir, `${domain}.json`), envelope);
    return envelope;
  }

  async getSavedAdapter(domain: string): Promise<SavedAdapter | null> {
    try {
      const raw = await readFile(join(this.adaptersDir, `${domain}.json`), 'utf8');
      const parsed = JSON.parse(raw) as SavedAdapter;
      if (!parsed || typeof parsed.savedAt !== 'string' || !parsed.spec) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async deleteSavedAdapter(domain: string): Promise<boolean> {
    try {
      await unlink(join(this.adaptersDir, `${domain}.json`));
      return true;
    } catch {
      return false;
    }
  }
}