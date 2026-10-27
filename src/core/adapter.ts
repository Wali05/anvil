import type {
  AdapterArgMapping,
  AdapterIssue,
  AdapterLookupSpec,
  AdapterSpec,
  AdapterTransform,
  AdapterValidation,
  AdaptedToolSpec,
  JsonSchema,
  JsonSchemaProperty,
  JsonValue,
  ToolDefinition,
} from './types.js';
import { hashJson, isPlainObject, isUnsafeKey, readPath, splitPath, stableStringify, writePath } from './util.js';
import { resolveSchemaPath, validateAdapterInputSchema, validateAgainstSchema, propertyKind } from './schema.js';

const ADAPTER_NAME = /^[a-z][a-z0-9_]{1,63}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const OFFSET = /^[+-](\d{2}):(\d{2})$/;
const MAX_MAPPINGS = 40;

export interface AdapterParseResult {
  ok: boolean;
  issues: AdapterIssue[];
  spec?: AdapterSpec;
}

export function parseAdapterSpec(raw: unknown): AdapterParseResult {
  const issues: AdapterIssue[] = [];
  if (!isPlainObject(raw)) {
    return { ok: false, issues: [{ path: '$', message: 'adapter must be a JSON object', severity: 'error' }] };
  }
  const spec = raw as unknown as AdapterSpec;
  const isV2 = spec.schema === 'anvil.adapter/v2';
  if (spec.schema !== 'anvil.adapter/v1' && !isV2) {
    issues.push({ path: '$.schema', message: 'must be "anvil.adapter/v1" or "anvil.adapter/v2"', severity: 'error' });
  }
  const declaresLookup = Array.isArray(spec.tools) && spec.tools.some((tool) => isPlainObject(tool) && tool.lookup !== undefined);
  if (typeof spec.domain !== 'string' || !/^[a-z][a-z0-9_-]{1,31}$/.test(spec.domain)) {
    issues.push({ path: '$.domain', message: 'must be a lowercase domain id', severity: 'error' });
  }
  if (typeof spec.version !== 'string' || spec.version.length === 0 || spec.version.length > 40) {
    issues.push({ path: '$.version', message: 'must be a non-empty version string (max 40 chars)', severity: 'error' });
  }
  if (typeof spec.description !== 'string' || spec.description.trim().length < 8) {
    issues.push({ path: '$.description', message: 'must describe the adapter (min 8 chars)', severity: 'error' });
  }
  if (!isPlainObject(spec.limits)) {
    issues.push({ path: '$.limits', message: 'must be an object', severity: 'error' });
  } else {
    if (!isV2) {
      if (spec.limits.oneToOne !== true) issues.push({ path: '$.limits.oneToOne', message: 'must be true in v1; use anvil.adapter/v2 for lookup', severity: 'error' });
      if (spec.limits.maxUnderlyingCallsPerInvocation !== 1) {
        issues.push({ path: '$.limits.maxUnderlyingCallsPerInvocation', message: 'must be 1 in v1', severity: 'error' });
      }
      if (declaresLookup) issues.push({ path: '$.tools', message: 'lookup requires schema "anvil.adapter/v2"', severity: 'error' });
    } else {
      const expectedMax = declaresLookup ? 2 : 1;
      if (spec.limits.maxUnderlyingCallsPerInvocation !== expectedMax) {
        issues.push({
          path: '$.limits.maxUnderlyingCallsPerInvocation',
          message: `must be ${expectedMax} (${declaresLookup ? 'one lookup + one target call' : 'no tool declares a lookup'})`,
          severity: 'error',
        });
      }
      if (spec.limits.oneToOne !== !declaresLookup) {
        issues.push({ path: '$.limits.oneToOne', message: `must be ${!declaresLookup} for this adapter`, severity: 'error' });
      }
    }
    if (!Number.isInteger(spec.limits.maxTools) || spec.limits.maxTools < 1 || spec.limits.maxTools > 12) {
      issues.push({ path: '$.limits.maxTools', message: 'must be an integer between 1 and 12', severity: 'error' });
    }
  }
  if (!Array.isArray(spec.tools)) {
    issues.push({ path: '$.tools', message: 'must be an array', severity: 'error' });
    return { ok: false, issues };
  }
  if (spec.tools.length === 0) issues.push({ path: '$.tools', message: 'must contain at least one tool', severity: 'error' });
  const maxTools = isPlainObject(spec.limits) && typeof spec.limits.maxTools === 'number' ? spec.limits.maxTools : 12;
  if (spec.tools.length > maxTools) {
    issues.push({ path: '$.tools', message: `declares ${spec.tools.length} tools but limits.maxTools is ${maxTools}`, severity: 'error' });
  }
  const seen = new Set<string>();
  spec.tools.forEach((tool, index) => {
    if (!isPlainObject(tool)) {
      issues.push({ path: `$.tools[${index}]`, message: 'must be an object', severity: 'error' });
      return;
    }
    const name = tool.name;
    if (typeof name !== 'string' || !ADAPTER_NAME.test(name)) {
      issues.push({ path: `$.tools[${index}].name`, message: 'must match ^[a-z][a-z0-9_]{1,63}$', severity: 'error' });
    } else if (seen.has(name.toLowerCase())) {
      issues.push({ path: `$.tools[${index}].name`, message: `duplicate tool name "${name}"`, severity: 'error' });
    } else {
      seen.add(name.toLowerCase());
    }
    if (typeof tool.description !== 'string' || tool.description.trim().length < 8) {
      issues.push({ path: `$.tools[${index}].description`, message: 'must be at least 8 characters', severity: 'error' });
    }
    if (typeof tool.target !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{1,63}$/.test(tool.target)) {
      issues.push({ path: `$.tools[${index}].target`, message: 'must be an original tool name', severity: 'error' });
    }
    const schemaCheck = validateAdapterInputSchema(tool.inputSchema, `$.tools[${index}].inputSchema`);
    for (const message of schemaCheck.errors) issues.push({ path: `$.tools[${index}].inputSchema`, message, severity: 'error' });
    if (!Array.isArray(tool.arguments)) {
      issues.push({ path: `$.tools[${index}].arguments`, message: 'must be an array', severity: 'error' });
    } else if (tool.arguments.length === 0) {
      issues.push({ path: `$.tools[${index}].arguments`, message: 'must contain at least one mapping', severity: 'error' });
    } else if (tool.arguments.length > MAX_MAPPINGS) {
      issues.push({ path: `$.tools[${index}].arguments`, message: `supports at most ${MAX_MAPPINGS} mappings`, severity: 'error' });
    }
    if (tool.lookup !== undefined) issues.push(...parseLookupShape(tool.lookup, `$.tools[${index}].lookup`));
  });
  return { ok: issues.every((issue) => issue.severity !== 'error'), issues, spec };
}

