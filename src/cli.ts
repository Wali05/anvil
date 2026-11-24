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
import { runEvalCommand, runInitCommand, runInspectCommand, runProxyCommand, runReportCommand, runScaffoldCommand } from './proxy/cli.js';

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

const HELP = `Anvil ${APP_VERSION} — make MCP tools easier for models to call, and prove it

Name the MCP server once, the same way for every command:
  -- <command> [args…]                         a stdio server
  --url <https://…/mcp> [--header 'K: \${VAR}']  a Streamable HTTP server (SSE fallback)
  --config anvil.proxy.json                    a saved proxy config
  --sample                                     the built-in awkward ticket-desk demo

Fix a server:
  anvil init      <server> [--dir anvil] [--name <id>] [--force]
      Inspect + scaffold + stated-limit fixes + a ready proxy config and starter tasks, in one folder.
  anvil inspect   <server> | --tools-file tools.json | --domain calendar|issues  [--json] [--verbose] [--fail-on error|warn]
      Lint the tool catalog for what makes models fail, with a fix per finding.
  anvil scaffold  <server> [--tools a,b] [--name <id>] [--out adapter.json]
      Write a validated starter adapter that flattens nested inputs.
  anvil proxy     <server> [--adapter adapter.json] [--passthrough all|none] [--include a,b] [--exclude x,y]
                  [--keep-targets] [--info-tool] [--log-file calls.jsonl] [--log-args]
                  [--http <port> [--host 127.0.0.1]] [--dry-run] [--timeout <seconds>]
      Serve adapted, filtered, re-described and output-shaped tools over stdio or HTTP.

Prove it:
  anvil eval      <server> --tasks tasks.json --model <id> [--base-url <url>] [--provider ollama|openai-compatible]
                  [--conditions original,descriptions,adapted] [--attempts N] [--only id,…]
                  [--max-turns 8] [--max-calls 12] [--trial-timeout 180] [--reset restart|none] [--out run.json] [--json]
      Run the same tasks through the raw and the adapted interface and grade each trial independently.
      --check validates a task file against an untouched server, without a model.
  anvil report    <calls.jsonl> [--json]
      Which tools fail in real use, at which stage, with which errors, and which return too much.

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
  - Models for eval: ANVIL_MODEL, ANVIL_MODEL_BASE_URL, ANVIL_MODEL_PROVIDER, and the key only in ANVIL_MODEL_API_KEY.
  - Secrets: write \${VAR} in configs and --header values (single-quoted in the shell); they are read from the
    environment and never written to logs, run records or generated configs.
  - HTTP serving binds 127.0.0.1 by default. A public --host requires ANVIL_HTTP_TOKEN (bearer auth).
  - anvil-mcp-proxy (--upstream-command/--upstream-arg/--adapter-file, --sample) runs on the same engine as anvil proxy.
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
  if (command === 'init') {
    process.exitCode = await runInitCommand(rest);
    return;
  }
  if (command === 'eval') {
    process.exitCode = await runEvalCommand(rest);
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