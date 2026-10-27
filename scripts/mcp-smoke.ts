import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const cli = resolve('dist/cli.js');
if (!existsSync(cli)) {
  console.error('dist/cli.js is missing. Run npm run build first.');
  process.exit(1);
}

const tmp = await mkdtemp(join(tmpdir(), 'anvil-mcp-'));
const dataDir = join(tmp, 'data');
const bundlePath = join(tmp, 'calendar-bundle.json');
let stderr = '';
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [cli, 'mcp', '--domain', 'calendar', '--adapter', 'file', '--adapter-file', bundlePath, '--data-dir', dataDir],
  stderr: 'pipe',
  env: { ...process.env, ANVIL_DATA_DIR: dataDir } as Record<string, string>,
});
transport.stderr?.on('data', (chunk: Buffer) => {
  stderr += chunk.toString();
});
const client = new Client({ name: 'anvil-export-smoke', version: '0.1.0' }, { capabilities: {} });
let exitCode = 0;
try {
  // Export through the real CLI first so the server consumes the exported artifact.
  const { execFile } = await import('node:child_process');
  await new Promise<void>((resolveRun, reject) => {
    execFile(process.execPath, [cli, 'export', '--domain', 'calendar', '--kind', 'bundle', '--out', bundlePath], (error, stdout, stderrText) => {
      if (error) reject(new Error(`${error.message}\n${stderrText}`));
      else {
        process.stdout.write(stdout);
        resolveRun();
      }
    });
  });
  const bundle = JSON.parse(await readFile(bundlePath, 'utf8')) as { schema: string; adapterHash: string };
  if (bundle.schema !== 'anvil.adapter-bundle/v1') throw new Error('exported bundle schema is wrong');

  await client.connect(transport);
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();
  console.log('tools:', names.join(', '));
  for (const required of ['schedule_event', 'find_events', 'update_event', 'cancel_event', 'anvil_adapter_info', 'anvil_fixture_state']) {
    if (!names.includes(required)) throw new Error(`missing exported tool ${required}`);
  }

  const info = await client.callTool({ name: 'anvil_adapter_info', arguments: {} });
  const infoText = (info.content as Array<{ type: string; text?: string }>)[0]?.text ?? '{}';
  const infoValue = JSON.parse(infoText) as { condition?: string; adapterHash?: string };
  if (infoValue.condition !== 'adapted') throw new Error('exported server is not in adapted condition');
  if (infoValue.adapterHash !== bundle.adapterHash) throw new Error('adapter hash mismatch between bundle and executor');

  const created = await client.callTool({
    name: 'schedule_event',
    arguments: {
      title: 'Export smoke sync',
      start: '2026-12-01T10:00',
      duration_minutes: 45,
      attendees: ['sam@acme.test'],
      location: 'Room 4B',
    },
  });
  const createdText = (created.content as Array<{ type: string; text?: string }>)[0]?.text ?? '{}';
  const createdEvent = JSON.parse(createdText) as { id?: string; summary?: string; start?: { dateTime?: string }; end?: { dateTime?: string } };
  if (!createdEvent.id) throw new Error(`adapted create returned no id: ${createdText}`);
  if (createdEvent.start?.dateTime !== '2026-12-01T10:00:00+05:30') throw new Error('start mapping failed');
  if (createdEvent.end?.dateTime !== '2026-12-01T10:45:00+05:30') throw new Error('duration mapping failed');

  const found = await client.callTool({
    name: 'find_events',
    arguments: { from: '2026-12-01T00:00', to: '2026-12-02T00:00' },
  });
  const foundText = (found.content as Array<{ type: string; text?: string }>)[0]?.text ?? '{}';
  const foundValue = JSON.parse(foundText) as { items?: Array<{ id?: string; summary?: string }> };
  if (!foundValue.items?.some((item) => item.id === createdEvent.id && item.summary === 'Export smoke sync')) {
    throw new Error('created event not visible through the exported find_events tool');
  }

  // v2 lookup through the exported bundle: target by title + date, no id from the client.
  const cancelled = await client.callTool({
    name: 'cancel_event',
    arguments: { title: 'Export smoke sync', date: '2026-12-01' },
  });
  if (cancelled.isError) throw new Error(`lookup cancel failed: ${JSON.stringify(cancelled.content)}`);
  const ambiguous = await client.callTool({
    name: 'cancel_event',
    arguments: { title: 'Design sync', date: '2026-12-02' },
  });
  const ambiguousText = JSON.stringify(ambiguous.content);
  if (!ambiguous.isError || !ambiguousText.includes('evt_1016') || !ambiguousText.includes('evt_1017')) {
    throw new Error(`ambiguous lookup must fail with both candidates: ${ambiguousText}`);
  }

  const logs = stderr
    .split(/\r?\n/)
    .filter((line) => line.startsWith('[anvil-adapter] {'))
    .map((line) => JSON.parse(line.slice('[anvil-adapter] '.length)) as {
      publicTool?: string;
      originalCall?: { tool?: string; input?: Record<string, unknown> } | null;
      lookup?: { tool?: string; matchedId?: string | null; matchCount?: number } | null;
      underlyingCalls?: number;
    });
  if (logs.length < 4) throw new Error(`expected at least 4 tool logs, got ${logs.length}`);
  const cancelLog = logs[2];
  if (cancelLog?.lookup?.tool !== 'calendar_list_events' || cancelLog.lookup.matchedId !== createdEvent.id || cancelLog.underlyingCalls !== 2) {
    throw new Error(`lookup cancel log is wrong: ${JSON.stringify(cancelLog)}`);
  }
  if (cancelLog.originalCall?.tool !== 'calendar_delete_event') throw new Error('lookup cancel did not call calendar_delete_event');
  if (logs[3]?.lookup?.matchCount !== 2 || logs[3]?.underlyingCalls !== 1 || logs[3]?.originalCall !== null) {
    throw new Error('ambiguous lookup should log 2 matches, 1 call and no original target call');
  }
  if (logs[0]?.originalCall?.tool !== 'calendar_create_event') throw new Error('first original call was not calendar_create_event');
  if (logs[1]?.originalCall?.tool !== 'calendar_list_events') throw new Error('second original call was not calendar_list_events');
  const originalStart = (logs[0]?.originalCall?.input as { event?: { start?: { dateTime?: string } } } | undefined)?.event?.start?.dateTime;
  if (originalStart !== '2026-12-01T10:00:00+05:30') throw new Error('logged original call does not contain the compiled input');

  console.log(JSON.stringify({
    ok: true,
    bundleSchema: bundle.schema,
    adapterHash: bundle.adapterHash,
    exportedTools: names.length,
    createdEventId: createdEvent.id,
    loggedOriginalCalls: logs.map((entry) => entry.originalCall?.tool),
    lookupCancel: { matchedId: cancelLog.lookup?.matchedId, underlyingCalls: cancelLog.underlyingCalls },
    bundlePath,
  }, null, 2));
} catch (error) {
  exitCode = 1;
  console.error(`MCP export smoke failed: ${(error as Error).message}`);
  if (stderr) console.error(stderr.slice(-2000));
} finally {
  await client.close().catch(() => undefined);
  await rm(tmp, { recursive: true, force: true });
}
process.exit(exitCode);