const MAX_LOOKUP_MATCHES = 4;
const MAX_LOOKUP_DISPLAY = 6;
const MAX_CANDIDATES_SHOWN = 10;

function parseLookupShape(lookup: unknown, at: string): AdapterIssue[] {
  const issues: AdapterIssue[] = [];
  if (!isPlainObject(lookup)) return [{ path: at, message: 'must be an object', severity: 'error' }];
  const spec = lookup as unknown as AdapterLookupSpec;
  if (typeof spec.tool !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{1,63}$/.test(spec.tool)) {
    issues.push({ path: `${at}.tool`, message: 'must be an original tool name', severity: 'error' });
  }
  if (!Array.isArray(spec.arguments) || spec.arguments.length === 0 || spec.arguments.length > MAX_MAPPINGS) {
    issues.push({ path: `${at}.arguments`, message: `must contain 1-${MAX_MAPPINGS} mappings`, severity: 'error' });
  }
  for (const key of ['resultsPath', 'idField', 'bindTo'] as const) {
    const value = spec[key];
    if (typeof value !== 'string' || !adapterPathIsSafe(value)) {
      issues.push({ path: `${at}.${key}`, message: 'must be a safe dot path', severity: 'error' });
    }
  }
  if (!Array.isArray(spec.match) || spec.match.length === 0 || spec.match.length > MAX_LOOKUP_MATCHES) {
    issues.push({ path: `${at}.match`, message: `must contain 1-${MAX_LOOKUP_MATCHES} equality filters`, severity: 'error' });
  } else {
    spec.match.forEach((rule, index) => {
      if (!isPlainObject(rule) || typeof rule.field !== 'string' || !adapterPathIsSafe(rule.field) || typeof rule.from !== 'string' || !adapterPathIsSafe(rule.from)) {
        issues.push({ path: `${at}.match[${index}]`, message: 'needs safe `field` and `from` paths', severity: 'error' });
      }
    });
  }
  if (!Array.isArray(spec.display) || spec.display.length === 0 || spec.display.length > MAX_LOOKUP_DISPLAY) {
    issues.push({ path: `${at}.display`, message: `must list 1-${MAX_LOOKUP_DISPLAY} item fields`, severity: 'error' });
  } else if (spec.display.some((field) => typeof field !== 'string' || !adapterPathIsSafe(field))) {
    issues.push({ path: `${at}.display`, message: 'every display field must be a safe dot path', severity: 'error' });
  }
  return issues;
}

export interface CompileOptions {
  /** Original tool schemas, used to validate the compiled call. */
  toolSchemas: Map<string, JsonSchema>;
  rawToolNames: string[];
  /** Original tools that are read-only; a v2 lookup may only call one of these. */
  readOnlyTools?: Set<string>;
}

/** Runtime context for compiling the target call of a lookup tool. */
export interface CompileContext {
  matchedItem?: unknown;
  bind?: { path: string; value: unknown };
}

export interface CompiledCall {
  ok: boolean;
  target: string | null;
  input: Record<string, unknown> | null;
  errors: AdapterIssue[];
  notes: string[];
}

export function validateAdapter(spec: AdapterSpec, options: CompileOptions): AdapterValidation {
  const issues: AdapterIssue[] = [];
  const rawNames = new Map(options.rawToolNames.map((name) => [name.toLowerCase(), name]));
  const targets: Record<string, number> = {};
  const adapterNames = new Set<string>();
  const toolByName = new Map<string, AdaptedToolSpec>();

  for (const tool of spec.tools) {
    if (adapterNames.has(tool.name.toLowerCase())) {
      issues.push({ path: `tools.${tool.name}.name`, message: `duplicate public tool name "${tool.name}"`, severity: 'error' });
    }
    adapterNames.add(tool.name.toLowerCase());
    if (rawNames.has(tool.name.toLowerCase())) {
      issues.push({
        path: `tools.${tool.name}.name`,
        message: `"${tool.name}" collides with an original tool name; public names must be unambiguous`,
        severity: 'error',
      });
    }
    const rawName = rawNames.get(tool.target.toLowerCase());
    if (!rawName) {
      issues.push({ path: `tools.${tool.name}.target`, message: `target "${tool.target}" is not an original tool`, severity: 'error' });
    } else {
      targets[rawName] = (targets[rawName] ?? 0) + 1;
      if (tool.target !== rawName) {
        issues.push({ path: `tools.${tool.name}.target`, message: `target name is case-sensitive: use "${rawName}"`, severity: 'error' });
      }
    }
    toolByName.set(tool.name, tool);
    const targetSchema = rawName ? options.toolSchemas.get(rawName) : undefined;
    const lookupConsumed = new Set<string>();
    const lookupIssues = tool.lookup ? validateLookup(tool, options, rawNames, targetSchema, lookupConsumed) : [];
    issues.push(...lookupIssues);
    const pathIssues = validateMappings(tool, targetSchema, {
      extraConsumed: lookupConsumed,
      extraProduced: tool.lookup ? [tool.lookup.bindTo] : [],
    });
    issues.push(...pathIssues);
    if ([...pathIssues, ...lookupIssues].every((issue) => issue.severity !== 'error')) {
      const sample = buildSampleInput(tool.inputSchema);
      if (tool.lookup) {
        const lookupCompiled = compileLookupCall(tool, sample, options.toolSchemas);
        for (const error of lookupCompiled.errors) issues.push({ ...error, path: `tools.${tool.name}.lookup.${error.path}` });
      }
      const context = tool.lookup ? sampleLookupContext(tool) : undefined;
      const compiled = compileToOriginal(tool, sample, options, context);
      for (const error of compiled.errors) issues.push(error);
    }
  }

  const errors = issues.filter((issue) => issue.severity === 'error');
  return {
    ok: errors.length === 0,
    issues,
    toolCount: spec.tools.length,
    targets,
    interfaceHash: hashJson(spec),
  };
}

