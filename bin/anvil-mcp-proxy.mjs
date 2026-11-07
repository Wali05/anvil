#!/usr/bin/env node
// Anvil MCP proxy over stdio: adapt a user-owned upstream MCP server.
//   anvil-mcp-proxy --sample
//   anvil-mcp-proxy --upstream-command node --upstream-arg ./my-server.js --adapter-file adapter.json
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(root, 'dist', 'mcp', 'proxyServer.js');
if (!existsSync(entry)) {
  process.stderr.write('[anvil-mcp-proxy] dist/mcp/proxyServer.js is missing. Run `npm run build:server` in the checkout.\n');
  process.exit(1);
}

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  process.stderr.write(
    'usage: anvil-mcp-proxy --sample\n' +
      '       anvil-mcp-proxy --upstream-command <cmd> [--upstream-arg <arg> ...] --adapter-file <adapter.json>\n' +
      '\n' +
      'Puts Anvil in front of a user-owned upstream MCP (stdio). Adapted public tools\n' +
      'compile to original upstream calls. Logs original calls to stderr. Local stdio only;\n' +
      'does not proxy OAuth-backed Alan credentials or remap outputs.\n',
  );
  process.exit(0);
}

const { parseProxyServerArgs, runProxyServer } = await import(pathToFileURL(entry).href);
try {
  await runProxyServer(parseProxyServerArgs(argv));
} catch (error) {
  process.stderr.write(`[anvil-mcp-proxy] failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
