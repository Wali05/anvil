import { resolve } from 'node:path';
import type { AdapterSpec, ConditionId, DomainDefinition } from '../core/types.js';
import { Store } from '../core/store.js';
import { requireDomain } from '../domains/index.js';
import { buildConditionInterface, executeConditionTool, type ConditionInterface } from '../core/interfaces.js';
import { getDefaultAdapter } from '../domains/adapters.js';
import { resolveAdapterSpec } from './resolveAdapter.js';
import { hashJson } from '../core/util.js';
import { APP_VERSION } from '../core/version.js';
import { loadProjectEnv } from '../core/env.js';
import { serveStdioMcp, type McpTool } from './common.js';

export interface AdapterServerOptions {
  domain: string;
  condition: ConditionId;
  adapterSource?: 'default' | 'saved' | 'file';
  adapterFile?: string;
  dataDir?: string;
}

export function parseAdapterServerArgs(argv: string[]): AdapterServerOptions {
  const flags: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    if (key === 'adapter-file') {
      const value = argv[index + 1];
      if (!value) throw new Error('--adapter-file needs a path');
      flags['adapter-file'] = value;
      index += 1;
      continue;
    }
    const value = argv[index + 1];
    if (value && !value.startsWith('--')) {
      flags[key] = value;
      index += 1;
    } else {
      flags[key] = 'true';
    }
  }
  const domain = flags.domain;
  if (!domain) throw new Error('--domain is required');
  const condition = (flags.condition ?? 'adapted') as ConditionId;
  if (!['original', 'descriptions', 'adapted'].includes(condition)) {
    throw new Error('--condition must be original, descriptions or adapted');
  }
  const adapterFile = flags['adapter-file'];
  const source = adapterFile ? 'file' : (flags.adapter ?? 'default');
  if (!['default', 'saved', 'file'].includes(source)) throw new Error('--adapter must be default, saved or file');
  return {
    domain,
    condition,
    adapterSource: source as 'default' | 'saved' | 'file',
    adapterFile,
    dataDir: flags['data-dir'],
  };
}

function fixtureUtilities(domain: DomainDefinition, iface: ConditionInterface, state: unknown, adapter: AdapterSpec | null): McpTool[] {
  return [
    {
      name: 'anvil_adapter_info',
      description: 'Anvil adapter executor metadata: domain, condition, interface hash, exposed tools and declared limits. Local fixture only.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler() {
        return {
          appVersion: APP_VERSION,
          domain: domain.id,
          condition: iface.condition,
          interfaceHash: iface.hash,
          adapterHash: adapter ? hashJson(adapter) : null,
          tools: iface.tools.map((tool) => tool.name),
          adapterLimits: adapter?.limits ?? null,
          note: 'This MCP server runs a disposable local fixture. It is not a Google Calendar or GitHub production connector.',
        };
      },
    },
    {
      name: 'anvil_fixture_state',
      description: 'Read the current disposable fixture state so a client can verify an adapted call. Read-only.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler() {
        return { domain: domain.id, state };
      },
    },
  ];
}

export async function runAdapterServer(options: AdapterServerOptions): Promise<void> {
  loadProjectEnv();
  const domain = requireDomain(options.domain);
  const store = new Store(options.dataDir ?? process.env.ANVIL_DATA_DIR ?? '.anvil');
  await store.init();
  let adapter: AdapterSpec | null = null;
  if (options.condition === 'adapted') {
    const source = options.adapterSource ?? 'default';
    if (source === 'default') {
      adapter = getDefaultAdapter(domain.id) ?? null;
    } else if (source === 'saved') {
      adapter = (await store.getSavedAdapter(domain.id))?.spec ?? null;
    }
    if (!adapter && source === 'file') {
      const resolvedAdapter = await resolveAdapterSpec({
        domain: domain.id,
        source: 'file',
        file: options.adapterFile,
        store,
      });
      adapter = resolvedAdapter.spec;
    }
    if (!adapter) {
      throw new Error(`No ${source} adapter is available for ${domain.id}.`);
    }
    const resolved = await resolveAdapterSpec({
      domain: domain.id,
      source: source === 'file' ? 'file' : source,
      file: options.adapterFile,
      store,
    });
    adapter = resolved.spec;
  }
  const iface = buildConditionInterface(domain, options.condition, adapter);
  const state = domain.initialState();
  const now = (state as { now?: string }).now ?? new Date().toISOString();
  const exposed: McpTool[] = [
    ...iface.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as unknown as Record<string, unknown>,
      annotations: {
        readOnlyHint: tool.annotations.readOnlyHint,
        destructiveHint: tool.annotations.destructiveHint,
      },
      handler(args: Record<string, unknown>) {
        const started = Date.now();
        const execution = executeConditionTool({
          iface,
          domain,
          state,
          toolName: tool.name,
          args,
          now,
        });
        const log = {
          event: 'anvil_tool_call',
          domain: domain.id,
          condition: iface.condition,
          publicTool: tool.name,
          proposedInput: args,
          // null when no original target call was made (e.g. a lookup found zero or several matches).
          originalCall: execution.compilation
            ? execution.compilation.input !== null && execution.compilation.input !== undefined
              ? { tool: execution.compilation.target, input: execution.compilation.input }
              : null
            : { tool: tool.name, input: args },
          lookup: execution.lookup
            ? { tool: execution.lookup.tool, input: execution.lookup.input, matchedId: execution.lookup.matchedId, matchCount: execution.lookup.matchCount }
            : null,
          underlyingCalls: execution.underlyingCalls,
          mappingNotes: execution.compilation?.notes ?? [],
          ok: execution.result.ok,
          error: execution.result.error ?? null,
          durationMs: Date.now() - started,
        };
        process.stderr.write(`[anvil-adapter] ${JSON.stringify(log)}\n`);
        if (!execution.result.ok) {
          const candidates = execution.lookup && !execution.lookup.ok && execution.lookup.candidates.length > 0
            ? ` Candidates: ${JSON.stringify(execution.lookup.candidates)}`
            : '';
          const error = new Error(`${execution.result.error?.message ?? 'Tool call failed.'}${candidates}`);
          (error as Error & { code?: string }).code = execution.result.error?.code;
          throw error;
        }
        return execution.result.content;
      },
    })),
    ...fixtureUtilities(domain, iface, state, adapter),
  ];

  await serveStdioMcp({
    name: `anvil-${domain.id}-${options.condition}`,
    version: adapter?.version ?? APP_VERSION,
    instructions:
      'Anvil MCP adapter against a disposable local fixture. Every adapted call is compiled and logged as an original call. No external account is modified.',
    tools: exposed,
  });
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && /adapterServer\.(js|ts)$/.test(process.argv[1].replace(/\\/g, '/'));
if (invokedDirectly) {
  try {
    const options = parseAdapterServerArgs(process.argv.slice(2));
    await runAdapterServer(options);
  } catch (error) {
    process.stderr.write(`[anvil-adapter] failed to start: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}