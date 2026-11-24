import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { UpstreamSpec } from './upstream.js';

/**
 * The packaged demo: an intentionally awkward in-memory "ticket desk" MCP
 * server (nested envelopes, O/C status codes, priority levels "1"-"3", cancel
 * by opaque id) and an adapter that fixes it. Lets anyone see the proxy, the
 * eval and the report work with no account, no network and no model setup.
 */

let cachedRoot: string | null = null;

/** The package root, found by walking up from this module (works from src/ via tsx and from bundled dist/). */
export function packageRoot(): string {
  if (cachedRoot) return cachedRoot;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      try {
        if ((JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name === 'anvil-workbench') {
          cachedRoot = dir;
          return dir;
        }
      } catch {
        // keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not locate the Anvil package root.');
}

/** How to launch the sample upstream: the built bundle when present, else the TypeScript source through tsx. */
export function sampleUpstreamSpec(): Extract<UpstreamSpec, { kind: 'stdio' }> {
  const root = packageRoot();
  const dist = resolve(root, 'dist/mcp/sampleUpstream.js');
  if (existsSync(dist)) return { kind: 'stdio', command: process.execPath, args: [dist] };
  const src = resolve(root, 'src/mcp/sampleUpstream.ts');
  if (existsSync(src)) return { kind: 'stdio', command: process.execPath, args: ['--import', 'tsx', src] };
  throw new Error('The sample upstream is missing (dist/mcp/sampleUpstream.js). Run `npm run build:server`.');
}

export function sampleAdapterPath(): string {
  return resolve(packageRoot(), 'examples/adapters/sample-desk.adapter.json');
}

export function sampleTasksPath(): string {
  return resolve(packageRoot(), 'examples/sample-desk.tasks.json');
}
