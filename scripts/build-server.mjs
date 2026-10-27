import { build } from 'esbuild';
import { rm } from 'node:fs/promises';

await rm('dist/server', { recursive: true, force: true });
await rm('dist/mcp', { recursive: true, force: true });
await rm('dist/cli.js', { force: true });

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: true,
  packages: 'external',
  logLevel: 'info',
  // MCP stdio must never receive bundler banners on stdout.
  banner: { js: '' },
};

await build({
  ...common,
  entryPoints: ['src/server/index.ts'],
  outfile: 'dist/server/index.js',
});

await build({
  ...common,
  entryPoints: ['src/mcp/workbench.ts', 'src/mcp/adapterServer.ts'],
  outdir: 'dist/mcp',
});

await build({
  ...common,
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli.js',
});

console.log('server, CLI and MCP bundles written to dist/');