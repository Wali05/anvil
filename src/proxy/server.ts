import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { serveMcp, textResult, type HttpServeOptions, type McpTool } from '../mcp/common.js';
import { errorMessage } from '../core/errors.js';
import { hashJson } from '../core/util.js';
import { APP_VERSION } from '../core/version.js';
import type { OutputShape } from '../core/types.js';
import { buildProxyCatalog, type CatalogEntry, type ProxyCatalog } from './catalog.js';
import type { ResolvedProxyConfig } from './config.js';
import { executeAdaptedCall } from './executor.js';
import { resultChars, shapeResult } from './output.js';
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
   * Where a failure happened: the model's arguments broke the public schema or named a tool
   * that is not exposed (`input`), the adapter could not compile them (`adapter`), the lookup
   * matched zero or several records (`lookup`), or the upstream call failed (`upstream`).
   */
  stage: 'ok' | 'input' | 'adapter' | 'lookup' | 'upstream';
  errorCode: string | null;
  error: string | null;
  durationMs: number;
  underlyingCalls: number;
  lookupMatches: number | null;
  /** The lookup step of a v2 adapted tool. */
  lookup: { tool: string; matchedId: string | null; matchCount: number } | null;
  /** The original call that was sent, or null when nothing reached the upstream target. Its input is logged only with includeArguments. */
  originalCall: { tool: string; input?: unknown } | null;
  /** Characters returned to the client, and before output shaping. */
  resultChars: number | null;
  upstreamChars: number | null;
  arguments?: unknown;
}

