import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const distProxy = resolve('dist/mcp/proxyServer.js');
const distSample = resolve('dist/mcp/sampleUpstream.js');
const adapter = resolve('docs/examples/proxy-sample-adapter.json');

if (!existsSync(distProxy) || !existsSync(distSample)) {
  console.error('dist/mcp/proxyServer.js or sampleUpstream.js is missing. Run npm run build:server first.');
  process.exit(1);
}

let stderr = '';
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    distProxy,
    '--upstream-command',
    process.execPath,
    '--upstream-arg',
    distSample,
    '--adapter-file',
    adapter,
  ],
  stderr: 'pipe',
  env: { ...process.env } as Record<string, string>,
});
transport.stderr?.on('data', (chunk: Buffer) => {
  stderr += chunk.toString();
});

const client = new Client({ name: 'anvil-proxy-smoke', version: '0.1.0' }, { capabilities: {} });
let exitCode = 0;
try {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();
  console.log('proxy tools:', names.join(', '));
  for (const required of ['list_tickets', 'open_ticket', 'cancel_ticket', 'anvil_proxy_info']) {
    if (!names.includes(required)) throw new Error(`missing ${required}`);
  }

  const opened = await client.callTool({
    name: 'open_ticket',
    arguments: { workspace: 'acme', title: 'Smoke proxy ticket', priority: 'P1' },
  });
  const openedText = (opened.content as Array<{ type: string; text?: string }>)[0]?.text ?? '{}';
  const ticket = JSON.parse(openedText) as { id?: string; priority?: { level?: string } };
  if (!ticket.id) throw new Error(`open_ticket returned no id: ${openedText}`);
  if (ticket.priority?.level !== '1') throw new Error(`priority mapping failed: ${openedText}`);

  const canceled = await client.callTool({
    name: 'cancel_ticket',
    arguments: { workspace: 'acme', title: 'Unique billing glitch' },
  });
  const canceledText = (canceled.content as Array<{ type: string; text?: string }>)[0]?.text ?? '{}';
  const closed = JSON.parse(canceledText) as { id?: string; status?: string };
  if (closed.id !== 'T-1003' || closed.status !== 'C') throw new Error(`cancel_ticket failed: ${canceledText}`);

  if (!stderr.includes('anvil_proxy_tool_call')) throw new Error('expected proxy stderr logs');
  if (!stderr.includes('desk_open_ticket')) throw new Error('expected compiled desk_open_ticket in stderr');
  if (!stderr.includes('desk_cancel_ticket')) throw new Error('expected compiled desk_cancel_ticket in stderr');

  console.log('proxy smoke ok:', { opened: ticket.id, canceled: closed.id });
} catch (error) {
  exitCode = 1;
  console.error('proxy smoke failed:', (error as Error).message);
  if (stderr) console.error('stderr tail:\n', stderr.slice(-4000));
} finally {
  await client.close().catch(() => undefined);
  process.exit(exitCode);
}