function validateLookup(
  tool: AdaptedToolSpec,
  options: CompileOptions,
  rawNames: Map<string, string>,
  targetSchema: JsonSchema | undefined,
  consumedOut: Set<string>,
): AdapterIssue[] {
  const lookup = tool.lookup!;
  const base = `tools.${tool.name}.lookup`;
  const issues: AdapterIssue[] = [];
  const rawName = rawNames.get(lookup.tool.toLowerCase());
  if (!rawName || rawName !== lookup.tool) {
    issues.push({ path: `${base}.tool`, message: `lookup tool "${lookup.tool}" is not an original tool name`, severity: 'error' });
    return issues;
  }
  if (lookup.tool === tool.target) {
    issues.push({ path: `${base}.tool`, message: 'the lookup tool must differ from the target tool', severity: 'error' });
  }
  if (!options.readOnlyTools) {
    issues.push({ path: `${base}.tool`, message: 'cannot verify that the lookup tool is read-only', severity: 'error' });
  } else if (!options.readOnlyTools.has(lookup.tool)) {
    issues.push({ path: `${base}.tool`, message: `lookup tool "${lookup.tool}" is not read-only; a lookup may never write`, severity: 'error' });
  }
  const lookupSchema = options.toolSchemas.get(lookup.tool);
  const pseudo: AdaptedToolSpec = {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    target: lookup.tool,
    arguments: lookup.arguments,
  };
  issues.push(
    ...validateMappings(pseudo, lookupSchema, { skipUnconsumed: true, consumedOut, pathPrefix: `${base}` }).map((issue) => ({
      ...issue,
      path: issue.path.replace(`tools.${tool.name}.arguments`, `${base}.arguments`),
    })),
  );
  const declared = new Set(Object.keys(tool.inputSchema.properties ?? {}));
  const requiredInputs = new Set(tool.inputSchema.required ?? []);
  let requiredRules = 0;
  lookup.match.forEach((rule, index) => {
    const root = splitPath(rule.from);
    if (!root.ok || !declared.has(root.segments[0]!)) {
      issues.push({ path: `${base}.match[${index}].from`, message: `"${rule.from}" is not a declared adapted input`, severity: 'error' });
      return;
    }
    consumedOut.add(root.segments[0]!);
    if (requiredInputs.has(root.segments[0]!)) requiredRules += 1;
    if (rule.compare !== undefined && rule.compare !== 'exact' && rule.compare !== 'localTime') {
      issues.push({ path: `${base}.match[${index}].compare`, message: 'must be "exact" or "localTime"', severity: 'error' });
    }
    if (rule.compare === 'localTime') {
      const prop = tool.inputSchema.properties[root.segments[0]!];
      if (prop?.type !== 'string' || typeof prop.pattern !== 'string') {
        issues.push({ path: `${base}.match[${index}].from`, message: 'localTime inputs must be strings with an HH:MM pattern', severity: 'error' });
      }
    }
  });
  if (lookup.match.length > 0 && requiredRules === 0) {
    issues.push({ path: `${base}.match`, message: 'at least one match rule must use a required input so the target is always explicit', severity: 'error' });
  }
  if (targetSchema) {
    const bind = resolveSchemaPath(targetSchema, lookup.bindTo);
    if (!bind.exists) {
      issues.push({ path: `${base}.bindTo`, message: `"${lookup.bindTo}" does not exist on target ${tool.target}`, severity: 'error' });
    } else if (bind.property?.type !== 'string') {
      issues.push({ path: `${base}.bindTo`, message: 'bindTo must be a string field (an id)', severity: 'error' });
    }
    const conflicting = tool.arguments.find(
      (mapping) => mapping.to === lookup.bindTo || mapping.to.startsWith(`${lookup.bindTo}.`) || lookup.bindTo.startsWith(`${mapping.to}.`),
    );
    if (conflicting) {
      issues.push({ path: `${base}.bindTo`, message: `"${lookup.bindTo}" is also written by a mapping; the matched id must be the only source`, severity: 'error' });
    }
  }
  return issues;
}

function sampleLookupContext(tool: AdaptedToolSpec): CompileContext {
  const item: Record<string, unknown> = {};
  writePath(item, tool.lookup!.idField, 'sample_id');
  for (const mapping of tool.arguments) {
    if (mapping.transform?.kind === 'keepDurationEnd') {
      writePath(item, mapping.transform.itemStart, '2026-11-02T09:00:00+05:30');
      writePath(item, mapping.transform.itemEnd, '2026-11-02T10:00:00+05:30');
    }
  }
  return { matchedItem: item, bind: { path: tool.lookup!.bindTo, value: 'sample_id' } };
}

interface MappingValidationOptions {
  extraConsumed?: Set<string>;
  extraProduced?: string[];
  skipUnconsumed?: boolean;
  consumedOut?: Set<string>;
  pathPrefix?: string;
}

