import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ToolExecResult } from '../core/types.js';
import { AnvilError, errorMessage } from '../core/errors.js';
import { isPlainObject } from '../core/util.js';
import { APP_VERSION } from '../core/version.js';

export type UpstreamSpec =
  | { kind: 'stdio'; command: string; args: string[]; env?: Record<string, string>; cwd?: string }
  | { kind: 'http'; url: string; headers?: Record<string, string>; transport?: 'auto' | 'streamable-http' | 'sse' };

export interface UpstreamTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

/** The MCP `tools/call` result shape, kept verbatim so passthrough is lossless. */
export interface UpstreamCallResult {
  content?: Array<Record<string, unknown>>;
  structuredContent?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

export interface Upstream {
  serverName: string | null;
  serverVersion: string | null;
  instructions: string | null;
  tools: UpstreamTool[];
  /** How the connection was made, without secrets (header values are never included). */
  describe: string;
  callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<UpstreamCallResult>;
  close(): Promise<void>;
}

/**
 * Replace `${VAR}` (and `${VAR:-fallback}`) with environment values so config
 * files can reference tokens without containing them. A missing variable with
 * no fallback is an error rather than a silent empty string.
 */
export function interpolateEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_match, name: string, fallback: string | undefined) => {
    const found = env[name];
    if (found !== undefined && found !== '') return found;
    if (fallback !== undefined) return fallback;
    throw new AnvilError('env_missing', `Environment variable ${name} is referenced but not set.`);
  });
}

export function interpolateRecord(record: Record<string, string> | undefined, env: NodeJS.ProcessEnv = process.env): Record<string, string> | undefined {
  if (!record) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) out[key] = interpolateEnv(value, env);
  return out;
}

export function describeUpstream(spec: UpstreamSpec): string {
  if (spec.kind === 'stdio') return `stdio: ${[spec.command, ...spec.args].join(' ')}`;
  const headerNames = Object.keys(spec.headers ?? {});
  return `http: ${spec.url}${headerNames.length > 0 ? ` (headers: ${headerNames.join(', ')})` : ''}`;
}

/** Parse an MCP call result into the executor's ok/content/error shape. */
export function toExecResult(result: UpstreamCallResult): ToolExecResult {
  const text = (result.content ?? [])
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n');
  let content: unknown = result.structuredContent;
  if (content === undefined) {
    const trimmed = text.trim();
    if (trimmed.length > 0) {
      try {
        content = JSON.parse(trimmed);
      } catch {
        content = text;
      }
    } else {
      content = null;
    }
  }
  if (result.isError) {
    const message = typeof content === 'string' ? content : isPlainObject(content) && typeof content.error === 'string' ? content.error : text || 'The upstream tool returned an error.';
    return { ok: false, error: { code: 'upstream_tool_error', message: message.slice(0, 4000), details: content } };
  }
  return { ok: true, content };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AnvilError('upstream_timeout', `${what} timed out after ${timeoutMs} ms.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function listAllTools(client: Client, timeoutMs: number): Promise<UpstreamTool[]> {
  const tools: UpstreamTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page += 1) {
    const response = await withTimeout(client.listTools(cursor ? { cursor } : undefined), timeoutMs, 'tools/list');
    for (const tool of response.tools) tools.push(tool as UpstreamTool);
    cursor = response.nextCursor;
    if (!cursor) break;
  }
  return tools;
}

export interface ConnectOptions {
  timeoutMs?: number;
  /** Receives upstream stderr (stdio only). Defaults to forwarding it to our stderr with a prefix. */
  onStderr?: (chunk: string) => void;
  clientName?: string;
}

export async function connectUpstream(spec: UpstreamSpec, options: ConnectOptions = {}): Promise<Upstream> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const clientInfo = { name: options.clientName ?? 'anvil-proxy', version: APP_VERSION };

  const attempt = async (transport: Transport): Promise<Client> => {
    const client = new Client(clientInfo, { capabilities: {} });
    await withTimeout(client.connect(transport), timeoutMs, 'Connecting to the upstream MCP server');
    return client;
  };

  let client: Client;
  if (spec.kind === 'stdio') {
    const transport = new StdioClientTransport({
      command: spec.command,
      args: spec.args,
      cwd: spec.cwd,
      stderr: 'pipe',
      env: { ...(process.env as Record<string, string>), ...(spec.env ?? {}) },
    });
    const forward = options.onStderr ?? ((chunk: string) => process.stderr.write(chunk.replace(/^(?=.)/gm, '[upstream] ')));
    transport.stderr?.on('data', (chunk: Buffer) => forward(chunk.toString()));
    try {
      client = await attempt(transport);
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw new AnvilError('upstream_connect_failed', `Could not start the upstream server (${describeUpstream(spec)}): ${errorMessage(error)}`);
    }
  } else {
    let url: URL;
    try {
      url = new URL(spec.url);
    } catch {
      throw new AnvilError('upstream_url_invalid', `"${spec.url}" is not a valid URL.`);
    }
    const requestInit: RequestInit = spec.headers ? { headers: spec.headers } : {};
    const mode = spec.transport ?? 'auto';
    try {
      if (mode === 'sse') {
        client = await attempt(new SSEClientTransport(url, { requestInit }));
      } else {
        try {
          client = await attempt(new StreamableHTTPClientTransport(url, { requestInit }));
        } catch (error) {
          if (mode === 'streamable-http') throw error;
          // Older servers only speak the deprecated HTTP+SSE transport.
          client = await attempt(new SSEClientTransport(url, { requestInit }));
        }
      }
    } catch (error) {
      throw new AnvilError('upstream_connect_failed', `Could not connect to the upstream server (${describeUpstream(spec)}): ${errorMessage(error)}`);
    }
  }

  const version = client.getServerVersion();
  let tools: UpstreamTool[];
  try {
    tools = await listAllTools(client, timeoutMs);
  } catch (error) {
    await client.close().catch(() => undefined);
    throw new AnvilError('upstream_list_failed', `The upstream server did not list its tools: ${errorMessage(error)}`);
  }

  return {
    serverName: version?.name ?? null,
    serverVersion: version?.version ?? null,
    instructions: client.getInstructions() ?? null,
    tools,
    describe: describeUpstream(spec),
    async callTool(name, args, callTimeoutMs) {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: callTimeoutMs ?? timeoutMs });
      return result as UpstreamCallResult;
    },
    async close() {
      await client.close().catch(() => undefined);
    },
  };
}