/** In-process view of one call, with arguments regardless of log settings (never written anywhere by the proxy). */
export interface ProxyCallEvent {
  log: ProxyCallLog;
  arguments: Record<string, unknown>;
  compiledInput: unknown;
  result: UpstreamCallResult | null;
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

export interface ProxyRuntimeOptions {
  timeoutMs?: number;
  /** Receives every call, e.g. for `anvil eval` assertions. */
  onCall?: (event: ProxyCallEvent) => void;
  /** Suppress the per-call stderr line (the log file, if configured, is still written). */
  quiet?: boolean;
  /** Receives upstream stderr; defaults to forwarding it with a prefix. */
  onUpstreamStderr?: (chunk: string) => void;
  /** Reported by anvil_proxy_info. */
  mode?: 'proxy-stdio' | 'proxy-http' | 'eval';
}

function stageFor(code: string | null | undefined): ProxyCallLog['stage'] {
  if (!code) return 'ok';
  if (code === 'tool_input_invalid' || code === 'unknown_tool') return 'input';
  if (code.startsWith('adapter_lookup')) return 'lookup';
  if (code.startsWith('adapter_')) return 'adapter';
  return 'upstream';
}

function createSink(config: ResolvedProxyConfig['log'], options: ProxyRuntimeOptions): (event: ProxyCallEvent) => void {
  let ready: Promise<void> | null = config.file ? mkdir(dirname(config.file), { recursive: true }).then(() => undefined) : null;
  return (event) => {
    const line = JSON.stringify(event.log);
    if (!options.quiet) process.stderr.write(`[anvil-proxy] ${line}\n`);
    if (config.file && ready) {
      const file = config.file;
      ready = ready.then(() => appendFile(file, `${line}\n`, 'utf8')).catch((error) => {
        process.stderr.write(`[anvil-proxy] could not write log file: ${errorMessage(error)}\n`);
      });
    }
    options.onCall?.(event);
  };
}

function shaped(result: UpstreamCallResult, shape: OutputShape | undefined): { result: UpstreamCallResult; upstreamChars: number; resultChars: number } {
  const upstreamChars = resultChars(result);
  const out = shapeResult(result, shape);
  return { result: out.result, upstreamChars, resultChars: resultChars(out.result) };
}

function toMcpTool(entry: CatalogEntry, upstream: Upstream, catalog: ProxyCatalog, config: ResolvedProxyConfig, emit: (event: ProxyCallEvent) => void): McpTool {
  const includeArgs = config.log.includeArguments;
  const base = (args: Record<string, unknown>) => ({
    ts: new Date().toISOString(),
    event: 'anvil_proxy_call' as const,
    tool: entry.name,
    ...(includeArgs ? { arguments: args } : {}),
  });

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
        let raw: UpstreamCallResult;
        try {
          raw = await upstream.callTool(entry.upstreamName, args);
        } catch (error) {
          const log: ProxyCallLog = {
            ...base(args),
            kind: 'passthrough',
            target: entry.upstreamName,
            ok: false,
            stage: 'upstream',
            errorCode: 'upstream_call_failed',
            error: errorMessage(error),
            durationMs: Date.now() - started,
            underlyingCalls: 1,
            lookupMatches: null,
            lookup: null,
            originalCall: { tool: entry.upstreamName, ...(includeArgs ? { input: args } : {}) },
            resultChars: null,
            upstreamChars: null,
          };
          const result = textResult({ ok: false, error: `${entry.upstreamName} failed: ${errorMessage(error)}` }, true) as unknown as UpstreamCallResult;
          emit({ log, arguments: args, compiledInput: args, result });
          return result as Record<string, unknown>;
        }
        const parsed = toExecResult(raw);
        const out = shaped(raw, entry.output);
        const log: ProxyCallLog = {
          ...base(args),
          kind: 'passthrough',
          target: entry.upstreamName,
          ok: parsed.ok,
          stage: parsed.ok ? 'ok' : 'upstream',
          errorCode: parsed.ok ? null : 'upstream_tool_error',
          error: parsed.ok ? null : (parsed.error?.message ?? null),
          durationMs: Date.now() - started,
          underlyingCalls: 1,
          lookupMatches: null,
          lookup: null,
          originalCall: { tool: entry.upstreamName, ...(includeArgs ? { input: args } : {}) },
          resultChars: out.resultChars,
          upstreamChars: out.upstreamChars,
        };
        emit({ log, arguments: args, compiledInput: args, result: out.result });
        return out.result as Record<string, unknown>;
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
      let result: UpstreamCallResult;
      let sizes: { upstreamChars: number | null; resultChars: number | null } = { upstreamChars: null, resultChars: null };
      if (execution.targetResult) {
        const out = shaped(execution.targetResult, entry.spec.output);
        result = out.result;
        sizes = out;
      } else {
        const details = execution.result.error?.details as { candidates?: unknown[] } | undefined;
        result = textResult(
          {
            ok: false,
            error: execution.result.error?.message ?? 'The adapted call failed before reaching the upstream tool. Nothing was changed.',
            ...(details?.candidates && details.candidates.length > 0 ? { candidates: details.candidates } : {}),
          },
          true,
        ) as unknown as UpstreamCallResult;
      }
      const reachedTarget = execution.targetResult !== null || execution.result.error?.code === 'upstream_call_failed';
      const log: ProxyCallLog = {
        ...base(args),
        kind: 'adapted',
        target: entry.spec.target,
        ok: execution.ok,
        stage: execution.ok ? 'ok' : stageFor(code),
        errorCode: code,
        error: execution.ok ? null : (execution.result.error?.message ?? null),
        durationMs: Date.now() - started,
        underlyingCalls: execution.underlyingCalls,
        lookupMatches: execution.lookup ? execution.lookup.matchCount : null,
        lookup: execution.lookup ? { tool: execution.lookup.tool, matchedId: execution.lookup.matchedId, matchCount: execution.lookup.matchCount } : null,
        originalCall: reachedTarget ? { tool: entry.spec.target, ...(includeArgs ? { input: execution.compiled.input } : {}) } : null,
        ...sizes,
      };
      emit({ log, arguments: args, compiledInput: execution.compiled.input, result });
      return result as Record<string, unknown>;
    },
  };
}