function validateMappings(
  tool: AdaptedToolSpec,
  targetSchema: JsonSchema | undefined,
  opts: MappingValidationOptions = {},
): AdapterIssue[] {
  const issues: AdapterIssue[] = [];
  const base = `tools.${tool.name}`;
  if (!targetSchema) return issues;
  const declared = new Map<string, JsonSchemaProperty>(
    Object.entries(tool.inputSchema.properties ?? {}) as Array<[string, JsonSchemaProperty]>,
  );
  const requiredInputs = new Set(tool.inputSchema.required ?? []);
  const consumed = opts.consumedOut ?? new Set<string>();
  for (const name of opts.extraConsumed ?? []) consumed.add(name);
  const written: string[] = [];
  const rawNames = new Set(targetSchema.properties ? Object.keys(targetSchema.properties) : []);

  for (const [index, mapping] of tool.arguments.entries()) {
    const at = `${base}.arguments[${index}]`;
    if (!isPlainObject(mapping)) {
      issues.push({ path: at, message: 'must be an object', severity: 'error' });
      continue;
    }
    const toSplit = splitPath(mapping.to);
    if (!toSplit.ok) {
      issues.push({ path: `${at}.to`, message: toSplit.reason ?? 'invalid target path', severity: 'error' });
    } else {
      if (rawNames.size > 0 && !rawNames.has(toSplit.segments[0]!)) {
        issues.push({
          path: `${at}.to`,
          message: `"${mapping.to}" does not exist on target ${tool.target}`,
          severity: 'error',
        });
      } else {
        const info = resolveSchemaPath(targetSchema, mapping.to);
        if (!info.exists) {
          issues.push({ path: `${at}.to`, message: info.reason ?? 'target path does not exist', severity: 'error' });
        }
      }
      for (const other of written) {
        if (other === mapping.to || other.startsWith(`${mapping.to}.`) || mapping.to.startsWith(`${other}.`)) {
          issues.push({
            path: `${at}.to`,
            message: `mapping path "${mapping.to}" conflicts with existing mapping "${other}"`,
            severity: 'error',
          });
        }
      }
      written.push(mapping.to);
    }

    const hasFrom = mapping.from !== undefined;
    const hasConst = mapping.const !== undefined;
    const isBuilder = mapping.transform?.kind === 'issueQuery';
    if (hasFrom === hasConst && !isBuilder) {
      issues.push({ path: at, message: 'exactly one of `from` or `const` is required', severity: 'error' });
    }
    if (mapping.from !== undefined) {
      const split = splitPath(mapping.from);
      if (!split.ok) {
        issues.push({ path: `${at}.from`, message: split.reason ?? 'invalid source path', severity: 'error' });
      } else {
        const root = split.segments[0]!;
        if (!declared.has(root)) {
          issues.push({ path: `${at}.from`, message: `"${mapping.from}" is not declared in the adapted input schema`, severity: 'error' });
        }
        consumed.add(root);
      }
    }
    if (mapping.required === true && !hasFrom && !isBuilder) {
      issues.push({ path: `${at}.required`, message: '`required` only applies to `from` mappings', severity: 'warning' });
    }
    if (mapping.valueMap !== undefined) {
      if (!isPlainObject(mapping.valueMap)) {
        issues.push({ path: `${at}.valueMap`, message: 'must be an object', severity: 'error' });
      } else {
        for (const [key, value] of Object.entries(mapping.valueMap)) {
          if (typeof value !== 'string') issues.push({ path: `${at}.valueMap.${key}`, message: 'must map to a string', severity: 'error' });
        }
        if (!mapping.from) issues.push({ path: `${at}.valueMap`, message: 'requires a `from` mapping', severity: 'error' });
      }
    }
    if (mapping.const !== undefined && mapping.const === null) {
      issues.push({ path: `${at}.const`, message: 'null constants are not supported', severity: 'error' });
    }
    if (mapping.const !== undefined && hasUnsafeObjectKeys(mapping.const)) {
      issues.push({ path: `${at}.const`, message: 'constants may not contain unsafe object keys', severity: 'error' });
    }
    if (mapping.default !== undefined && hasUnsafeObjectKeys(mapping.default)) {
      issues.push({ path: `${at}.default`, message: 'defaults may not contain unsafe object keys', severity: 'error' });
    }
    if (mapping.default !== undefined && !hasFrom) {
      issues.push({ path: `${at}.default`, message: 'requires a `from` mapping', severity: 'error' });
    }
    issues.push(...validateTransform(mapping, `${at}.transform`, tool, targetSchema, declared, consumed, requiredInputs));

    // Required target path must be satisfied traceably.
    if (toSplit.ok && targetSchema) {
      const info = resolveSchemaPath(targetSchema, mapping.to);
      if (info.required) {
        const fromOptional = mapping.from !== undefined && !requiredInputs.has(mapping.from.split('.')[0]!) && mapping.required !== true;
        const transformFills =
          (mapping.transform?.kind === 'durationEnd' || mapping.transform?.kind === 'keepDurationEnd') && mapping.from !== undefined;
        if (!hasConst && !transformFills && mapping.default === undefined && fromOptional) {
          issues.push({
            path: at,
            message: `target "${mapping.to}" is required but is mapped from optional input "${mapping.from}"; set required:true, a default, or const`,
            severity: 'error',
          });
        }
      }
      if (info.property?.type === 'string' && mapping.const !== undefined && typeof mapping.const !== 'string') {
        issues.push({ path: `${at}.const`, message: 'target field is a string', severity: 'error' });
      }
    }
  }

  for (const name of declared.keys()) {
    if (opts.skipUnconsumed) break;
    if (!consumed.has(name)) {
      issues.push({
        path: `${base}.inputSchema.properties.${name}`,
        message: `input "${name}" is declared but never mapped; remove it or map it`,
        severity: 'error',
      });
    }
  }
  for (const name of requiredInputs) {
    if (!declared.has(name)) {
      issues.push({ path: `${base}.inputSchema.required`, message: `required input "${name}" is not declared`, severity: 'error' });
    }
  }

  const produced = new Set([...written, ...(opts.extraProduced ?? [])]);
  for (const required of requiredTargetPathsSafe(targetSchema)) {
    const covered = [...produced].some(
      (path) => path === required || path.startsWith(`${required}.`) || required.startsWith(`${path}.`),
    );
    if (!covered) {
      issues.push({
        path: `${base}.arguments`,
        message: `required target field "${tool.target}.${required}" is not produced by any mapping`,
        severity: 'error',
      });
    }
  }
  return issues;
}

function requiredTargetPathsSafe(schema: JsonSchema): string[] {
  const paths: string[] = [];
  const walk = (node: JsonSchema, prefix: string) => {
    for (const key of node.required ?? []) {
      const child = node.properties[key];
      const path = prefix ? `${prefix}.${key}` : key;
      paths.push(path);
      if (child && child.type === 'object') walk(child, path);
    }
  };
  walk(schema, '');
  return paths;
}

