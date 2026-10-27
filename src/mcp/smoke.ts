import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export interface McpSmokeResult {
  ok: boolean;
  serverName: string | null;
  serverVersion: string | null;
  tools: Array<{ name: string; description: string }>;
  latencyMs: number;
  stderrTail: string;
  error: string | null;
}

export async function smokeStdioMcp(input: {
  command: string;
  args: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
  callListDomains?: boolean;
}): Promise<McpSmokeResult> {
  const started = Date.now();
  const timeoutMs = input.timeoutMs ?? 15_000;
  let stderr = '';
  const transport = new StdioClientTransport({
    command: input.command,
    args: input.args,
    stderr: 'pipe',
    env: { ...process.env, ...input.env } as Record<string, string>,
  });
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
    if (stderr.length > 8000) stderr = stderr.slice(-8000);
  });
  const client = new Client({ name: 'anvil-smoke-client', version: '0.1.0' }, { capabilities: {} });
  let timer: NodeJS.Timeout | null = null;
  try {
    await Promise.race([
      client.connect(transport),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`MCP handshake timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
    const list = await client.listTools();
    if (input.callListDomains) {
      await client.callTool({ name: 'anvil_list_domains', arguments: {} });
    }
    const version = client.getServerVersion();
    return {
      ok: true,
      serverName: version?.name ?? null,
      serverVersion: version?.version ?? null,
      tools: list.tools.map((tool) => ({ name: tool.name, description: tool.description ?? '' })),
      latencyMs: Date.now() - started,
      stderrTail: stderr.slice(-2000),
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      serverName: null,
      serverVersion: null,
      tools: [],
      latencyMs: Date.now() - started,
      stderrTail: stderr.slice(-2000),
      error: (error as Error).message,
    };
  } finally {
    if (timer) clearTimeout(timer);
    await client.close().catch(() => undefined);
  }
}