import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { AnvilError } from '../core/errors.js';
import { isPlainObject } from '../core/util.js';
import { getDomain } from '../domains/index.js';
import type { HttpServeOptions } from '../mcp/common.js';
import { buildProxyCatalog } from './catalog.js';
import { loadAdapterFile, loadProxyConfigFile, resolveProxyConfig, type ResolvedProxyConfig } from './config.js';
import { formatInspectReport, inspectCatalog, type FindingSeverity } from './inspect.js';
import { formatUsageReport, summarizeCallLogFile } from './report.js';
import { scaffoldAdapter } from './scaffold.js';
import { runProxy, startProxyRuntime } from './server.js';
import { connectUpstream, describeUpstream, type UpstreamSpec, type UpstreamTool } from './upstream.js';

export interface ParsedArgs {
  /** Last value of each flag. */
  flags: Record<string, string>;
  /** Every value of repeatable flags (`--header`, `--env`, `--include`, `--exclude`). */
  multi: Record<string, string[]>;
  positionals: string[];
  /** Everything after a bare `--`: the upstream command and its arguments. */
  upstreamCommand: string[];
}

const BOOLEAN_FLAGS = new Set(['json', 'verbose', 'dry-run', 'keep-targets', 'log-args', 'help', 'stdout']);

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string> = {};
  const multi: Record<string, string[]> = {};
  const positionals: string[] = [];
  let upstreamCommand: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === '--') {
      upstreamCommand = argv.slice(index + 1);
      break;
    }
    if (token.startsWith('--')) {
      let key = token.slice(2);
      let value: string | undefined;
      const eq = key.indexOf('=');
      if (eq >= 0) {
        value = key.slice(eq + 1);
        key = key.slice(0, eq);
      } else if (BOOLEAN_FLAGS.has(key)) {
        value = 'true';
      } else {
        value = argv[index + 1];
        if (value === undefined || value === '--') throw new AnvilError('flag_value_missing', `--${key} needs a value.`);
        index += 1;
      }
      flags[key] = value;
      (multi[key] ??= []).push(value);
      continue;
    }
    if (token === '-h') {
      flags.help = 'true';
      continue;
    }
    positionals.push(token);
  }
  return { flags, multi, positionals, upstreamCommand };
}

function splitList(values: string[] | undefined): string[] {
  return (values ?? []).flatMap((value) => value.split(',')).map((value) => value.trim()).filter((value) => value.length > 0);
}

function keyValues(values: string[] | undefined, separator: ':' | '=', flag: string): Record<string, string> | undefined {
  if (!values || values.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const value of values) {
    const at = value.indexOf(separator);
    if (at <= 0) throw new AnvilError('flag_invalid', `--${flag} expects "name${separator}value", got "${value}".`);
    out[value.slice(0, at).trim()] = value.slice(at + 1).trim();
  }
  return out;
}

