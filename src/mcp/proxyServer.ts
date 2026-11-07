import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AdapterSpec } from '../core/types.js';
import { parseAdapterSpec } from '../core/adapter.js';
import { hashJson } from '../core/util.js';
import { APP_VERSION } from '../core/version.js';
import { loadProjectEnv } from '../core/env.js';
import { serveStdioMcp, type McpTool } from './common.js';
import { connectUpstreamStdio, type UpstreamMcpClient } from './upstreamClient.js';
import { buildProxyPublicTools, executeProxyAdaptedCall, validateProxyAdapter } from './proxyExecute.js';

export interface ProxyServerOptions {
  upstreamCommand: string;
  upstreamArgs: string[];
  adapterFile: string;
  /** When true, use the packaged sample upstream if upstream flags are omitted. */
  sample?: boolean;
}

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function parseProxyServerArgs(argv: string[]): ProxyServerOptions {
  const flags: Record<string, string> = {};
  const upstreamArgs: string[] = [];
  let sample = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === '--sample') {
      sample = true;
      continue;
    }
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    if (key === 'upstream-arg') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error('--upstream-arg needs a value');
      upstreamArgs.push(value);
      index += 1;
      continue;
    }
    if (key === 'adapter-file' || key === 'upstream-command') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`--${key} needs a value`);
      flags[key] = value;
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

  if (sample && !flags['upstream-command']) {
    const distEntry = resolve(packageRoot, 'dist/mcp/sampleUpstream.js');
    const srcEntry = resolve(packageRoot, 'src/mcp/sampleUpstream.ts');
    flags['upstream-command'] = process.execPath;
    if (existsSync(distEntry)) {
      upstreamArgs.push(distEntry);
    } else if (existsSync(srcEntry)) {
      upstreamArgs.push('--import', 'tsx', srcEntry);
    } else {
      throw new Error(
        'Could not find sample upstream (dist/mcp/sampleUpstream.js or src/mcp/sampleUpstream.ts). Run npm run build:server.',
      );
    }
  }

  if (sample && !flags['adapter-file']) {
    flags['adapter-file'] = resolve(packageRoot, 'docs/examples/proxy-sample-adapter.json');
  }

  const upstreamCommand = flags['upstream-command'];
  const adapterFile = flags['adapter-file'];
  if (!upstreamCommand) throw new Error('--upstream-command is required (or pass --sample)');
  if (!adapterFile) throw new Error('--adapter-file is required (or pass --sample)');

  return {
    upstreamCommand,
    upstreamArgs,
    adapterFile: isAbsolute(adapterFile) ? adapterFile : resolve(process.cwd(), adapterFile),
    sample,
  };
}

