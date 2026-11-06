import type { AdapterArgMapping, AdapterSpec, AdaptedToolSpec, JsonSchemaProperty } from '../core/types.js';
import { makeAdapterSpec, validateAdapter, MAX_ADAPTER_TOOLS } from '../core/adapter.js';
import { isPlainObject } from '../core/util.js';
import { normalizeUpstreamSchema } from './schema.js';
import { globMatch } from './config.js';
import type { UpstreamTool } from './upstream.js';

export interface ScaffoldResult {
  adapter: AdapterSpec | null;
  /** One line per upstream tool: what was generated or why it was skipped. */
  notes: string[];
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_FLAT_FIELDS = 30;

export function toSnakeCase(name: string): string {
  const snake = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  const safe = /^[a-z]/.test(snake) ? snake : `t_${snake}`;
  return safe.slice(0, 64);
}

function slug(value: string): string {
  const out = value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  return /^[a-z][a-z0-9_-]{1,31}$/.test(out) ? out : 'upstream';
}

/** Convert one upstream property into the adapter's input-schema subset, or explain why not. */
function toAdapterProperty(node: unknown, depth = 0): { ok: true; property: JsonSchemaProperty } | { ok: false; reason: string } {
  if (!isPlainObject(node)) return { ok: false, reason: 'not a schema object' };
  if (depth > 4) return { ok: false, reason: 'nested too deeply' };
  const description = typeof node.description === 'string' ? node.description : undefined;
  const type = node.type ?? (Array.isArray(node.enum) && node.enum.every((value) => typeof value === 'string') ? 'string' : undefined);
  if (type === 'string') {
    const out: Record<string, unknown> = { type: 'string' };
    if (description) out.description = description;
    if (Array.isArray(node.enum) && node.enum.every((value) => typeof value === 'string')) out.enum = node.enum;
    for (const key of ['format', 'pattern', 'minLength', 'maxLength'] as const) if (node[key] !== undefined) out[key] = node[key];
    return { ok: true, property: out as JsonSchemaProperty };
  }
  if (type === 'integer' || type === 'number') {
    const out: Record<string, unknown> = { type };
    if (description) out.description = description;
    for (const key of ['minimum', 'maximum'] as const) if (typeof node[key] === 'number') out[key] = node[key];
    if (Array.isArray(node.enum) && node.enum.every((value) => typeof value === 'number')) out.enum = node.enum;
    // A hidden maximum is a classic failure; say it out loud.
    if (typeof node.maximum === 'number' && !(description ?? '').includes(String(node.maximum))) {
      out.description = `${description ? `${description} ` : ''}(max ${node.maximum})`;
    }
    return { ok: true, property: out as JsonSchemaProperty };
  }
  if (type === 'boolean') return { ok: true, property: { type: 'boolean', ...(description ? { description } : {}) } };
  if (type === 'array') {
    const items = toAdapterProperty(node.items ?? {}, depth + 1);
    if (!items.ok) return { ok: false, reason: `array items: ${items.reason}` };
    const out: Record<string, unknown> = { type: 'array', items: items.property };
    if (description) out.description = description;
    for (const key of ['minItems', 'maxItems'] as const) if (typeof node[key] === 'number') out[key] = node[key];
    return { ok: true, property: out as JsonSchemaProperty };
  }
  if (type === 'object') {
    const properties: Record<string, JsonSchemaProperty> = {};
    const source = isPlainObject(node.properties) ? node.properties : {};
    for (const [key, child] of Object.entries(source)) {
      if (!IDENTIFIER.test(key)) return { ok: false, reason: `property "${key}" is not an identifier` };
      const converted = toAdapterProperty(child, depth + 1);
      if (!converted.ok) return converted;
      properties[key] = converted.property;
    }
    const out: Record<string, unknown> = { type: 'object', properties };
    if (description) out.description = description;
    if (Array.isArray(node.required)) out.required = (node.required as string[]).filter((key) => key in properties);
    out.additionalProperties = Object.keys(properties).length === 0;
    return { ok: true, property: out as JsonSchemaProperty };
  }
  return { ok: false, reason: type === undefined ? 'no type (union or free-form)' : `type ${JSON.stringify(type)} is not supported` };
}

interface FlatLeaf {
  path: string[];
  required: boolean;
  schema: Record<string, unknown>;
}

function flatten(schema: Record<string, unknown>, prefix: string[], required: boolean, depth: number, out: FlatLeaf[]): string | null {
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const requiredKeys = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  for (const [key, child] of Object.entries(properties)) {
    if (!IDENTIFIER.test(key)) return `property "${[...prefix, key].join('.')}" is not an identifier`;
    if (!isPlainObject(child)) continue;
    const childRequired = required && requiredKeys.has(key);
    const isObject = child.type === 'object' && isPlainObject(child.properties) && Object.keys(child.properties).length > 0;
    if (isObject && depth < 4) {
      const problem = flatten(child, [...prefix, key], childRequired, depth + 1, out);
      if (problem) return problem;
    } else {
      out.push({ path: [...prefix, key], required: childRequired, schema: child });
    }
  }
  return null;
}

/** Shortest unique snake_case names: the leaf name, or more of its path when leaves collide. */
function flatNames(leaves: FlatLeaf[]): string[] {
  const names = leaves.map((leaf) => toSnakeCase(leaf.path[leaf.path.length - 1]!));
  for (let width = 2; width <= 5; width += 1) {
    const counts = new Map<string, number>();
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
    let collided = false;
    leaves.forEach((leaf, index) => {
      if ((counts.get(names[index]!) ?? 0) > 1) {
        collided = true;
        names[index] = toSnakeCase(leaf.path.slice(-width).join('_'));
      }
    });
    if (!collided) break;
  }
  return names;
}

function maxDepth(schema: Record<string, unknown>, depth = 0): number {
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  let max = depth;
  for (const child of Object.values(properties)) {
    if (isPlainObject(child) && child.type === 'object' && isPlainObject(child.properties)) max = Math.max(max, maxDepth(child, depth + 1));
  }
  return max;
}

function scaffoldTool(tool: UpstreamTool): { ok: true; spec: AdaptedToolSpec; note: string } | { ok: false; note: string } {
  const schema = normalizeUpstreamSchema(tool.inputSchema) as unknown as Record<string, unknown>;
  const leaves: FlatLeaf[] = [];
  const problem = flatten(schema, [], true, 0, leaves);
  if (problem) return { ok: false, note: `${tool.name}: skipped, ${problem}` };
  if (leaves.length === 0) return { ok: false, note: `${tool.name}: skipped, it takes no arguments` };
  if (leaves.length > MAX_FLAT_FIELDS) return { ok: false, note: `${tool.name}: skipped, ${leaves.length} fields after flattening (max ${MAX_FLAT_FIELDS}); write this one by hand` };
  const names = flatNames(leaves);
  const properties: Record<string, JsonSchemaProperty> = {};
  const required: string[] = [];
  const mappings: AdapterArgMapping[] = [];
  const dropped: string[] = [];
  leaves.forEach((leaf, index) => {
    const converted = toAdapterProperty(leaf.schema);
    const path = leaf.path.join('.');
    if (!converted.ok) {
      if (leaf.required) dropped.push(`!${path}`);
      else dropped.push(path);
      return;
    }
    const name = names[index]!;
    properties[name] = converted.property;
    if (leaf.required) required.push(name);
    mappings.push({ from: name, to: path, ...(leaf.required ? { required: true } : {}) });
  });
  if (dropped.some((path) => path.startsWith('!'))) {
    return { ok: false, note: `${tool.name}: skipped, required field(s) ${dropped.filter((path) => path.startsWith('!')).map((path) => path.slice(1)).join(', ')} use a shape adapters cannot express` };
  }
  if (mappings.length === 0) return { ok: false, note: `${tool.name}: skipped, no field could be mapped` };
  const name = toSnakeCase(tool.name);
  const description = (tool.description ?? '').trim();
  const spec: AdaptedToolSpec = {
    name,
    description: description.length >= 8 ? description : `Calls ${tool.name} with flat arguments.`,
    inputSchema: { type: 'object', properties, ...(required.length > 0 ? { required } : {}), additionalProperties: false },
    target: tool.name,
    arguments: mappings,
    notes: `Scaffolded from ${tool.name}: ${mappings.length} flat field(s)${dropped.length > 0 ? `; optional field(s) not exposed: ${dropped.join(', ')}` : ''}. Review names and descriptions.`,
  };
  return {
    ok: true,
    spec,
    note: `${tool.name} → ${name}: ${mappings.length} flat field(s)${dropped.length > 0 ? `, ${dropped.length} optional field(s) left out (${dropped.join(', ')})` : ''}`,
  };
}

/**
 * Generate a starter `anvil.adapter/v1` for an upstream server: each selected
 * tool becomes an adapted tool of the same (snake_case) name whose inputs are
 * the leaf fields of its nested schema, mapped back to their original paths.
 * By default only tools with nested object inputs are selected. The result is
 * validated against the upstream schemas; anything that fails is dropped with a
 * note. Lookups, enum maps and date transforms are left for a human to add.
 */
export function scaffoldAdapter(tools: UpstreamTool[], options: { serverName?: string | null; select?: string[]; version?: string } = {}): ScaffoldResult {
  const notes: string[] = [];
  const selected = options.select && options.select.length > 0
    ? tools.filter((tool) => options.select!.some((pattern) => globMatch(pattern, tool.name)))
    : tools.filter((tool) => maxDepth(normalizeUpstreamSchema(tool.inputSchema) as unknown as Record<string, unknown>) >= 1);
  if (selected.length === 0) {
    return {
      adapter: null,
      notes: [options.select?.length ? 'No upstream tool matches --tools.' : 'No upstream tool has nested object inputs; pass --tools to scaffold specific tools.'],
    };
  }
  const specs: AdaptedToolSpec[] = [];
  const taken = new Set<string>();
  for (const tool of selected) {
    if (specs.length >= MAX_ADAPTER_TOOLS) {
      notes.push(`${tool.name}: skipped, the adapter limit is ${MAX_ADAPTER_TOOLS} tools`);
      continue;
    }
    const result = scaffoldTool(tool);
    if (!result.ok) {
      notes.push(result.note);
      continue;
    }
    const otherUpstream = tools.some((other) => other.name !== tool.name && other.name.toLowerCase() === result.spec.name);
    if (taken.has(result.spec.name) || otherUpstream) {
      notes.push(`${tool.name}: skipped, the name ${result.spec.name} is already taken`);
      continue;
    }
    taken.add(result.spec.name);
    specs.push(result.spec);
    notes.push(result.note);
  }
  if (specs.length === 0) return { adapter: null, notes };

  const domain = slug(options.serverName ?? 'upstream');
  let adapter = makeAdapterSpec({
    domain,
    version: options.version ?? '0.1.0',
    description: `Starter adapter for ${options.serverName ?? 'the upstream server'}, scaffolded by Anvil: nested inputs flattened into top-level fields.`,
    tools: specs,
  });
  adapter = { ...adapter, limits: { ...adapter.limits, maxTools: Math.max(specs.length, 1) } };

  const schemas = new Map(tools.map((tool) => [tool.name, normalizeUpstreamSchema(tool.inputSchema)]));
  const validation = validateAdapter(adapter, {
    toolSchemas: schemas,
    rawToolNames: tools.map((tool) => tool.name),
    readOnlyTools: new Set(tools.filter((tool) => tool.annotations?.readOnlyHint === true).map((tool) => tool.name)),
    allowReplacingTarget: true,
  });
  const failing = new Set(
    validation.issues
      .filter((issue) => issue.severity === 'error')
      .map((issue) => /^tools\.([^.]+)/.exec(issue.path)?.[1])
      .filter((name): name is string => Boolean(name)),
  );
  if (failing.size > 0) {
    for (const name of failing) {
      const reasons = validation.issues.filter((issue) => issue.severity === 'error' && issue.path.startsWith(`tools.${name}`)).map((issue) => issue.message);
      notes.push(`${name}: dropped, it failed validation (${reasons.join('; ')})`);
    }
    const kept = adapter.tools.filter((tool) => !failing.has(tool.name));
    if (kept.length === 0) return { adapter: null, notes };
    adapter = { ...adapter, tools: kept, limits: { ...adapter.limits, maxTools: kept.length } };
  }
  return { adapter, notes };
}