/** Build a proxy config from `--config` plus command-line overrides. */
export async function proxyConfigFromArgs(args: ParsedArgs, env: NodeJS.ProcessEnv = process.env): Promise<ResolvedProxyConfig> {
  const { flags, multi, upstreamCommand } = args;
  let config: ResolvedProxyConfig;
  if (flags.config) {
    config = await loadProxyConfigFile(resolve(flags.config), env);
  } else {
    const upstream: Record<string, unknown> = {};
    if (flags.url) {
      upstream.url = flags.url;
      upstream.headers = keyValues(multi.header, ':', 'header');
      if (flags.transport) upstream.transport = flags.transport;
    } else if (upstreamCommand.length > 0) {
      upstream.command = upstreamCommand[0];
      upstream.args = upstreamCommand.slice(1);
      upstream.env = keyValues(multi.env, '=', 'env');
    } else {
      throw new AnvilError('upstream_required', 'Name an upstream server: `--url <https://…/mcp>`, `-- <command> [args…]`, or `--config <anvil.proxy.json>`.');
    }
    config = await resolveProxyConfig({ schema: 'anvil.proxy/v1', upstream }, process.cwd(), env);
  }
  if (flags.adapter) {
    config.adapter = await loadAdapterFile(resolve(flags.adapter));
    config.adapterPath = resolve(flags.adapter);
  }
  if (flags.name) config.name = flags.name;
  if (flags.passthrough) {
    if (flags.passthrough !== 'all' && flags.passthrough !== 'none') throw new AnvilError('flag_invalid', '--passthrough must be all or none.');
    config.tools.passthrough = flags.passthrough;
  }
  const include = splitList(multi.include);
  const exclude = splitList(multi.exclude);
  if (include.length > 0) config.tools.include = include;
  if (exclude.length > 0) config.tools.exclude = [...config.tools.exclude, ...exclude];
  if (flags['keep-targets'] === 'true') config.tools.keepTargets = true;
  if (flags['log-file']) config.log.file = resolve(flags['log-file']);
  if (flags['log-args'] === 'true') config.log.includeArguments = true;
  return config;
}

function httpOptions(flags: Record<string, string>, env: NodeJS.ProcessEnv): HttpServeOptions | undefined {
  if (!flags.http) return undefined;
  const port = Number(flags.http);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new AnvilError('flag_invalid', '--http expects a port number.');
  return { port, host: flags.host ?? '127.0.0.1', path: flags.path ?? '/mcp', bearerToken: env.ANVIL_HTTP_TOKEN || undefined };
}

function timeout(flags: Record<string, string>): number | undefined {
  if (!flags.timeout) return undefined;
  const ms = Number(flags.timeout) * 1000;
  if (!Number.isFinite(ms) || ms <= 0) throw new AnvilError('flag_invalid', '--timeout is in seconds.');
  return ms;
}

/** Load a tool catalog from a fixture, a saved `tools/list` JSON, or a live upstream. */
async function loadTools(args: ParsedArgs, env: NodeJS.ProcessEnv): Promise<{ tools: UpstreamTool[]; name: string | null; version: string | null; source: string }> {
  const { flags } = args;
  if (flags.domain) {
    const domain = getDomain(flags.domain);
    if (!domain) throw new AnvilError('domain_unknown', `Unknown built-in domain "${flags.domain}" (calendar or issues).`);
    return {
      tools: domain.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema as unknown as Record<string, unknown>, annotations: tool.annotations })),
      name: `${domain.id} fixture`,
      version: domain.taskSetVersion,
      source: `built-in fixture: ${domain.id} (original tools)`,
    };
  }
  if (flags['tools-file']) {
    const path = resolve(flags['tools-file']);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      throw new AnvilError('tools_file_unreadable', `Could not read ${path}: ${(error as Error).message}`);
    }
    const list = Array.isArray(parsed) ? parsed : isPlainObject(parsed) && Array.isArray(parsed.tools) ? parsed.tools : isPlainObject(parsed) && isPlainObject(parsed.result) && Array.isArray(parsed.result.tools) ? parsed.result.tools : null;
    if (!list) throw new AnvilError('tools_file_invalid', `${path} must hold a tools/list result ({"tools": [...]}) or an array of tools.`);
    const tools = list.filter((tool): tool is UpstreamTool => isPlainObject(tool) && typeof tool.name === 'string').map((tool) => ({ ...tool, inputSchema: isPlainObject(tool.inputSchema) ? tool.inputSchema : { type: 'object', properties: {} } }));
    return { tools, name: isPlainObject(parsed) && typeof parsed.name === 'string' ? parsed.name : null, version: null, source: `file: ${path}` };
  }
  const config = await proxyConfigFromArgs(args, env);
  const upstream = await connectUpstream(config.upstream, { timeoutMs: timeout(flags), onStderr: flags.verbose === 'true' ? undefined : () => undefined });
  try {
    return { tools: upstream.tools, name: upstream.serverName, version: upstream.serverVersion, source: upstream.describe };
  } finally {
    await upstream.close();
  }
}