function validateTransform(
  mapping: AdapterArgMapping,
  path: string,
  tool: AdaptedToolSpec,
  targetSchema: JsonSchema,
  declared: Map<string, JsonSchemaProperty>,
  consumed: Set<string>,
  requiredInputs: Set<string>,
): AdapterIssue[] {
  const issues: AdapterIssue[] = [];
  const transform = mapping.transform;
  if (transform === undefined) return issues;
  if (!isPlainObject(transform)) return [{ path, message: 'must be an object', severity: 'error' }];
  const kind = (transform as AdapterTransform).kind;
  if (kind === 'identity') return issues;
  if (kind === 'isoDateTime') {
    const offset = (transform as { assumeOffset?: unknown }).assumeOffset;
    if (typeof offset !== 'string' || !validOffset(offset)) {
      issues.push({ path: `${path}.assumeOffset`, message: 'must be an offset like +05:30', severity: 'error' });
    }
    const source = mapping.from ? resolveSchemaPath(tool.inputSchema, mapping.from) : undefined;
    if (!source?.property || source.property.type !== 'string') {
      issues.push({ path, message: 'isoDateTime requires a string `from` input', severity: 'error' });
    }
    return issues;
  }
  if (kind === 'dayStart' || kind === 'dayEnd') {
    const offset = (transform as { assumeOffset?: unknown }).assumeOffset;
    if (typeof offset !== 'string' || !validOffset(offset)) {
      issues.push({ path: `${path}.assumeOffset`, message: 'must be an offset like +05:30', severity: 'error' });
    }
    const source = mapping.from ? resolveSchemaPath(tool.inputSchema, mapping.from) : undefined;
    if (!source?.property || source.property.type !== 'string') {
      issues.push({ path, message: `${kind} requires a string \`from\` input holding a YYYY-MM-DD date`, severity: 'error' });
    }
    return issues;
  }
  if (kind === 'keepDurationEnd') {
    const spec = transform as { itemStart?: unknown; itemEnd?: unknown; assumeOffset?: unknown };
    if (!tool.lookup) {
      issues.push({ path, message: 'keepDurationEnd needs a lookup: it reads the matched record\'s own duration', severity: 'error' });
    }
    if (typeof spec.itemStart !== 'string' || !adapterPathIsSafe(spec.itemStart)) {
      issues.push({ path: `${path}.itemStart`, message: 'must be a safe dot path into the matched item', severity: 'error' });
    }
    if (typeof spec.itemEnd !== 'string' || !adapterPathIsSafe(spec.itemEnd)) {
      issues.push({ path: `${path}.itemEnd`, message: 'must be a safe dot path into the matched item', severity: 'error' });
    }
    if (typeof spec.assumeOffset !== 'string' || !validOffset(spec.assumeOffset)) {
      issues.push({ path: `${path}.assumeOffset`, message: 'must be an offset like +05:30', severity: 'error' });
    }
    const source = mapping.from ? resolveSchemaPath(tool.inputSchema, mapping.from) : undefined;
    if (!source?.property || source.property.type !== 'string') {
      issues.push({ path, message: 'keepDurationEnd requires `from` = the new local start (string)', severity: 'error' });
    }
    if (!mapping.to.endsWith('dateTime')) {
      issues.push({ path, message: 'keepDurationEnd writes an ISO date-time; map it to a `dateTime` field', severity: 'error' });
    }
    return issues;
  }
  if (kind === 'durationEnd') {
    const startField = (transform as { startField?: unknown }).startField;
    const durationField = (transform as { durationField?: unknown }).durationField;
    const offset = (transform as { assumeOffset?: unknown }).assumeOffset;
    if (typeof startField !== 'string' || !declared.has(startField)) {
      issues.push({ path: `${path}.startField`, message: 'must reference a declared adapted input', severity: 'error' });
    } else {
      consumed.add(startField);
      if (!requiredInputs.has(startField)) {
        issues.push({ path: `${path}.startField`, message: 'the start field is optional; calls that supply a duration without a start will be rejected', severity: 'warning' });
      }
      const prop = declared.get(startField);
      if (prop?.type !== 'string') issues.push({ path: `${path}.startField`, message: 'the start field must be a string', severity: 'error' });
    }
    if (typeof durationField !== 'string' || !declared.has(durationField)) {
      issues.push({ path: `${path}.durationField`, message: 'must reference a declared adapted input', severity: 'error' });
    } else {
      consumed.add(durationField);
      const prop = declared.get(durationField);
      if (prop?.type !== 'integer' && prop?.type !== 'number') {
        issues.push({ path: `${path}.durationField`, message: 'the duration field must be numeric', severity: 'error' });
      }
    }
    if (mapping.from !== undefined && mapping.from !== durationField) {
      issues.push({ path: `${path}`, message: '`from` should point at the duration field or be omitted', severity: 'warning' });
    }
    if (typeof offset !== 'string' || !validOffset(offset)) {
      issues.push({ path: `${path}.assumeOffset`, message: 'must be an offset like +05:30', severity: 'error' });
    }
    const targetPath = mapping.to;
    if (!targetPath.endsWith('dateTime')) {
      issues.push({ path: `${path}`, message: 'durationEnd writes an ISO date-time; map it to a `dateTime` field', severity: 'error' });
    }
    return issues;
  }
  if (kind === 'wrapEmail' || kind === 'unwrapEmail') {
    if (mapping.from === undefined) issues.push({ path, message: `${kind} requires a \`from\` input`, severity: 'error' });
    return issues;
  }
  if (kind === 'issueQuery') {
    if (mapping.from !== undefined) issues.push({ path, message: 'issueQuery builds its value from parts; omit `from`', severity: 'error' });
    const parts = (transform as { parts?: unknown }).parts;
    if (!Array.isArray(parts) || parts.length === 0 || parts.length > 10) {
      issues.push({ path: `${path}.parts`, message: 'must contain 1-10 parts', severity: 'error' });
      return issues;
    }
    for (const [index, part] of parts.entries()) {
      if (!isPlainObject(part)) {
        issues.push({ path: `${path}.parts[${index}]`, message: 'must be an object', severity: 'error' });
        continue;
      }
      if (part.input !== undefined) {
        if (typeof part.input !== 'string' || !declared.has(part.input)) {
          issues.push({ path: `${path}.parts[${index}].input`, message: 'must reference a declared adapted input', severity: 'error' });
        } else {
          consumed.add(part.input);
        }
        if (part.prefix !== undefined && typeof part.prefix !== 'string') {
          issues.push({ path: `${path}.parts[${index}].prefix`, message: 'must be a string', severity: 'error' });
        }
        if (part.valueMap !== undefined) {
          if (!isPlainObject(part.valueMap)) {
            issues.push({ path: `${path}.parts[${index}].valueMap`, message: 'must be an object of strings', severity: 'error' });
          }
        }
      } else if (typeof part.literal !== 'string' || part.literal.length === 0) {
        issues.push({ path: `${path}.parts[${index}]`, message: 'each part needs `input` or a non-empty `literal`', severity: 'error' });
      }
    }
    return issues;
  }
  issues.push({ path, message: `unsupported transform kind "${String(kind)}"`, severity: 'error' });
  return issues;
}

function hasUnsafeObjectKeys(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((entry) => hasUnsafeObjectKeys(entry));
  if (isPlainObject(value)) {
    return Object.entries(value).some(([key, entry]) => isUnsafeKey(key) || hasUnsafeObjectKeys(entry));
  }
  return false;
}

function validOffset(offset: string): boolean {
  const match = OFFSET.exec(offset);
  if (!match) return false;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours <= 14 && minutes < 60;
}

function buildSampleInput(schema: JsonSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(schema.properties)) {
    out[name] = sampleFor(property, schema.required?.includes(name) ?? false);
  }
  return out;
}

function sampleFor(property: JsonSchemaProperty, required: boolean): unknown {
  if (property.type === 'string') {
    if (property.enum && property.enum.length > 0) return property.enum[0];
    if (property.format === 'date-time') return '2026-11-02T09:00';
    if (typeof property.pattern === 'string' && property.pattern.includes('d{4}')) {
      return property.pattern.includes('T') ? '2026-11-02T09:00' : '2026-11-02';
    }
    if (typeof property.pattern === 'string' && property.pattern.includes(':')) return '09:00';
    if (property.format === 'email') return 'sample@example.com';
    return required ? 'sample' : 'sample';
  }
  if (property.type === 'integer' || property.type === 'number') {
    return property.minimum ?? (property.enum && property.enum.length > 0 ? property.enum[0] : 30);
  }
  if (property.type === 'boolean') return true;
  if (property.type === 'array') return [sampleFor(property.items, true)];
  if (property.type === 'object') {
    const nested: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(property.properties)) {
      nested[key] = sampleFor(child, property.required?.includes(key) ?? false);
    }
    return nested;
  }
  return null;
}

export function compileAdapterCall(
  tool: AdaptedToolSpec,
  adaptedArgs: Record<string, unknown>,
  toolSchemas: Map<string, JsonSchema>,
  context?: CompileContext,
): CompiledCall {
  return compileToOriginal(tool, adaptedArgs, { toolSchemas, rawToolNames: [...toolSchemas.keys()] }, context);
}

export interface AdapterPreview {
  ok: boolean;
  lookupCall: { tool: string; input: Record<string, unknown> | null; match: string[] } | null;
  originalCall: { tool: string | null; input: Record<string, unknown> | null };
  notes: string[];
  errors: AdapterIssue[];
}

/**
 * Compile without executing. For a v2 lookup tool the target id is unknown until
 * run time, so the preview binds a visible placeholder and, for keepDurationEnd,
 * assumes a 60-minute matched record (stated in the notes).
 */
