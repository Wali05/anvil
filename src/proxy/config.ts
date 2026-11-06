import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { AdapterSpec } from '../core/types.js';
import { parseAdapterSpec } from '../core/adapter.js';
import { AnvilError } from '../core/errors.js';
import { isPlainObject } from '../core/util.js';
import { interpolateEnv, interpolateRecord, type UpstreamSpec } from './upstream.js';

/**
 * `anvil.proxy/v1`: everything needed to put Anvil in front of one upstream
 * MCP server. Secrets never belong in this file: reference them as `${VAR}`
 * in `env`, `headers`, `args` or `url` and they are read from the environment
 * at start-up.
 */
export interface ProxyConfig {
  schema: 'anvil.proxy/v1';
  /** Server name reported to the client. Defaults to `anvil-<upstream name>`. */
  name?: string;
  upstream:
    | { command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
    | { url: string; headers?: Record<string, string>; transport?: 'auto' | 'streamable-http' | 'sse' };
  /** An adapter object, or a path to an adapter spec / exported bundle (relative to this file). */
  adapter?: AdapterSpec | string;
  tools?: ProxyToolOptions;
  log?: { file?: string; includeArguments?: boolean };
}

export interface ProxyToolOptions {
  /** `all` (default): expose upstream tools that no adapted tool replaces. `none`: expose adapted tools only. */
  passthrough?: 'all' | 'none';
  /** Upstream tool names (or `*` globs) to expose. Applied to passthrough tools only. */
  include?: string[];
  /** Upstream tool names (or `*` globs) to hide. Wins over `include`. */
  exclude?: string[];
  /** Keep exposing an adapted tool's original target alongside it. Default false: the adapted tool replaces it. */
  keepTargets?: boolean;
  /** Per upstream tool: a clearer public name and/or description. Arguments are untouched; use an adapter for those. */
  overrides?: Record<string, { name?: string; description?: string }>;
}

export interface ResolvedProxyConfig {
  name: string | null;
  upstream: UpstreamSpec;
  adapter: AdapterSpec | null;
  adapterPath: string | null;
  tools: Required<Omit<ProxyToolOptions, 'overrides'>> & { overrides: Record<string, { name?: string; description?: string }> };
  log: { file: string | null; includeArguments: boolean };
}

function stringArray(value: unknown, path: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new AnvilError('proxy_config_invalid', `${path} must be an array of strings.`);
  }
  return value as string[];
}

function stringRecord(value: unknown, path: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value) || Object.values(value).some((entry) => typeof entry !== 'string')) {
    throw new AnvilError('proxy_config_invalid', `${path} must be an object of strings.`);
  }
  return value as Record<string, string>;
}

/** Read an adapter spec, or the `adapter` inside an exported `anvil.adapter-bundle/v1`. */
export async function loadAdapterFile(path: string): Promise<AdapterSpec> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new AnvilError('adapter_file_unreadable', `Could not read adapter file ${path}: ${(error as Error).message}`);
  }
  return parseAdapterObject(parsed, path);
}

export function parseAdapterObject(parsed: unknown, where = 'adapter'): AdapterSpec {
  if (isPlainObject(parsed) && parsed.schema === 'anvil.adapter-bundle/v1') parsed = parsed.adapter;
  const result = parseAdapterSpec(parsed);
  if (!result.ok || !result.spec) {
    const issues = result.issues.filter((issue) => issue.severity === 'error').map((issue) => `  ${issue.path}: ${issue.message}`);
    throw new AnvilError('adapter_invalid', `${where} is not a valid Anvil adapter:\n${issues.join('\n')}`, 400, { issues });
  }
  return result.spec;
}

