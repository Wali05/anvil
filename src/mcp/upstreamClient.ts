import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { JsonSchema } from '../core/types.js';

export interface UpstreamToolInfo {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean };
}

export interface UpstreamCallResult {
  ok: boolean;
  content?: unknown;
  error?: string;
  isError?: boolean;
  rawText?: string;
}

export interface UpstreamMcpClient {
  tools: UpstreamToolInfo[];
  toolSchemas: Map<string, JsonSchema>;
  readOnlyTools: Set<string>;
  callTool(name: string, args: Record<string, unknown>): Promise<UpstreamCallResult>;
  close(): Promise<void>;
}

function asJsonSchema(raw: unknown, toolName: string): JsonSchema {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Upstream tool "${toolName}" is missing an object inputSchema.`);
  }
  const schema = raw as JsonSchema;
  if (schema.type !== 'object' || !schema.properties || typeof schema.properties !== 'object') {
    throw new Error(`Upstream tool "${toolName}" inputSchema must be a JSON Schema object with properties.`);
  }
  return schema;
}

function parseToolContent(result: {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}): UpstreamCallResult {
  const textParts = (result.content ?? [])
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string);
  const rawText = textParts.join('\n');
  if (result.isError) {
    let message = rawText || 'Upstream tool returned an error.';
    try {
      const parsed = JSON.parse(rawText) as { error?: string; ok?: boolean };
      if (typeof parsed.error === 'string') message = parsed.error;
    } catch {
      // keep raw text
    }
    return { ok: false, error: message, isError: true, rawText };
  }
  if (!rawText) return { ok: true, content: null, rawText: '' };
  try {
    return { ok: true, content: JSON.parse(rawText), rawText };
  } catch {
    return { ok: true, content: rawText, rawText };
  }
}

/**
 * Connect to an upstream MCP server over stdio (spawn a child process).
 * Diagnostics from the child are forwarded to stderr with a prefix; they never
 * touch the proxy's own stdout (MCP protocol).
 */
export async function connectUpstreamStdio(input: {
  command: string;
  args: string[];
  env?: Record<string, string>;
  stderrPrefix?: string;
}): Promise<UpstreamMcpClient> {
  let stderr = '';
  const prefix = input.stderrPrefix ?? '[anvil-proxy-upstream]';
  const transport = new StdioClientTransport({
    command: input.command,
    args: input.args,
    stderr: 'pipe',
    env: { ...process.env, ...input.env } as Record<string, string>,
  });
  transport.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    stderr += text;
    for (const line of text.split(/\r?\n/)) {
      if (line.length > 0) process.stderr.write(`${prefix} ${line}\n`);
    }
  });
  const client = new Client({ name: 'anvil-proxy-upstream-client', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);
  const listed = await client.listTools();
  const tools: UpstreamToolInfo[] = listed.tools.map((tool) => {
    const annotations = (tool.annotations ?? {}) as { readOnlyHint?: boolean; destructiveHint?: boolean };
    return {
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: asJsonSchema(tool.inputSchema, tool.name),
      annotations: {
        readOnlyHint: annotations.readOnlyHint === true,
        destructiveHint: annotations.destructiveHint === true,
      },
    };
  });
  const toolSchemas = new Map(tools.map((tool) => [tool.name, tool.inputSchema]));
  const readOnlyTools = new Set(tools.filter((tool) => tool.annotations.readOnlyHint).map((tool) => tool.name));
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  return {
    tools,
    toolSchemas,
    readOnlyTools,
    async callTool(name: string, args: Record<string, unknown>): Promise<UpstreamCallResult> {
      if (!byName.has(name)) {
        return { ok: false, error: `Upstream has no tool named "${name}".` };
      }
      try {
        const result = await client.callTool({ name, arguments: args });
        return parseToolContent(result as { content?: Array<{ type: string; text?: string }>; isError?: boolean });
      } catch (error) {
        return { ok: false, error: (error as Error).message };
      }
    },
    async close() {
      await client.close().catch(() => undefined);
      if (stderr.length > 16_000) {
        // keep stderr buffer from growing unbounded across long sessions
      }
    },
  };
}