export function previewAdapterCall(
  tool: AdaptedToolSpec,
  adaptedArgs: Record<string, unknown>,
  toolSchemas: Map<string, JsonSchema>,
): AdapterPreview {
  if (!tool.lookup) {
    const compiled = compileAdapterCall(tool, adaptedArgs, toolSchemas);
    return { ok: compiled.ok, lookupCall: null, originalCall: { tool: compiled.target, input: compiled.input }, notes: compiled.notes, errors: compiled.errors };
  }
  const lookupCompiled = compileLookupCall(tool, adaptedArgs, toolSchemas);
  const placeholder = '<id of the single exact match>';
  const item: Record<string, unknown> = {};
  writePath(item, tool.lookup.idField, placeholder);
  const notes = [...lookupCompiled.notes];
  for (const mapping of tool.arguments) {
    if (mapping.transform?.kind === 'keepDurationEnd') {
      writePath(item, mapping.transform.itemStart, '2026-01-01T00:00:00+00:00');
      writePath(item, mapping.transform.itemEnd, '2026-01-01T01:00:00+00:00');
      notes.push('Preview assumes a 60-minute matched record; at run time the end keeps the matched record\'s real duration.');
    }
  }
  const compiled = compileAdapterCall(tool, adaptedArgs, toolSchemas, {
    matchedItem: item,
    bind: { path: tool.lookup.bindTo, value: placeholder },
  });
  return {
    ok: lookupCompiled.ok && compiled.ok,
    lookupCall: {
      tool: tool.lookup.tool,
      input: lookupCompiled.input,
      match: tool.lookup.match
        .filter((rule) => {
          const read = readPath(adaptedArgs, rule.from);
          return read.found && read.value !== undefined && read.value !== null && read.value !== '';
        })
        .map((rule) =>
          rule.compare === 'localTime'
            ? `${rule.field} local HH:MM == ${JSON.stringify(readPath(adaptedArgs, rule.from).value)}`
            : `${rule.field} == ${JSON.stringify(readPath(adaptedArgs, rule.from).value)} (exact, case-insensitive)`,
        ),
    },
    originalCall: { tool: compiled.target, input: compiled.input },
    notes: [...notes, ...compiled.notes],
    errors: [...lookupCompiled.errors.map((error) => ({ ...error, path: `lookup.${error.path}` })), ...compiled.errors],
  };
}

/** Compile the read-only lookup call of a v2 tool (no execution). */
export function compileLookupCall(
  tool: AdaptedToolSpec,
  adaptedArgs: Record<string, unknown>,
  toolSchemas: Map<string, JsonSchema>,
): CompiledCall {
  if (!tool.lookup) {
    return { ok: false, target: null, input: null, errors: [{ path: 'lookup', message: 'tool has no lookup', severity: 'error' }], notes: [] };
  }
  const pseudo: AdaptedToolSpec = {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    target: tool.lookup.tool,
    arguments: tool.lookup.arguments,
  };
  return compileToOriginal(pseudo, adaptedArgs, { toolSchemas, rawToolNames: [...toolSchemas.keys()] });
}

function normalizeMatchValue(value: unknown): string | null {
  if (typeof value === 'string') return value.trim().toLowerCase();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).toLowerCase();
  return null;
}

export interface LookupResolution {
  ok: boolean;
  matchedItem: unknown;
  matchedId: string | null;
  matchCount: number;
  candidates: Array<Record<string, unknown>>;
  error: string | null;
}

/**
 * Apply a v2 lookup's exact-equality filters to the lookup tool's output.
 * Exactly one match is required; anything else is reported with candidates.
 */
export function resolveLookupMatches(
  lookup: AdapterLookupSpec,
  adaptedArgs: Record<string, unknown>,
  lookupOutput: unknown,
): LookupResolution {
  const display = (item: unknown): Record<string, unknown> => {
    const row: Record<string, unknown> = {};
    for (const field of lookup.display) {
      const read = readPath(item, field);
      if (read.found) row[field] = read.value;
    }
    return row;
  };
  const list = readPath(lookupOutput, lookup.resultsPath);
  if (!list.found || !Array.isArray(list.value)) {
    return {
      ok: false,
      matchedItem: null,
      matchedId: null,
      matchCount: 0,
      candidates: [],
      error: `lookup output has no array at "${lookup.resultsPath}"`,
    };
  }
  const items = list.value as unknown[];
  const wanted = lookup.match
    .map((rule) => {
      const read = readPath(adaptedArgs, rule.from);
      const present = read.found && read.value !== undefined && read.value !== null && read.value !== '';
      return { rule, present, raw: read.value, value: normalizeMatchValue(read.value) };
    })
    .filter((entry) => entry.present);
  const itemValue = (item: unknown, rule: AdapterLookupSpec['match'][number]): string | null => {
    const read = readPath(item, rule.field);
    if (rule.compare === 'localTime') {
      if (typeof read.value !== 'string') return null;
      const time = /T(\d{2}:\d{2})/.exec(read.value);
      return time ? time[1]! : null;
    }
    return normalizeMatchValue(read.value);
  };
  const matches = items.filter((item) => wanted.every(({ rule, value }) => value !== null && itemValue(item, rule) === value));
  const describeWanted = wanted
    .map(({ rule, raw }) => `${rule.field}${rule.compare === 'localTime' ? ' (local HH:MM)' : ''} = ${JSON.stringify(raw)}`)
    .join(', ');
  if (matches.length !== 1) {
    const pool = matches.length > 1 ? matches : items;
    return {
      ok: false,
      matchedItem: null,
      matchedId: null,
      matchCount: matches.length,
      candidates: pool.slice(0, MAX_CANDIDATES_SHOWN).map(display),
      error:
        matches.length === 0
          ? `No record matched ${describeWanted} exactly. Nothing was changed.`
          : `${matches.length} records matched ${describeWanted}. Nothing was changed; the target is ambiguous.`,
    };
  }
  const matched = matches[0];
  const id = readPath(matched, lookup.idField);
  if (!id.found || typeof id.value !== 'string' || id.value.length === 0) {
    return {
      ok: false,
      matchedItem: null,
      matchedId: null,
      matchCount: 1,
      candidates: [display(matched)],
      error: `the matched record has no string id at "${lookup.idField}"`,
    };
  }
  return { ok: true, matchedItem: matched, matchedId: id.value, matchCount: 1, candidates: [display(matched)], error: null };
}