async function loadAdapterFile(path: string): Promise<AdapterSpec> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read adapter file ${path}: ${(error as Error).message}`);
  }
  if (parsed && typeof parsed === 'object' && (parsed as { schema?: unknown }).schema === 'anvil.adapter-bundle/v1') {
    parsed = (parsed as { adapter?: unknown }).adapter;
  }
  const result = parseAdapterSpec(parsed);
  if (!result.ok || !result.spec) {
    const issues = result.issues
      .filter((issue) => issue.severity === 'error')
      .map((issue) => `${issue.path}: ${issue.message}`);
    throw new Error(`Adapter file is invalid: ${issues.join('; ') || 'unknown parse error'}`);
  }
  return result.spec;
}

export async function runProxyServer(options: ProxyServerOptions): Promise<void> {
  loadProjectEnv();
  const adapter = await loadAdapterFile(options.adapterFile);
  process.stderr.write(
    `[anvil-proxy] connecting upstream: ${options.upstreamCommand} ${options.upstreamArgs
      .map((arg) => JSON.stringify(arg))
      .join(' ')}\n`,
  );

  let upstream: UpstreamMcpClient | null = null;
  try {
    upstream = await connectUpstreamStdio({
      command: options.upstreamCommand,
      args: options.upstreamArgs,
      stderrPrefix: '[anvil-proxy-upstream]',
    });
  } catch (error) {
    throw new Error(`Failed to connect to upstream MCP: ${(error as Error).message}`);
  }

  const validation = validateProxyAdapter(adapter, upstream.toolSchemas, upstream.readOnlyTools);
  if (!validation.ok) {
    await upstream.close();
    const issues = validation.issues
      .filter((issue) => issue.severity === 'error')
      .map((issue) => `${issue.path}: ${issue.message}`);
    throw new Error(`Adapter failed validation against upstream tools: ${issues.join('; ')}`);
  }

  const publicTools = buildProxyPublicTools(adapter, upstream.tools);
  const adaptedByName = new Map(adapter.tools.map((tool) => [tool.name, tool]));
  const adapterHash = hashJson(adapter);
  const upstreamRef = upstream;

  const utilities: McpTool[] = [
    {
      name: 'anvil_proxy_info',
      description:
        'Anvil MCP proxy metadata: adapter domain/version/hash, upstream tool names, and honesty notes. Does not call the upstream.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler() {
        return {
          appVersion: APP_VERSION,
          mode: 'proxy-stdio',
          adapter: {
            domain: adapter.domain,
            version: adapter.version,
            schema: adapter.schema,
            hash: adapterHash,
            limits: adapter.limits,
          },
          publicTools: publicTools.map((tool) => tool.name),
          upstreamTools: upstreamRef.tools.map((tool) => ({
            name: tool.name,
            readOnly: tool.annotations.readOnlyHint,
            destructive: tool.annotations.destructiveHint,
          })),
          note:
            'This proxy adapts a user-owned upstream MCP over local stdio. It does not hold OAuth credentials for Alan marketplace plugins, does not remap outputs, and is not a hosted HTTPS MCP.',
        };
      },
    },
  ];

  const exposed: McpTool[] = [
    ...publicTools.map((toolDef) => ({
      name: toolDef.name,
      description: toolDef.description,
      inputSchema: toolDef.inputSchema as unknown as Record<string, unknown>,
      annotations: {
        readOnlyHint: toolDef.annotations.readOnlyHint,
        destructiveHint: toolDef.annotations.destructiveHint,
      },
      async handler(args: Record<string, unknown>) {
        const adapted = adaptedByName.get(toolDef.name);
        if (!adapted) throw new Error(`No adapter mapping for "${toolDef.name}".`);
        const started = Date.now();
        const execution = await executeProxyAdaptedCall({ tool: adapted, args, upstream: upstreamRef });
        const log = {
          event: 'anvil_proxy_tool_call',
          publicTool: toolDef.name,
          proposedInput: args,
          originalCall:
            execution.compilation && execution.compilation.input !== null && execution.compilation.input !== undefined
              ? { tool: execution.compilation.target, input: execution.compilation.input }
              : null,
          lookup: execution.lookup
            ? {
                tool: execution.lookup.tool,
                input: execution.lookup.input,
                matchedId: execution.lookup.matchedId,
                matchCount: execution.lookup.matchCount,
              }
            : null,
          underlyingCalls: execution.underlyingCalls,
          mappingNotes: execution.compilation?.notes ?? [],
          ok: execution.result.ok,
          error: execution.result.error ?? null,
          durationMs: Date.now() - started,
        };
        process.stderr.write(`[anvil-proxy] ${JSON.stringify(log)}\n`);
        if (!execution.result.ok) {
          throw new Error(execution.result.error ?? 'Upstream tool call failed.');
        }
        return execution.result.content;
      },
    })),
    ...utilities,
  ];

  const shutdown = async () => {
    if (upstream) {
      await upstream.close().catch(() => undefined);
      upstream = null;
    }
  };
  process.once('SIGINT', () => {
    void shutdown();
  });
  process.once('SIGTERM', () => {
    void shutdown();
  });

  try {
    await serveStdioMcp({
      name: `anvil-proxy-${adapter.domain}`,
      version: adapter.version,
      instructions:
        'Anvil MCP proxy: adapted public tools compile to original calls on a user-owned upstream MCP over stdio. Every compiled original call is logged to stderr.',
      tools: exposed,
    });
  } finally {
    await shutdown();
  }
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && /proxyServer\.(js|ts)$/.test(process.argv[1].replace(/\\/g, '/'));
if (invokedDirectly) {
  try {
    const options = parseProxyServerArgs(process.argv.slice(2));
    await runProxyServer(options);
  } catch (error) {
    process.stderr.write(`[anvil-proxy] failed to start: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
