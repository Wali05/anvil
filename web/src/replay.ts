/**
 * Recorded replay mode (`npm run build:static`). The dashboard is served as a
 * static site: every read comes from `replay/data.json`, captured from the real
 * Anvil server over the committed run records at build time. Nothing can start
 * a model run or change settings. Adapter validation and mapping previews still
 * run, in the page, with the same core code as the server.
 */
import { replayFileName, replayKey } from './replayKeys';

export { replayFileName, replayKey } from './replayKeys';

export const IS_REPLAY = import.meta.env.VITE_ANVIL_REPLAY === '1';

export const REPLAY_READ_ONLY_MESSAGE =
  'This is a read-only recorded replay. Clone the repository and run it locally (npm ci, npm run build, npm start) to run experiments, configure a model or save adapters.';

export interface ReplayData {
  schema: 'anvil.replay/v1';
  builtAt: string;
  sourceRuns: Array<{ id: string; mode: string; domain: string; split: string }>;
  responses: Record<string, unknown>;
  /** Download paths (replay keys) the build could not capture. */
  skippedDownloads?: string[];
}

let loading: Promise<ReplayData> | null = null;
let loaded: ReplayData | null = null;

export function replayData(): Promise<ReplayData> {
  loading ??= fetch(`${import.meta.env.BASE_URL}replay/data.json`).then(async (response) => {
    if (!response.ok) throw new Error(`Replay data missing (HTTP ${response.status}).`);
    loaded = (await response.json()) as ReplayData;
    return loaded;
  });
  return loading;
}

/** In replay mode, download links point at files captured at build time. */
export function downloadHref(path: string): string {
  if (!IS_REPLAY) return path;
  return `${import.meta.env.BASE_URL}replay/files/${replayFileName(path)}`;
}

/** False when the replay build skipped this download (no file was captured). */
export function downloadAvailable(path: string): boolean {
  if (!IS_REPLAY) return true;
  return !(loaded?.skippedDownloads ?? []).includes(replayKey(path));
}
