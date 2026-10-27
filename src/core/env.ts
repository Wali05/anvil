import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Optional local .env loading. The file is gitignored and only read when the
 * operator creates it. Existing process environment variables win.
 * Putting ANVIL_MODEL_API_KEY in .env is an explicit on-disk opt-in; the UI
 * never writes keys anywhere.
 */
export function loadProjectEnv(rootDir = process.cwd()): void {
  const path = resolve(rootDir, '.env');
  if (!existsSync(path)) return;
  try {
    if (typeof process.loadEnvFile === 'function') {
      process.loadEnvFile(path);
      return;
    }
    const content = readFileSync(path, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const key = match[1]!;
      let value = match[2] ?? '';
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // A malformed or unreadable .env must not take down the local server.
  }
}