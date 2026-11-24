import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { validateAgainstSchema } from '../core/schema.js';
import { errorMessage } from '../core/errors.js';

export interface McpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  /** Skip local input validation (e.g. passthrough tools, which the upstream validates itself). */
  skipValidation?: boolean;
  /** Returns a value that is serialized as JSON text. Throw to report a tool error. */
  handler?(args: Record<string, unknown>): Promise<unknown> | unknown;
  /** Returns a complete MCP `tools/call` result, forwarded as is (content, structuredContent, isError). */
  rawHandler?(args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface McpTextResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export function textResult(value: unknown, isError = false): McpTextResult {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

export interface McpServerDefinition {
  name: string;
  version: string;
  instructions?: string;
  tools: McpTool[];
  /** Called when a client asks for a tool that is not in the catalog (e.g. one the proxy hides). */
  onUnknownTool?(name: string, args: Record<string, unknown>): void;
}

/** Build an official-SDK server for a fixed tool catalog. It never writes to stdout itself. */
export function createMcpServer(input: McpServerDefinition): Server {
  const server = new Server(
    { name: input.name, version: input.version },
    {
      capabilities: { tools: {} },
      ...(input.instructions ? { instructions: input.instructions } : {}),
    },
  );
  const byName = new Map(input.tools.map((tool) => [tool.name, tool]));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: input.tools.map((tool) => ({
      name: tool.name,
      ...(tool.title ? { title: tool.title } : {}),
      description: tool.description,
      inputSchema: tool.inputSchema as { type: 'object'; [key: string]: unknown },
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema as { type: 'object'; [key: string]: unknown } } : {}),
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<any> => {
    const tool = byName.get(request.params.name);
    if (!tool) {
      input.onUnknownTool?.(request.params.name, (request.params.arguments ?? {}) as Record<string, unknown>);
      return textResult({ ok: false, error: `Unknown tool "${request.params.name}". Available: ${input.tools.map((entry) => entry.name).join(', ')}.` }, true);
    }
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    if (!tool.skipValidation) {
      const validation = validateAgainstSchema(tool.inputSchema, args);
      if (!validation.ok) {
        return textResult({ ok: false, error: `Invalid arguments for ${tool.name}: ${validation.errors.join('; ')}` }, true);
      }
    }
    try {
      if (tool.rawHandler) return await tool.rawHandler(args);
      const value = await tool.handler?.(args);
      return textResult(value ?? null);
    } catch (error) {
      process.stderr.write(`[anvil-mcp] tool ${tool.name} failed: ${errorMessage(error)}\n`);
      return textResult({ ok: false, error: errorMessage(error) }, true);
    }
  });
  return server;
}

function waitForShutdown(): Promise<void> {
  return new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
    // The client closing our stdin is the stdio shutdown signal.
    process.stdin.once('end', resolve);
  });
}

/** Serve over stdio. Protocol on stdout, diagnostics on stderr only. */
export async function serveStdioMcp(input: McpServerDefinition): Promise<void> {
  const server = createMcpServer(input);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[anvil-mcp] ${input.name} ready on stdio (${input.tools.length} tools)\n`);
  await waitForShutdown();
  await server.close();
}

export interface HttpServeOptions {
  port: number;
  host?: string;
  /** Path the MCP endpoint is mounted at. */
  path?: string;
  /** When set, every request must carry `Authorization: Bearer <token>`. */
  bearerToken?: string;
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header || !header.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 4 * 1024 * 1024) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text.length > 0 ? JSON.parse(text) : undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Serve over Streamable HTTP in stateless mode: each POST gets a fresh server
 * and transport, so there is no session state to leak between clients.
 * Binds to loopback by default with DNS-rebinding protection; refuse to bind a
 * public interface without a bearer token.
 */
export async function serveHttpMcp(input: McpServerDefinition, options: HttpServeOptions): Promise<{ url: string; close(): Promise<void> }> {
  const host = options.host ?? '127.0.0.1';
  const path = options.path ?? '/mcp';
  if (!isLoopback(host) && !options.bearerToken) {
    throw new Error(`Refusing to serve on ${host} without a bearer token. Set ANVIL_HTTP_TOKEN or bind to 127.0.0.1.`);
  }
  const allowedHosts = isLoopback(host) ? [`127.0.0.1:${options.port}`, `localhost:${options.port}`, `[::1]:${options.port}`] : undefined;

  const http = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/healthz') {
        sendJson(res, 200, { ok: true, name: input.name, tools: input.tools.length });
        return;
      }
      if (url.pathname !== path) {
        sendJson(res, 404, { ok: false, error: `MCP endpoint is ${path}` });
        return;
      }
      if (options.bearerToken && !tokenMatches(req.headers.authorization, options.bearerToken)) {
        sendJson(res, 401, { jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
        return;
      }
      if (req.method !== 'POST') {
        // Stateless mode has no server-initiated stream and no sessions to delete.
        sendJson(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
        return;
      }
      const body = await readJsonBody(req);
      const server = createMcpServer(input);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
        ...(allowedHosts ? { enableDnsRebindingProtection: true, allowedHosts } : {}),
      });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      process.stderr.write(`[anvil-mcp] http request failed: ${errorMessage(error)}\n`);
      if (!res.headersSent) sendJson(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  });

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port, host, () => resolve());
  });
  const address = http.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  const url = `http://${host.includes(':') ? `[${host}]` : host}:${port}${path}`;
  process.stderr.write(`[anvil-mcp] ${input.name} ready on ${url} (${input.tools.length} tools)\n`);
  return {
    url,
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
  };
}

/** Serve over stdio, or over HTTP when `http` is given, until a shutdown signal. */
export async function serveMcp(input: McpServerDefinition, http?: HttpServeOptions): Promise<void> {
  if (!http) {
    await serveStdioMcp(input);
    return;
  }
  const running = await serveHttpMcp(input, http);
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  await running.close();
}

export function objectSchema(properties: Record<string, unknown>, required?: string[]): Record<string, unknown> {
  return {
    type: 'object',
    properties,
    ...(required && required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

export function textSummary(value: unknown, max = 20_000): string {
  const text = JSON.stringify(value, null, 2) ?? 'null';
  return text.length > max ? `${text.slice(0, max)}\n… truncated` : text;
}