function compileToOriginal(
  tool: AdaptedToolSpec,
  adaptedArgs: Record<string, unknown>,
  options: CompileOptions,
  context?: CompileContext,
): CompiledCall {
  const errors: AdapterIssue[] = [];
  const notes: string[] = [];
  const output: Record<string, unknown> = {};
  if (!isPlainObject(adaptedArgs)) {
    return {
      ok: false,
      target: tool.target,
      input: null,
      errors: [{ path: 'arguments', message: 'adapted arguments must be an object', severity: 'error' }],
      notes,
    };
  }
  for (const [index, mapping] of tool.arguments.entries()) {
    const at = `arguments[${index}]`;
    let value: unknown;
    let present = false;
    if (mapping.transform?.kind === 'issueQuery') {
      const transformed = applyTransform(mapping.transform, undefined, adaptedArgs, 'issueQuery', notes);
      if (!transformed.ok) {
        errors.push({ path: at, message: transformed.reason, severity: 'error' });
        continue;
      }
      value = transformed.value;
      present = true;
    } else if (mapping.const !== undefined) {
      value = structuredClone(mapping.const);
      present = true;
      notes.push(`${mapping.to} ← const`);
    } else if (mapping.from !== undefined) {
      const read = readPath(adaptedArgs, mapping.from);
      if (read.found && read.value !== undefined && read.value !== null) {
        value = read.value;
        present = true;
        if (mapping.valueMap) {
          if (typeof value !== 'string' || !Object.prototype.hasOwnProperty.call(mapping.valueMap, value)) {
            errors.push({
              path: at,
              message: `input "${mapping.from}" value ${JSON.stringify(value)} has no entry in valueMap`,
              severity: 'error',
            });
            continue;
          }
          value = mapping.valueMap[value];
          notes.push(`${mapping.from} → enum → ${String(value)}`);
        }
        if (mapping.transform) {
          const transformed = applyTransform(mapping.transform, value, adaptedArgs, mapping.from, notes, context);
          if (!transformed.ok) {
            errors.push({ path: at, message: transformed.reason, severity: 'error' });
            continue;
          }
          value = transformed.value;
          present = true;
        }
      } else if (mapping.default !== undefined) {
        value = structuredClone(mapping.default);
        present = true;
        notes.push(`${mapping.to} ← default`);
      } else if (mapping.required === true) {
        errors.push({ path: at, message: `required adapted input "${mapping.from}" is missing`, severity: 'error' });
        continue;
      }
    }
    if (!present) continue;
    if (value === undefined) continue;
    const written = writePath(output, mapping.to, value);
    if (!written.ok) {
      errors.push({ path: `${at}.to`, message: written.reason ?? 'could not write target path', severity: 'error' });
      continue;
    }
    notes.push(`${mapping.from ?? 'const'} → ${mapping.to}`);
  }

  if (tool.lookup) {
    if (!context?.bind) {
      errors.push({ path: 'lookup', message: 'the target id is resolved at run time by the lookup; nothing to bind yet', severity: 'error' });
    } else {
      const bound = writePath(output, context.bind.path, context.bind.value);
      if (!bound.ok) errors.push({ path: 'lookup.bindTo', message: bound.reason ?? 'could not bind the matched id', severity: 'error' });
      else notes.push(`lookup match → ${context.bind.path}`);
    }
  }

  const targetSchema = options.toolSchemas.get(tool.target);
  if (!targetSchema) {
    errors.push({ path: 'target', message: `unknown target "${tool.target}"`, severity: 'error' });
  } else {
    const validation = validateAgainstSchema(targetSchema, output);
    for (const message of validation.errors) {
      errors.push({ path: 'compiled', message: `compiled call would fail target validation: ${message}`, severity: 'error' });
    }
  }
  return {
    ok: errors.length === 0,
    target: tool.target,
    input: errors.length === 0 ? output : null,
    errors,
    notes,
  };
}

function applyTransform(
  transform: AdapterTransform,
  value: unknown,
  adaptedArgs: Record<string, unknown>,
  from: string,
  notes: string[],
  context?: CompileContext,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  switch (transform.kind) {
    case 'identity':
      return { ok: true, value };
    case 'dayStart':
    case 'dayEnd': {
      if (typeof value !== 'string' || !LOCAL_DATE.test(value)) return { ok: false, reason: `${from} must be a local date like 2026-11-05` };
      const base = withOffset(`${value}T00:00`, transform.assumeOffset);
      if (!base) return { ok: false, reason: `${from} is not a valid calendar date` };
      if (transform.kind === 'dayStart') {
        notes.push(`${from} → start of day ${transform.assumeOffset}`);
        return { ok: true, value: base };
      }
      const next = addMinutesWithOffset(`${value}T00:00`, 1440, transform.assumeOffset);
      if (!next) return { ok: false, reason: `could not compute the end of ${from}` };
      notes.push(`${from} → start of next day ${transform.assumeOffset}`);
      return { ok: true, value: next };
    }
    case 'keepDurationEnd': {
      if (typeof value !== 'string') return { ok: false, reason: `${from} must be a local date-time` };
      const item = context?.matchedItem;
      const startRead = readPath(item, transform.itemStart);
      const endRead = readPath(item, transform.itemEnd);
      const oldStart = startRead.found && typeof startRead.value === 'string' ? Date.parse(startRead.value) : Number.NaN;
      const oldEnd = endRead.found && typeof endRead.value === 'string' ? Date.parse(endRead.value) : Number.NaN;
      if (!Number.isFinite(oldStart) || !Number.isFinite(oldEnd) || oldEnd <= oldStart) {
        return { ok: false, reason: 'the matched record has no valid start/end to keep its duration' };
      }
      const minutes = Math.round((oldEnd - oldStart) / 60_000);
      const end = addMinutesWithOffset(value, minutes, transform.assumeOffset);
      if (!end) return { ok: false, reason: `${from} must be a local date-time like 2026-11-05T17:00` };
      notes.push(`${from} + matched duration ${minutes}m → end date-time`);
      return { ok: true, value: end };
    }
    case 'isoDateTime': {
      if (typeof value !== 'string') return { ok: false, reason: `${from} must be a string` };
      const normalized = withOffset(value, transform.assumeOffset);
      if (!normalized) return { ok: false, reason: `${from} must be a local date-time like 2026-11-02T09:00` };
      notes.push(`${from} → ISO date-time ${transform.assumeOffset}`);
      return { ok: true, value: normalized };
    }
    case 'durationEnd': {
      if (typeof value !== 'number') return { ok: false, reason: `${from} must be a number of minutes` };
      const start = readPath(adaptedArgs, transform.startField);
      if (!start.found || typeof start.value !== 'string') {
        return { ok: false, reason: `${transform.startField} must be provided to compute the end` };
      }
      const end = addMinutesWithOffset(start.value, value, transform.assumeOffset);
      if (!end) return { ok: false, reason: `could not compute end from ${transform.startField} + ${String(value)} minutes` };
      notes.push(`${transform.startField} + ${value}m → end date-time`);
      return { ok: true, value: end };
    }
    case 'wrapEmail': {
      if (!Array.isArray(value)) return { ok: false, reason: `${from} must be an array of email strings` };
      const emails: Array<{ email: string }> = [];
      for (const entry of value) {
        if (typeof entry !== 'string' || !EMAIL.test(entry)) {
          return { ok: false, reason: `${from} contains an invalid email: ${JSON.stringify(entry)}` };
        }
        emails.push({ email: entry });
      }
      notes.push(`${from} → wrapped email objects`);
      return { ok: true, value: emails };
    }
    case 'unwrapEmail': {
      if (!Array.isArray(value)) return { ok: false, reason: `${from} must be an array` };
      const emails: string[] = [];
      for (const entry of value) {
        if (typeof entry === 'string') emails.push(entry);
        else if (isPlainObject(entry) && typeof entry.email === 'string') emails.push(entry.email);
        else return { ok: false, reason: `${from} must contain emails or objects with email` };
      }
      return { ok: true, value: emails };
    }
    case 'issueQuery': {
      const parts: string[] = [];
      for (const part of transform.parts) {
        if (part.literal) {
          parts.push(part.literal);
          continue;
        }
        if (!part.input) continue;
        const read = readPath(adaptedArgs, part.input);
        if (!read.found || read.value === undefined || read.value === null || read.value === '') continue;
        if (typeof read.value !== 'string') {
          return { ok: false, reason: `${part.input} must be a string to build a query` };
        }
        let text: string = read.value;
        if (part.valueMap) {
          if (!Object.prototype.hasOwnProperty.call(part.valueMap, text)) {
            return { ok: false, reason: `${part.input} value ${text} has no query mapping` };
          }
          text = part.valueMap[text]!;
        }
        parts.push(`${part.prefix ?? ''}${text}`);
      }
      if (parts.length === 0) return { ok: false, reason: 'issueQuery produced an empty query' };
      notes.push('structured filters → query string');
      return { ok: true, value: parts.join(' ') };
    }
    default:
      return { ok: false, reason: `unsupported transform "${(transform as { kind?: string }).kind}"` };
  }
}

