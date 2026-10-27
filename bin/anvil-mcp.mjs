#!/usr/bin/env node
// Adapter MCP server over stdio, e.g. for Claude Desktop or any MCP client:
//   anvil-mcp --domain calendar [--condition adapted] [--adapter default|saved|file] [--adapter-file x.json]
// Run data defaults to ~/.anvil so the server works from any working directory.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(root, 'dist', 'mcp', 'adapterServer.js');
if (!existsSync(entry)) {
  process.stderr.write('[anvil-mcp] dist/mcp/adapterServer.js is missing. Run `npm run build:server` in the checkout.\n');
  process.exit(1);
}

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  process.stderr.write('usage: anvil-mcp --domain <calendar|issues> [--condition adapted|original|descriptions]\n' +
    '                 [--adapter default|saved|file] [--adapter-file <bundle-or-spec.json>] [--data-dir <dir>]\n');
  process.exit(0);
}
if (!argv.includes('--domain')) argv.push('--domain', 'calendar');
if (!argv.includes('--data-dir') && !process.env.ANVIL_DATA_DIR) argv.push('--data-dir', join(homedir(), '.anvil'));

const { parseAdapterServerArgs, runAdapterServer } = await import(pathToFileURL(entry).href);
try {
  await runAdapterServer(parseAdapterServerArgs(argv));
} catch (error) {
  process.stderr.write(`[anvil-mcp] failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
