/**
 * `anvil-mcp-proxy`: the original stdio proxy entry point, kept for its flags.
 *
 *   anvil-mcp-proxy --sample
 *   anvil-mcp-proxy --upstream-command node --upstream-arg ./my-server.js --adapter-file adapter.json
 *
 * It runs on the same engine as `anvil proxy` (src/proxy) with the settings
 * this entry point always had: adapted tools only, the anvil_proxy_info tool,
 * and call logs on stderr that include the arguments and the compiled call.
 * `anvil proxy` adds passthrough tools, filters, HTTP, config files and more.
 */
import { resolve, isAbsolute } from 'node:path';
import { loadProjectEnv } from '../core/env.js';
import { loadAdapterFile, type ResolvedProxyConfig } from '../proxy/config.js';
import { runProxy } from '../proxy/server.js';
import { sampleAdapterPath, sampleUpstreamSpec } from '../proxy/sample.js';

export interface ProxyServerOptions {
  upstreamCommand: string;
  upstreamArgs: string[];
  adapterFile: string;
  /** True when the packaged sample upstream and/or adapter filled in missing flags. */
  sample?: boolean;
}

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
    const value = argv[index + 1];
    if (key === 'upstream-arg') {
      if (value === undefined) throw new Error('--upstream-arg needs a value');
      upstreamArgs.push(value);
      index += 1;
      continue;
    }
    if (value && !value.startsWith('--')) {
      flags[key] = value;
      index += 1;
    } else if (key === 'adapter-file' || key === 'upstream-command') {
      throw new Error(`--${key} needs a value`);
    } else {
      flags[key] = 'true';
    }
  }

  let upstreamCommand = flags['upstream-command'];
  if (sample && !upstreamCommand) {
    const spec = sampleUpstreamSpec();
    upstreamCommand = spec.command;
    upstreamArgs.push(...spec.args);
  }
  let adapterFile = flags['adapter-file'];
  if (sample && !adapterFile) adapterFile = sampleAdapterPath();
  if (!upstreamCommand) throw new Error('--upstream-command is required (or pass --sample)');
  if (!adapterFile) throw new Error('--adapter-file is required (or pass --sample)');
  return {
    upstreamCommand,
    upstreamArgs,
    adapterFile: isAbsolute(adapterFile) ? adapterFile : resolve(process.cwd(), adapterFile),
    sample,
  };
}

export async function proxyConfigFromLegacyOptions(options: ProxyServerOptions): Promise<ResolvedProxyConfig> {
  const adapter = await loadAdapterFile(options.adapterFile);
  return {
    name: `anvil-proxy-${adapter.domain}`,
    upstream: { kind: 'stdio', command: options.upstreamCommand, args: options.upstreamArgs },
    adapter,
    adapterPath: options.adapterFile,
    tools: { passthrough: 'none', include: [], exclude: [], keepTargets: false, infoTool: true, overrides: {} },
    log: { file: null, includeArguments: true },
  };
}

export async function runProxyServer(options: ProxyServerOptions): Promise<void> {
  loadProjectEnv();
  await runProxy(await proxyConfigFromLegacyOptions(options));
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && /proxyServer\.(js|ts)$/.test(process.argv[1].replace(/\\/g, '/'));
if (invokedDirectly) {
  try {
    await runProxyServer(parseProxyServerArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`[anvil-proxy] failed to start: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