function withOffset(local: string, offset: string): string | null {
  const match = LOCAL_DATE_TIME.exec(local);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  const h = Number(hour);
  const mi = Number(minute);
  const s = Number(second ?? '0');
  if (!validDateParts(y, mo, d, h, mi, s)) return null;
  if (!validOffset(offset)) return null;
  return `${year}-${month}-${day}T${hour}:${minute}:${String(s).padStart(2, '0')}${offset}`;
}

function addMinutesWithOffset(localStart: string, minutes: number, offset: string): string | null {
  const normalized = withOffset(localStart, offset);
  if (!normalized) return null;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440 * 7) return null;
  const match = LOCAL_DATE_TIME.exec(localStart);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const base = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second ?? '0'));
  const end = new Date(base + minutes * 60_000);
  const y = end.getUTCFullYear();
  const mo = String(end.getUTCMonth() + 1).padStart(2, '0');
  const d = String(end.getUTCDate()).padStart(2, '0');
  const h = String(end.getUTCHours()).padStart(2, '0');
  const mi = String(end.getUTCMinutes()).padStart(2, '0');
  const s = String(end.getUTCSeconds()).padStart(2, '0');
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${offset}`;
}

function validDateParts(year: number, month: number, day: number, hour: number, minute: number, second: number): boolean {
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function adaptedToolToDefinition(tool: AdaptedToolSpec): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputDescription: `Result of the original tool "${tool.target}". No output fields are renamed or reshaped.`,
    permissions: [],
    annotations: { readOnlyHint: false, destructiveHint: false },
  };
}

export function describeAdapterLimits(spec: AdapterSpec): string[] {
  const lookups = spec.tools.filter((tool) => tool.lookup).map((tool) => tool.name);
  return [
    lookups.length > 0
      ? `Most public calls compile to exactly one original call. ${lookups.join(', ')} first make one read-only lookup call (exact match required; zero or several matches stop with no write), then exactly one target call. Both count against the tool-call budget.`
      : 'One public tool call compiles to exactly one original call.',
    'Supported operations: rename/path mapping, constants and defaults, enum mapping, ISO local→offset date-times, day bounds, start+duration→end, keep-matched-duration, email wrapping/unwrapping, bounded issue query assembly, and (v2) one exact-match read-only lookup.',
    'No eval, generated JavaScript, shell, free-form composition, fuzzy matching, hidden IDs, or access to task validators.',
    `Adapter declares ${spec.tools.length} tool(s); limit ${spec.limits.maxTools}.`,
    'Compiled calls are validated against the original JSON Schema before the original executor runs.',
  ];
}

export function adapterProvenance(spec: AdapterSpec): Record<string, unknown> {
  return {
    schema: spec.schema,
    domain: spec.domain,
    version: spec.version,
    adapterHash: hashJson(spec),
    publicTools: spec.tools.map((tool) => ({ name: tool.name, target: tool.target })),
    canonical: stableStringify(spec),
  };
}

/** Used by tests and the UI to prove unsafe keys are rejected before compile. */
export function adapterPathIsSafe(path: string): boolean {
  const split = splitPath(path);
  return split.ok && !split.segments.some((segment) => isUnsafeKey(segment));
}

export function mappingSummary(tool: AdaptedToolSpec): string[] {
  const lines = tool.arguments.map((mapping) => {
    if (mapping.const !== undefined) return `${mapping.to} = constant`;
    return `${mapping.from ?? '?'} → ${mapping.to}${mapping.transform ? ` (${mapping.transform.kind})` : ''}`;
  });
  if (tool.lookup) {
    const rules = tool.lookup.match.map((rule) => `${rule.from} = ${rule.field}`).join(' and ');
    lines.unshift(`lookup: ${tool.lookup.tool}, exactly one item where ${rules} → ${tool.lookup.idField} → ${tool.lookup.bindTo}`);
  }
  return lines;
}

export function adaptedPropertyKind(tool: AdaptedToolSpec, name: string): string {
  return propertyKind(tool.inputSchema.properties[name]);
}

export function makeAdapterSpec(input: {
  domain: string;
  version: string;
  description: string;
  tools: AdaptedToolSpec[];
}): AdapterSpec {
  const hasLookup = input.tools.some((tool) => tool.lookup !== undefined);
  return {
    schema: hasLookup ? 'anvil.adapter/v2' : 'anvil.adapter/v1',
    domain: input.domain,
    version: input.version,
    description: input.description,
    limits: hasLookup
      ? { oneToOne: false, maxTools: 12, maxUnderlyingCallsPerInvocation: 2 }
      : { oneToOne: true, maxTools: 12, maxUnderlyingCallsPerInvocation: 1 },
    tools: input.tools,
  };
}

export function isJsonValue(value: unknown): value is JsonValue {
  try {
    const round = JSON.parse(JSON.stringify(value));
    return round !== undefined || value === null;
  } catch {
    return false;
  }
}