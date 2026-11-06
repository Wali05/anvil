import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { serveMcp, textResult, type HttpServeOptions, type McpTool } from '../mcp/common.js';
import { errorMessage } from '../core/errors.js';
import { hashJson } from '../core/util.js';
import { APP_VERSION } from '../core/version.js';
import { buildProxyCatalog, type CatalogEntry, type ProxyCatalog } from './catalog.js';
import type { ResolvedProxyConfig } from './config.js';
import { executeAdaptedCall } from './executor.js';
import { connectUpstream, toExecResult, type Upstream, type UpstreamCallResult } from './upstream.js';

/** One line of the proxy's JSONL call trace. `anvil report` reads these. */
export interface ProxyCallLog {
  ts: string;
  event: 'anvil_proxy_call';
  tool: string;
  kind: 'adapted' | 'passthrough';
  target: string;
  ok: boolean;
  /**
   * Where a failure happened: the model's arguments broke the public schema (`input`),
   * the adapter could not compile them (`adapter`), the lookup matched zero or several
   * records (`lookup`), or the upstream call failed (`upstream`).
   */
  stage: 'ok' | 'input' | 'adapter' | 'lookup' | 'upstream';
  errorCode: string | null;
  error: string | null;
  durationMs: number;
  underlyingCalls: number;
  lookupMatches: number | null;
  arguments?: unknown;
  compiledInput?: unknown;
}

export interface ProxyRuntime {
  upstream: Upstream;
  catalog: ProxyCatalog;
  tools: McpTool[];
  /** Logs a call to a tool that is not exposed (hidden by the proxy, or invented by the model). */
  onUnknownTool(name: string, args: Record<string, unknown>): void;
  serverName: string;
  instructions: string;
  close(): Promise<void>;
}

function stageFor(code: string | null | undefined): ProxyCallLog['stage'] {
  if (!code) return 'ok';
  if (code === 'tool_input_invalid') return 'input';
  if (code.startsWith('adapter_lookup')) return 'lookup';
  if (code.startsWith('adapter_')) return 'adapter';
  return 'upstream';
}

function createLogger(config: ResolvedProxyConfig['log']): (entry: ProxyCallLog) => void {
  let ready: Promise<void> | null = config.file ? mkdir(dirname(config.file), { recursive: true }).then(() => undefined) : null;
  return (entry) => {
    const line = JSON.stringify(entry);
    process.stderr.write(`[anvil-proxy] ${line}\n`);
    if (config.file && ready) {
      const file = config.file;
      ready = ready.then(() => appendFile(file, `${line}\n`, 'utf8')).catch((error) => {
        process.stderr.write(`[anvil-proxy] could not write log file: ${errorMessage(error)}\n`);
      });
    }
  };
}

function toMcpTool(entry: CatalogEntry, upstream: Upstream, catalog: ProxyCatalog, config: ResolvedProxyConfig, log: (entry: ProxyCallLog) => void): McpTool {
  const withArgs = (args: unknown, compiled?: unknown) =>
    config.log.includeArguments ? { arguments: args, ...(compiled !== undefined ? { compiledInput: compiled } : {}) } : {};

  if (entry.kind === 'passthrough') {
    return {
      name: entry.name,
      description: entry.description,
      inputSchema: entry.inputSchema,
      ...(entry.outputSchema ? { outputSchema: entry.outputSchema } : {}),
      ...(entry.annotations ? { annotations: entry.annotations } : {}),
      // The upstream validates its own arguments; a second, possibly stricter, check here would only add false rejections.
      skipValidation: true,
      async rawHandler(args) {
        const started = Date.now();
        try {
          const result = await upstream.callTool(entry.upstreamName, args);
          const parsed = toExecResult(result);
          log({
            ts: new Date().toISOString(),
            event: 'anvil_proxy_call',
            tool: entry.name,
            kind: 'passthrough',
            target: entry.upstreamName,
            ok: parsed.ok,
            stage: parsed.ok ? 'ok' : 'upstream',
            errorCode: parsed.ok ? null : 'upstream_tool_error',
            error: parsed.ok ? null : (parsed.error?.message ?? null),
            durationMs: Date.now() - started,
            underlyingCalls: 1,
            lookupMatches: null,
            ...withArgs(args),
          });
          return result as Record<string, unknown>;
        } catch (error) {
          log({
            ts: new Date().toISOString(),
            event: 'anvil_proxy_call',
            tool: entry.name,
            kind: 'passthrough',
            target: entry.upstreamName,
            ok: false,
            stage: 'upstream',
            errorCode: 'upstream_call_failed',
            error: errorMessage(error),
            durationMs: Date.now() - started,
            underlyingCalls: 1,
            lookupMatches: null,
            ...withArgs(args),
          });
          return textResult({ ok: false, error: `${entry.upstreamName} failed: ${errorMessage(error)}` }, true) as unknown as Record<string, unknown>;
        }
      },
    };
  }

  return {
    name: entry.name,
    description: entry.description,
    inputSchema: entry.inputSchema as unknown as Record<string, unknown>,
    ...(entry.annotations ? { annotations: entry.annotations } : {}),
    // Validated inside executeAdaptedCall so that rejected arguments are logged too.
    skipValidation: true,
    async rawHandler(args) {
      const started = Date.now();
      const execution = await executeAdaptedCall({
        tool: entry.spec,
        args,
        schemas: catalog.schemas,
        readOnlyTools: catalog.readOnlyTools,
        call: (name, input) => upstream.callTool(name, input),
      });
      const code = execution.result.ok ? null : (execution.result.error?.code ?? 'error');
      log({
        ts: new Date().toISOString(),
        event: 'anvil_proxy_call',
        tool: entry.name,
        kind: 'adapted',
        target: entry.spec.target,
        ok: execution.ok,
        stage: execution.ok ? 'ok' : stageFor(code),
        errorCode: code,
        error: execution.ok ? null : (execution.result.error?.message ?? null),
        durationMs: Date.now() - started,
        underlyingCalls: execution.underlyingCalls,
        lookupMatches: execution.lookup ? execution.lookup.matchCount : null,
        ...withArgs(args, execution.compiled.input ?? undefined),
      });
      if (execution.targetResult) return execution.targetResult as Record<string, unknown>;
      const details = execution.result.error?.details as { candidates?: unknown[] } | undefined;
      return textResult(
        {
          ok: false,
          error: execution.result.error?.message ?? 'The adapted call failed before reaching the upstream tool. Nothing was changed.',
          ...(details?.candidates && details.candidates.length > 0 ? { candidates: details.candidates } : {}),
        },
        true,
      ) as unknown as Record<string, unknown>;
    },
  };
}