/** Validate a raw config object and resolve `${VAR}` references and relative paths. */
export async function resolveProxyConfig(raw: unknown, baseDir: string, env: NodeJS.ProcessEnv = process.env): Promise<ResolvedProxyConfig> {
  if (!isPlainObject(raw)) throw new AnvilError('proxy_config_invalid', 'The proxy config must be a JSON object.');
  if (raw.schema !== undefined && raw.schema !== 'anvil.proxy/v1') {
    throw new AnvilError('proxy_config_invalid', 'schema must be "anvil.proxy/v1".');
  }
  const upstreamRaw = raw.upstream;
  if (!isPlainObject(upstreamRaw)) throw new AnvilError('proxy_config_invalid', 'upstream must be an object with `command` or `url`.');
  let upstream: UpstreamSpec;
  if (typeof upstreamRaw.command === 'string' && upstreamRaw.command.length > 0) {
    if (upstreamRaw.url !== undefined) throw new AnvilError('proxy_config_invalid', 'upstream takes `command` or `url`, not both.');
    upstream = {
      kind: 'stdio',
      command: interpolateEnv(upstreamRaw.command, env),
      args: (stringArray(upstreamRaw.args, 'upstream.args') ?? []).map((arg) => interpolateEnv(arg, env)),
      env: interpolateRecord(stringRecord(upstreamRaw.env, 'upstream.env'), env),
      cwd: typeof upstreamRaw.cwd === 'string' ? resolve(baseDir, upstreamRaw.cwd) : undefined,
    };
  } else if (typeof upstreamRaw.url === 'string' && upstreamRaw.url.length > 0) {
    const transport = upstreamRaw.transport ?? 'auto';
    if (transport !== 'auto' && transport !== 'streamable-http' && transport !== 'sse') {
      throw new AnvilError('proxy_config_invalid', 'upstream.transport must be auto, streamable-http or sse.');
    }
    upstream = {
      kind: 'http',
      url: interpolateEnv(upstreamRaw.url, env),
      headers: interpolateRecord(stringRecord(upstreamRaw.headers, 'upstream.headers'), env),
      transport,
    };
  } else {
    throw new AnvilError('proxy_config_invalid', 'upstream needs a `command` (stdio) or a `url` (HTTP).');
  }

  let adapter: AdapterSpec | null = null;
  let adapterPath: string | null = null;
  if (typeof raw.adapter === 'string') {
    adapterPath = isAbsolute(raw.adapter) ? raw.adapter : resolve(baseDir, raw.adapter);
    adapter = await loadAdapterFile(adapterPath);
  } else if (raw.adapter !== undefined) {
    adapter = parseAdapterObject(raw.adapter, 'config.adapter');
  }

  const toolsRaw = raw.tools === undefined ? {} : raw.tools;
  if (!isPlainObject(toolsRaw)) throw new AnvilError('proxy_config_invalid', 'tools must be an object.');
  const passthrough = toolsRaw.passthrough ?? 'all';
  if (passthrough !== 'all' && passthrough !== 'none') throw new AnvilError('proxy_config_invalid', 'tools.passthrough must be "all" or "none".');
  const overrides: Record<string, { name?: string; description?: string }> = {};
  if (toolsRaw.overrides !== undefined) {
    if (!isPlainObject(toolsRaw.overrides)) throw new AnvilError('proxy_config_invalid', 'tools.overrides must be an object keyed by upstream tool name.');
    for (const [tool, override] of Object.entries(toolsRaw.overrides)) {
      if (!isPlainObject(override)) throw new AnvilError('proxy_config_invalid', `tools.overrides.${tool} must be an object.`);
      if (override.name !== undefined && (typeof override.name !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(override.name))) {
        throw new AnvilError('proxy_config_invalid', `tools.overrides.${tool}.name must be a tool name (letters, digits, _ . -).`);
      }
      if (override.description !== undefined && typeof override.description !== 'string') {
        throw new AnvilError('proxy_config_invalid', `tools.overrides.${tool}.description must be a string.`);
      }
      overrides[tool] = { name: override.name as string | undefined, description: override.description as string | undefined };
    }
  }

  const logRaw = raw.log === undefined ? {} : raw.log;
  if (!isPlainObject(logRaw)) throw new AnvilError('proxy_config_invalid', 'log must be an object.');

  return {
    name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : null,
    upstream,
    adapter,
    adapterPath,
    tools: {
      passthrough,
      include: stringArray(toolsRaw.include, 'tools.include') ?? [],
      exclude: stringArray(toolsRaw.exclude, 'tools.exclude') ?? [],
      keepTargets: toolsRaw.keepTargets === true,
      overrides,
    },
    log: {
      file: typeof logRaw.file === 'string' ? resolve(baseDir, interpolateEnv(logRaw.file, env)) : null,
      includeArguments: logRaw.includeArguments === true,
    },
  };
}

export async function loadProxyConfigFile(path: string, env: NodeJS.ProcessEnv = process.env): Promise<ResolvedProxyConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new AnvilError('proxy_config_unreadable', `Could not read proxy config ${path}: ${(error as Error).message}`);
  }
  return resolveProxyConfig(parsed, dirname(resolve(path)), env);
}

/** Match a tool name against `*` globs (e.g. `delete_*`, `*_admin`). */
export function globMatch(pattern: string, name: string): boolean {
  if (!pattern.includes('*')) return pattern === name;
  const regex = new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')).join('.*')}$`);
  return regex.test(name);
}
