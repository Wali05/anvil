import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { smokeStdioMcp } from '../src/mcp/smoke.js';

const tsxAvailable = existsSync(resolve('node_modules/tsx'));
let dataDir: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'anvil-mcp-test-'));
});

afterAll(async () => {
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

async function withClient<T>(args: string[], run: (client: Client) => Promise<T>): Promise<{ result: T; stderr: string }> {
  let stderr = '';
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', ...args],
    stderr: 'pipe',
    env: { ...process.env, ANVIL_DATA_DIR: dataDir } as Record<string, string>,
  });
  transport.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const client = new Client({ name: 'anvil-vitest-client', version: '0.1.0' }, { capabilities: {} });
  try {
    await client.connect(transport);
    const result = await run(client);
    return { result, stderr };
  } finally {
    await client.close().catch(() => undefined);
  }
}

describe('MCP interoperability', () => {
  it('starts the workbench server over stdio and lists domains', async () => {
    if (!tsxAvailable) return;
    const smoke = await smokeStdioMcp({
      command: process.execPath,
      args: ['--import', 'tsx', resolve('src/mcp/workbench.ts')],
      env: { ANVIL_DATA_DIR: dataDir },
      timeoutMs: 25_000,
      callListDomains: true,
    });
    expect(smoke.error).toBeNull();
    expect(smoke.ok).toBe(true);
    expect(smoke.serverName).toBe('anvil-workbench');
    expect(smoke.tools).toHaveLength(8);
    expect(smoke.tools.map((tool) => tool.name)).toContain('anvil_validate_adapter');
  }, 30_000);

  it('validates an adapter and previews a mapping through MCP', async () => {
    if (!tsxAvailable) return;
    const { result } = await withClient([resolve('src/mcp/workbench.ts')], async (client) => {
      const interfaces = await client.callTool({
        name: 'anvil_list_interfaces',
        arguments: { domain: 'calendar', includeSchemas: false },
      });
      const interfaceText = (interfaces.content as Array<{ type: string; text?: string }>)[0]?.text ?? '{}';
      const parsed = JSON.parse(interfaceText) as { adapter: { hash: string } };
      expect(parsed.adapter.hash).toHaveLength(64);

      const validate = await client.callTool({
        name: 'anvil_preview_mapping',
        arguments: {
          domain: 'calendar',
          tool: 'schedule_event',
          args: { title: 'MCP preview', start: '2026-11-25T09:00', duration_minutes: 30 },
        },
      });
      const text = (validate.content as Array<{ type: string; text?: string }>)[0]?.text ?? '{}';
      const preview = JSON.parse(text) as { ok: boolean; originalCall: { tool: string }; executed: boolean };
      expect(preview.ok).toBe(true);
      expect(preview.originalCall.tool).toBe('calendar_create_event');
      expect(preview.executed).toBe(false);

      const exported = await client.callTool({ name: 'anvil_export_adapter', arguments: { domain: 'calendar' } });
      const exportedText = (exported.content as Array<{ type: string; text?: string }>)[0]?.text ?? '{}';
      const bundle = JSON.parse(exportedText) as { schema: string; adapterHash: string; mcpConfig: { mcpServers: Record<string, unknown> } };
      expect(bundle.schema).toBe('anvil.adapter-bundle/v1');
      expect(bundle.adapterHash).toHaveLength(64);
      expect(Object.keys(bundle.mcpConfig.mcpServers)).toContain('anvil-adapter-calendar');
      return preview;
    });
    expect(result.ok).toBe(true);
  }, 30_000);

  it('starts and reads a bounded simulation through the workbench MCP', async () => {
    if (!tsxAvailable) return;
    const { result } = await withClient([resolve('src/mcp/workbench.ts')], async (client) => {
      const started = await client.callTool({
        name: 'anvil_start_experiment',
        arguments: {
          domain: 'issues',
          split: 'dev',
          mode: 'simulation',
          taskIds: ['iss-dev-close'],
          trialsPerTask: 1,
        },
      });
      const startText = (started.content as Array<{ type: string; text?: string }>)[0]?.text ?? '{}';
      const start = JSON.parse(startText) as { runId: string; evidenceClass: string; plannedAttempts: { trials: number } };
      expect(start.evidenceClass).toBe('scripted-simulation');
      expect(start.plannedAttempts.trials).toBe(3);
      type FinishedShape = { status: string; summary: { liveEligible: boolean; byCondition: Record<string, { pass: number }> } };
      let finished: FinishedShape | null = null;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const read = await client.callTool({ name: 'anvil_get_experiment', arguments: { runId: start.runId } });
        const readText = (read.content as Array<{ type: string; text?: string }>)[0]?.text ?? '{}';
        finished = JSON.parse(readText) as FinishedShape;
        if (finished?.status !== 'running') break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }
      expect(finished?.status).toBe('completed');
      expect(finished?.summary.liveEligible).toBe(false);
      return finished;
    });
    expect(result?.summary.byCondition.adapted?.pass).toBe(1);
  }, 30_000);

  it('executes an issued adapter in a separate MCP process and logs the original call', async () => {
    if (!tsxAvailable) return;
    const { result, stderr } = await withClient(
      [resolve('src/mcp/adapterServer.ts'), '--domain', 'issues', '--adapter', 'default'],
      async (client) => {
        const tools = await client.listTools();
        const names = tools.tools.map((tool) => tool.name);
        expect(names).toContain('close_issue');
        expect(names).toContain('search_issues');
        expect(names).toContain('anvil_fixture_state');

        const closed = await client.callTool({
          name: 'close_issue',
          arguments: { repo: 'acme/orbit', number: 8, resolution: 'fixed' },
        });
        const closedText = (closed.content as Array<{ type: string; text?: string }>)[0]?.text ?? '{}';
        const issue = JSON.parse(closedText) as { state?: string; resolution?: string; number?: number };
        expect(issue.number).toBe(8);
        expect(issue.state).toBe('closed');
        expect(issue.resolution).toBe('fixed');

        const found = await client.callTool({
          name: 'search_issues',
          arguments: { repo: 'acme/orbit', status: 'closed', label: 'security' },
        });
        const foundText = (found.content as Array<{ type: string; text?: string }>)[0]?.text ?? '{}';
        const search = JSON.parse(foundText) as { items: Array<{ number: number }> };
        expect(search.items.some((item) => item.number === 8)).toBe(true);
        return search.items;
      },
    );
    expect(result.length).toBeGreaterThan(0);
    const logs = stderr
      .split(/\r?\n/)
      .filter((line) => line.startsWith('[anvil-adapter] {'))
      .map((line) => JSON.parse(line.slice('[anvil-adapter] '.length)) as { originalCall?: { tool?: string; input?: { changes?: { resolution?: string } } } });
    expect(logs[0]?.originalCall?.tool).toBe('issues_update');
    expect(logs[0]?.originalCall?.input?.changes?.resolution).toBe('fixed');
    expect(logs[1]?.originalCall?.tool).toBe('issues_search');
  }, 30_000);
});