/** Connect to the upstream, validate the adapter against its live schemas and build the exposed catalog. */
export async function startProxyRuntime(config: ResolvedProxyConfig, options: { timeoutMs?: number } = {}): Promise<ProxyRuntime> {
  const upstream = await connectUpstream(config.upstream, { timeoutMs: options.timeoutMs });
  let catalog: ProxyCatalog;
  try {
    catalog = buildProxyCatalog(upstream.tools, config);
  } catch (error) {
    await upstream.close();
    throw error;
  }
  const log = createLogger(config.log);
  const tools = catalog.entries.map((entry) => toMcpTool(entry, upstream, catalog, config, log));
  const upstreamName = (upstream.serverName ?? 'proxy').replace(/[^A-Za-z0-9_-]/g, '-');
  const serverName = config.name ?? (upstreamName.startsWith('anvil-') ? upstreamName : `anvil-${upstreamName}`);
  const adapted = catalog.entries.filter((entry) => entry.kind === 'adapted').length;
  const instructions = [
    upstream.instructions ?? '',
    adapted > 0
      ? `Served through Anvil: ${adapted} tool(s) have simplified inputs that Anvil compiles into the original call. Errors from adapted tools explain what to fix; when a lookup is ambiguous the candidates are listed.`
      : '',
  ]
    .filter((part) => part.length > 0)
    .join('\n\n');
  for (const warning of catalog.warnings) process.stderr.write(`[anvil-proxy] warning: ${warning}\n`);
  process.stderr.write(
    `[anvil-proxy] upstream ${upstream.serverName ?? '?'} ${upstream.serverVersion ?? ''} (${upstream.describe}): ${upstream.tools.length} tools; ` +
      `exposing ${tools.length} (${adapted} adapted, ${tools.length - adapted} passthrough, ${catalog.hidden.length} hidden)` +
      `${config.adapter ? `; adapter ${config.adapter.domain}@${config.adapter.version} ${hashJson(config.adapter).slice(0, 12)}` : ''}\n`,
  );
  const onUnknownTool = (name: string, args: Record<string, unknown>) => {
    const hidden = catalog.hidden.find((entry) => entry.name === name);
    log({
      ts: new Date().toISOString(),
      event: 'anvil_proxy_call',
      tool: name,
      kind: 'passthrough',
      target: name,
      ok: false,
      stage: 'input',
      errorCode: 'unknown_tool',
      error: hidden ? `called a tool the proxy hides (${hidden.reason})` : 'called a tool that does not exist',
      durationMs: 0,
      underlyingCalls: 0,
      lookupMatches: null,
      ...(config.log.includeArguments ? { arguments: args } : {}),
    });
  };
  return { upstream, catalog, tools, onUnknownTool, serverName, instructions, close: () => upstream.close() };
}

export async function runProxy(config: ResolvedProxyConfig, serve: { http?: HttpServeOptions; timeoutMs?: number } = {}): Promise<void> {
  const runtime = await startProxyRuntime(config, { timeoutMs: serve.timeoutMs });
  try {
    await serveMcp(
      {
        name: runtime.serverName,
        version: config.adapter?.version ?? APP_VERSION,
        instructions: runtime.instructions || undefined,
        tools: runtime.tools,
        onUnknownTool: runtime.onUnknownTool,
      },
      serve.http,
    );
  } finally {
    await runtime.close();
  }
}

export type { UpstreamCallResult };
