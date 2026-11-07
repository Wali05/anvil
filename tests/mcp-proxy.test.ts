import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parseAdapterSpec, validateAdapter } from '../src/core/adapter.js';
import { readFile } from 'node:fs/promises';
import { buildSampleUpstreamTools, createInitialDeskState } from '../src/mcp/sampleUpstream.js';
import type { JsonSchema } from '../src/core/types.js';

const tsxAvailable = existsSync(resolve('node_modules/tsx'));
const adapterPath = resolve('docs/examples/proxy-sample-adapter.json');
const proxyEntry = resolve('src/mcp/proxyServer.ts');
const sampleEntry = resolve('src/mcp/sampleUpstream.ts');

async function withProxyClient<T>(run: (client: Client) => Promise<T>): Promise<{ result: T; stderr: string }> {
  let stderr = '';
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      '--import',
      'tsx',
      proxyEntry,
      '--upstream-command',
      process.execPath,
      '--upstream-arg',
      '--import',
      '--upstream-arg',
      'tsx',
      '--upstream-arg',
      sampleEntry,
      '--adapter-file',
      adapterPath,
    ],
    stderr: 'pipe',
    env: { ...process.env } as Record<string, string>,
  });
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const client = new Client({ name: 'anvil-proxy-vitest', version: '0.1.0' }, { capabilities: {} });
  try {
    await client.connect(transport);
    const result = await run(client);
    return { result, stderr };
  } finally {
    await client.close().catch(() => undefined);
  }
}

function textOf(result: { content?: unknown; isError?: boolean }): string {
  const parts = (result.content as Array<{ type: string; text?: string }> | undefined) ?? [];
  return parts[0]?.text ?? '{}';
}

describe('MCP proxy mode', () => {
  it('validates the committed sample adapter against the sample upstream schemas', async () => {
    const raw = JSON.parse(await readFile(adapterPath, 'utf8'));
    const parsed = parseAdapterSpec(raw);
    expect(parsed.ok).toBe(true);
    expect(parsed.spec?.domain).toBe('sample-desk');

    const tools = buildSampleUpstreamTools(createInitialDeskState());
    const toolSchemas = new Map(tools.map((tool) => [tool.name, tool.inputSchema as unknown as JsonSchema]));
    const readOnlyTools = new Set(tools.filter((tool) => tool.annotations?.readOnlyHint).map((tool) => tool.name));
    const validation = validateAdapter(parsed.spec!, {
      toolSchemas,
      rawToolNames: [...toolSchemas.keys()],
      readOnlyTools,
    });
    expect(validation.ok, JSON.stringify(validation.issues, null, 2)).toBe(true);
  });

  it('lists adapted tools, opens a ticket, and logs the compiled upstream call', async () => {
    if (!tsxAvailable) return;
    const { result, stderr } = await withProxyClient(async (client) => {
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      expect(names).toContain('list_tickets');
      expect(names).toContain('open_ticket');
      expect(names).toContain('cancel_ticket');
      expect(names).toContain('anvil_proxy_info');
      expect(names).not.toContain('desk_open_ticket');

      const info = await client.callTool({ name: 'anvil_proxy_info', arguments: {} });
      const infoValue = JSON.parse(textOf(info as { content?: unknown })) as {
        mode?: string;
        adapter?: { domain?: string };
        upstreamTools?: Array<{ name: string }>;
      };
      expect(infoValue.mode).toBe('proxy-stdio');
      expect(infoValue.adapter?.domain).toBe('sample-desk');
      expect(infoValue.upstreamTools?.some((tool) => tool.name === 'desk_open_ticket')).toBe(true);

      const opened = await client.callTool({
        name: 'open_ticket',
        arguments: {
          workspace: 'acme',
          title: 'Proxy smoke ticket',
          priority: 'P2',
          assignee_email: 'qa@acme.test',
        },
      });
      const ticket = JSON.parse(textOf(opened as { content?: unknown })) as {
        id?: string;
        title?: string;
        priority?: { level?: string };
        assignee?: { email?: string };
        status?: string;
      };
      expect(ticket.title).toBe('Proxy smoke ticket');
      expect(ticket.priority?.level).toBe('2');
      expect(ticket.assignee?.email).toBe('qa@acme.test');
      expect(ticket.status).toBe('O');
      expect(ticket.id).toMatch(/^T-\d+$/);
      return ticket;
    });
    expect(result.id).toBeTruthy();
    const logs = stderr
      .split(/\r?\n/)
      .filter((line) => line.includes('"event":"anvil_proxy_tool_call"'))
      .map((line) => {
        const start = line.indexOf('{');
        return JSON.parse(line.slice(start)) as {
          publicTool?: string;
          originalCall?: { tool?: string; input?: { ticket?: { priority?: { level?: string } } } };
          ok?: boolean;
        };
      });
    const openLog = logs.find((entry) => entry.publicTool === 'open_ticket');
    expect(openLog?.ok).toBe(true);
    expect(openLog?.originalCall?.tool).toBe('desk_open_ticket');
    expect(openLog?.originalCall?.input?.ticket?.priority?.level).toBe('2');
  }, 45_000);

  it('cancels by title through a lookup and refuses ambiguous same-title cancels', async () => {
    if (!tsxAvailable) return;
    const { result, stderr } = await withProxyClient(async (client) => {
      const canceled = await client.callTool({
        name: 'cancel_ticket',
        arguments: { workspace: 'acme', title: 'Unique billing glitch' },
      });
      const ticket = JSON.parse(textOf(canceled as { content?: unknown })) as { id?: string; status?: string; title?: string };
      expect(ticket.id).toBe('T-1003');
      expect(ticket.status).toBe('C');

      const ambiguous = await client.callTool({
        name: 'cancel_ticket',
        arguments: { workspace: 'acme', title: 'Broken login redirect' },
      });
      const ambiguousText = textOf(ambiguous as { content?: unknown; isError?: boolean });
      expect(ambiguous.isError === true || ambiguousText.includes('Candidates') || ambiguousText.includes('several')).toBe(true);
      return { ticket, ambiguousText };
    });
    expect(result.ticket.id).toBe('T-1003');
    const logs = stderr
      .split(/\r?\n/)
      .filter((line) => line.includes('"event":"anvil_proxy_tool_call"'))
      .map((line) => {
        const start = line.indexOf('{');
        return JSON.parse(line.slice(start)) as {
          publicTool?: string;
          originalCall?: { tool?: string; input?: { ticket_id?: string } };
          lookup?: { tool?: string; matchedId?: string | null; matchCount?: number };
          underlyingCalls?: number;
          ok?: boolean;
        };
      });
    const cancelLog = logs.find((entry) => entry.publicTool === 'cancel_ticket' && entry.ok);
    expect(cancelLog?.lookup?.tool).toBe('desk_list_tickets');
    expect(cancelLog?.lookup?.matchedId).toBe('T-1003');
    expect(cancelLog?.originalCall?.tool).toBe('desk_cancel_ticket');
    expect(cancelLog?.originalCall?.input?.ticket_id).toBe('T-1003');
    expect(cancelLog?.underlyingCalls).toBe(2);

    const ambiguousLog = logs.find((entry) => entry.publicTool === 'cancel_ticket' && entry.ok === false);
    expect(ambiguousLog?.lookup?.matchCount).toBeGreaterThan(1);
    expect(ambiguousLog?.originalCall).toBeNull();
    expect(ambiguousLog?.underlyingCalls).toBe(1);
  }, 45_000);
});
