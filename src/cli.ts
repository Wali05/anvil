#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Store } from './core/store.js';
import { startServer } from './server/start.js';
import { runWorkbenchMcp } from './mcp/workbench.js';
import { parseAdapterServerArgs, runAdapterServer } from './mcp/adapterServer.js';
import { resolveAdapterSpec } from './mcp/resolveAdapter.js';
import { adapterBundle } from './mcp/export.js';
import { smokeStdioMcp } from './mcp/smoke.js';
import { AnvilError, errorMessage } from './core/errors.js';
import { loadProjectEnv } from './core/env.js';
import { APP_VERSION } from './core/version.js';
import { requireDomain } from './domains/index.js';
import { runInspectCommand, runProxyCommand, runReportCommand, runScaffoldCommand } from './proxy/cli.js';

function parseFlags(argv: string[]): { command: string; flags: Record<string, string>; rest: string[] } {
  const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'serve';
  const rest = command === argv[0] ? argv.slice(1) : argv;
  const flags: Record<string, string> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = rest[index + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = 'true';
    }
  }
  return { command, flags, rest };
}

const HELP = `Anvil ${APP_VERSION} — make MCP tools easier for models to call, and measure it

Put Anvil in front of any MCP server:
  anvil inspect  (--url <url> | -- <command> [args…] | --tools-file <tools.json> | --domain <fixture>)
                 [--json] [--verbose] [--fail-on error|warn] [--out <file>]
      Lint a tool catalog for patterns that make models fail (nesting, hidden limits,
      opaque ids, query dialects, missing formats, catalog size).
  anvil scaffold (--url <url> | -- <command> [args…] | --tools-file <tools.json>)
                 [--tools a,b,…] [--name <id>] [--out adapter.json]
      Generate a validated starter adapter that flattens nested tool inputs.
  anvil proxy    (--url <url> [--header "Name: value"]… | -- <command> [args…] | --config anvil.proxy.json)
                 [--adapter adapter.json] [--passthrough all|none] [--include a,b] [--exclude x,y]
                 [--keep-targets] [--log-file calls.jsonl] [--log-args] [--http <port> [--host 127.0.0.1]]
                 [--dry-run] [--timeout <seconds>]
      Serve the upstream's tools (adapted, filtered, re-described) over stdio or HTTP.
  anvil report   <calls.jsonl> [--json]
      Summarize a proxy call log: which tools fail, where, and with which errors.

Workbench and built-in fixtures:
  anvil serve [--port 4317] [--host 127.0.0.1] [--data-dir .anvil]
  anvil workbench-mcp
  anvil mcp --domain <calendar|issues> [--condition adapted|original|descriptions]
            [--adapter default|saved|file] [--adapter-file <bundle-or-spec.json>] [--http <port>]
  anvil export --domain <calendar|issues> [--source default|saved]
               [--kind bundle|spec|mcp-config] [--out <file>] [--run-id <id>]
  anvil check-mcp
  anvil --help

Notes:
  - Secrets: reference them as \${VAR} in proxy configs and --header values; they are read from the
    environment and never written to logs, run records or exports.
  - HTTP serving binds 127.0.0.1 by default. A public --host requires ANVIL_HTTP_TOKEN (bearer auth).
  - Simulation runs are labelled scripted rehearsals and are not live model evidence.
`;

async function main(): Promise<void> {
  loadProjectEnv();
  const { command, flags } = parseFlags(process.argv.slice(2));
  const rest = process.argv.slice(3);
  if (command === 'help' || command === '-h' || (flags.help === 'true' && !rest.includes('--'))) {
    process.stdout.write(HELP);
    return;
  }
  if (command === 'proxy') {
    await runProxyCommand(rest);
    return;
  }
  if (command === 'inspect') {
    process.exitCode = await runInspectCommand(rest);
    return;
  }
  if (command === 'scaffold') {
    process.exitCode = await runScaffoldCommand(rest);
    return;
  }
  if (command === 'report') {
    await runReportCommand(rest);
    return;
  }
  if (command === 'serve') {
    const running = await startServer({
      port: flags.port ? Number(flags.port) : undefined,
      host: flags.host,
      dataDir: flags['data-dir'],
      rootDir: resolve('.'),
    });
    let closing = false;
    const shutdown = async (signal: string) => {
      if (closing) return;
      closing = true;
      process.stdout.write(`[anvil] ${signal} received; closing server\n`);
      await running.close();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    return;
  }
  if (command === 'workbench-mcp') {
    if (flags['data-dir']) process.env.ANVIL_DATA_DIR = flags['data-dir'];
    await runWorkbenchMcp();
    return;
  }
  if (command === 'mcp') {
    const options = parseAdapterServerArgs(process.argv.slice(2));
    await runAdapterServer(options);
    return;
  }
  if (command === 'export') {
    const domain = flags.domain;
    if (!domain) throw new AnvilError('domain_required', '--domain is required.');
    requireDomain(domain);
    const store = new Store(flags['data-dir'] ?? process.env.ANVIL_DATA_DIR ?? '.anvil');
    await store.init();
    const source = flags.source === 'saved' ? 'saved' : flags.source === 'file' ? 'file' : 'default';
    const resolved = await resolveAdapterSpec({ domain, source, file: flags['adapter-file'], store });
    const run = flags['run-id'] ? store.getRun(flags['run-id']) ?? null : null;
    if (flags['run-id'] && !run) throw new AnvilError('run_not_found', `No run ${flags['run-id']}.`, 404);
    const bundle = adapterBundle({ spec: resolved.spec, adapterSource: resolved.source, rootDir: resolve('.'), run });
    const kind = flags.kind === 'spec' ? 'spec' : flags.kind === 'mcp-config' ? 'mcp-config' : 'bundle';
    const text = `${JSON.stringify(kind === 'spec' ? bundle.adapter : kind === 'mcp-config' ? bundle.mcpConfig : bundle, null, 2)}\n`;
    if (flags.out) {
      const path = resolve(flags.out);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text, 'utf8');
      process.stdout.write(`wrote ${path}\n`);
    } else {
      process.stdout.write(text);
    }
    return;
  }
  if (command === 'check-mcp') {
    const cliPath = resolve(process.argv[1] ?? 'dist/cli.js');
    const result = await smokeStdioMcp({
      command: process.execPath,
      args: [cliPath, 'workbench-mcp'],
      env: { ANVIL_DATA_DIR: flags['data-dir'] ?? '.anvil' },
      timeoutMs: 20_000,
      callListDomains: true,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  process.stderr.write(`Unknown command "${command}".\n\n${HELP}`);
  process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`[anvil] ${errorMessage(error)}\n`);
  process.exitCode = 1;
});