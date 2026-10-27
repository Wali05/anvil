import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { validateAgainstSchema } from '../core/schema.js';
import { errorMessage } from '../core/errors.js';

export interface McpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  handler(args: Record<string, unknown>): Promise<unknown> | unknown;
}

export interface McpTextResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

function textResult(value: unknown, isError = false): McpTextResult {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * Minimal official-SDK stdio server. It never writes protocol output to
 * stdout itself; diagnostics go to stderr only.
 */
export async function serveStdioMcp(input: {
  name: string;
  version: string;
  instructions?: string;
  tools: McpTool[];
}): Promise<void> {
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
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<any> => {
    const tool = byName.get(request.params.name);
    if (!tool) {
      return textResult({ ok: false, error: `Unknown tool "${request.params.name}".` }, true);
    }
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const validation = validateAgainstSchema(tool.inputSchema, args);
    if (!validation.ok) {
      return textResult({ ok: false, error: `Invalid arguments: ${validation.errors.join('; ')}` }, true);
    }
    try {
      const value = await tool.handler(args);
      return textResult(value);
    } catch (error) {
      process.stderr.write(`[anvil-mcp] tool ${tool.name} failed: ${errorMessage(error)}\n`);
      return textResult({ ok: false, error: errorMessage(error) }, true);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[anvil-mcp] ${input.name} ready on stdio (${input.tools.length} tools)\n`);
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  await server.close();
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