async function output(text: string, out: string | undefined): Promise<void> {
  if (!out) {
    process.stdout.write(text);
    return;
  }
  const path = resolve(out);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, 'utf8');
  process.stderr.write(`wrote ${path}\n`);
}

export async function runProxyCommand(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const args = parseArgs(argv);
  const config = await proxyConfigFromArgs(args, env);
  if (args.flags['dry-run'] === 'true') {
    const runtime = await startProxyRuntime(config, { timeoutMs: timeout(args.flags) });
    await runtime.close();
    const summary = {
      upstream: { name: runtime.upstream.serverName, version: runtime.upstream.serverVersion, source: runtime.upstream.describe, tools: runtime.upstream.tools.length },
      exposed: runtime.catalog.entries.map((entry) => ({ name: entry.name, kind: entry.kind, target: entry.kind === 'adapted' ? entry.spec.target : entry.upstreamName })),
      hidden: runtime.catalog.hidden,
      warnings: runtime.catalog.warnings,
      adapterWarnings: runtime.catalog.adapterIssues.filter((issue) => issue.severity === 'warning'),
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  await runProxy(config, { http: httpOptions(args.flags, env), timeoutMs: timeout(args.flags) });
}

export async function runInspectCommand(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const args = parseArgs(argv);
  const loaded = await loadTools(args, env);
  const report = inspectCatalog(loaded.tools, { name: loaded.name, version: loaded.version, source: loaded.source });
  const text = args.flags.json === 'true' ? `${JSON.stringify(report, null, 2)}\n` : formatInspectReport(report, { verbose: args.flags.verbose === 'true' });
  await output(text, args.flags.out);
  const failOn = args.flags['fail-on'] as FindingSeverity | undefined;
  if (failOn && !['error', 'warn', 'info'].includes(failOn)) throw new AnvilError('flag_invalid', '--fail-on must be error, warn or info.');
  if (failOn === 'error' && report.counts.error > 0) return 1;
  if (failOn === 'warn' && report.counts.error + report.counts.warn > 0) return 1;
  if (failOn === 'info' && report.counts.error + report.counts.warn + report.counts.info > 0) return 1;
  return 0;
}

export async function runScaffoldCommand(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const args = parseArgs(argv);
  const loaded = await loadTools(args, env);
  const result = scaffoldAdapter(loaded.tools, { serverName: args.flags.name ?? loaded.name, select: splitList(args.multi.tools) });
  for (const note of result.notes) process.stderr.write(`[anvil-scaffold] ${note}\n`);
  if (!result.adapter) {
    process.stderr.write('[anvil-scaffold] nothing to write.\n');
    return 1;
  }
  await output(`${JSON.stringify(result.adapter, null, 2)}\n`, args.flags.out);
  if (args.flags.out) {
    const upstreamHint = args.flags.url ? `--url ${args.flags.url}` : args.upstreamCommand.length > 0 ? `-- ${args.upstreamCommand.join(' ')}` : args.flags.config ? `--config ${args.flags.config}` : '-- <upstream command>';
    process.stderr.write(`[anvil-scaffold] next: anvil proxy --adapter ${args.flags.out} ${upstreamHint}\n`);
  }
  return 0;
}

export async function runReportCommand(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const path = args.positionals[0] ?? args.flags['log-file'];
  if (!path) throw new AnvilError('log_required', 'usage: anvil report <calls.jsonl> [--json]');
  const report = await summarizeCallLogFile(resolve(path));
  process.stdout.write(args.flags.json === 'true' ? `${JSON.stringify(report, null, 2)}\n` : formatUsageReport(report));
}

/** For the catalog check without a network: used by tests and `--dry-run` style tooling. */
export { buildProxyCatalog, describeUpstream };
export type { UpstreamSpec };