function infoTool(runtime: { upstream: Upstream; catalog: ProxyCatalog; config: ResolvedProxyConfig; mode: string }): McpTool {
  const { upstream, catalog, config } = runtime;
  return {
    name: 'anvil_proxy_info',
    description: 'What this Anvil proxy is doing: the adapter, which tools are exposed (adapted or passed through) and which upstream tools are hidden. Does not call the upstream.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler() {
      return {
        appVersion: APP_VERSION,
        mode: runtime.mode,
        upstream: { name: upstream.serverName, version: upstream.serverVersion, source: upstream.describe },
        adapter: config.adapter
          ? { domain: config.adapter.domain, version: config.adapter.version, schema: config.adapter.schema, hash: hashJson(config.adapter), limits: config.adapter.limits }
          : null,
        exposed: catalog.entries.map((entry) => ({ name: entry.name, kind: entry.kind, target: entry.kind === 'adapted' ? entry.spec.target : entry.upstreamName })),
        hidden: catalog.hidden,
        upstreamTools: upstream.tools.map((tool) => ({
          name: tool.name,
          readOnly: tool.annotations?.readOnlyHint ?? null,
          destructive: tool.annotations?.destructiveHint ?? null,
        })),
        note: 'Adapted calls compile to exactly one original call (plus one read-only lookup where declared). Outputs are returned as the upstream sent them unless an output shape is configured.',
      };
    },
  };
}

/** Connect to the upstream, validate the adapter against its live schemas and build the exposed catalog. */
export async function startProxyRuntime(config: ResolvedProxyConfig, options: ProxyRuntimeOptions = {}): Promise<ProxyRuntime> {
  const upstream = await connectUpstream(config.upstream, { timeoutMs: options.timeoutMs, onStderr: options.onUpstreamStderr });
  let catalog: ProxyCatalog;
  try {
    catalog = buildProxyCatalog(upstream.tools, config);
  } catch (error) {
    await upstream.close();
    throw error;
  }
  const emit = createSink(config.log, options);
  const tools = catalog.entries.map((entry) => toMcpTool(entry, upstream, catalog, config, emit));
  if (config.tools.infoTool) tools.push(infoTool({ upstream, catalog, config, mode: options.mode ?? 'proxy-stdio' }));
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
  if (!options.quiet) {
    for (const warning of catalog.warnings) process.stderr.write(`[anvil-proxy] warning: ${warning}\n`);
    process.stderr.write(
      `[anvil-proxy] upstream ${upstream.serverName ?? '?'} ${upstream.serverVersion ?? ''} (${upstream.describe}): ${upstream.tools.length} tools; ` +
        `exposing ${catalog.entries.length} (${adapted} adapted, ${catalog.entries.length - adapted} passthrough, ${catalog.hidden.length} hidden)` +
        `${config.adapter ? `; adapter ${config.adapter.domain}@${config.adapter.version} ${hashJson(config.adapter).slice(0, 12)}` : ''}\n`,
    );
  }
  const onUnknownTool = (name: string, args: Record<string, unknown>) => {
    const hidden = catalog.hidden.find((entry) => entry.name === name);
    const log: ProxyCallLog = {
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
      lookup: null,
      originalCall: null,
      resultChars: null,
      upstreamChars: null,
      ...(config.log.includeArguments ? { arguments: args } : {}),
    };
    emit({ log, arguments: args, compiledInput: null, result: null });
  };
  return { upstream, catalog, tools, onUnknownTool, serverName, instructions, close: () => upstream.close() };
}

export async function runProxy(config: ResolvedProxyConfig, serve: { http?: HttpServeOptions; timeoutMs?: number } = {}): Promise<void> {
  const runtime = await startProxyRuntime(config, { timeoutMs: serve.timeoutMs, mode: serve.http ? 'proxy-http' : 'proxy-stdio' });
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
