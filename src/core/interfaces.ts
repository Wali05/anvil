import type {
  AdaptedLookupRecord,
  AdapterSpec,
  AdaptedToolSpec,
  ConditionId,
  DomainDefinition,
  DomainTool,
  JsonSchema,
  JsonSchemaProperty,
  ToolDefinition,
  ToolExecResult,
} from './types.js';
import { adaptedToolToDefinition, compileAdapterCall, compileLookupCall, resolveLookupMatches } from './adapter.js';
import { deepClone, hashJson } from './util.js';
import { validateAgainstSchema } from './schema.js';

export interface ConditionInterface {
  condition: ConditionId;
  tools: ToolDefinition[];
  hash: string;
  adapter: AdapterSpec | null;
  publicTool(name: string): ToolDefinition | undefined;
  adaptedTool(name: string): AdaptedToolSpec | undefined;
}

export function toolDefinition(tool: DomainTool): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputDescription: tool.outputDescription,
    permissions: tool.permissions,
    annotations: tool.annotations,
  };
}

export function rawToolSchemaMap(domain: DomainDefinition): Map<string, JsonSchema> {
  return new Map(domain.tools.map((tool) => [tool.name, tool.inputSchema]));
}

/** Original tools that declare no write permission and a read-only hint; the only tools a v2 lookup may call. */
export function readOnlyToolNames(domain: DomainDefinition): Set<string> {
  return new Set(
    domain.tools
      .filter((tool) => tool.annotations.readOnlyHint === true && !tool.permissions.some((permission) => permission.write))
      .map((tool) => tool.name),
  );
}

function applyDescriptions(domain: DomainDefinition, tool: DomainTool): DomainTool {
  const clone: DomainTool = {
    ...tool,
    inputSchema: deepClone(tool.inputSchema),
    permissions: deepClone(tool.permissions),
    annotations: { ...tool.annotations },
  };
  const toolDescription = domain.describeToolField(tool.name, '');
  if (toolDescription) clone.description = toolDescription;
  const apply = (schema: JsonSchema, prefix: string) => {
    for (const [name, property] of Object.entries(schema.properties)) {
      const path = prefix ? `${prefix}.${name}` : name;
      const description = domain.describeToolField(tool.name, path);
      if (description) (property as { description?: string }).description = description;
      if (property.type === 'object') apply(property as JsonSchema, path);
    }
  };
  apply(clone.inputSchema, '');
  return clone;
}

function interfaceHash(tools: ToolDefinition[], adapter: AdapterSpec | null): string {
  if (adapter) return hashJson({ adapter: adapterHashPayload(adapter), tools });
  return hashJson(
    tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputDescription: tool.outputDescription,
      permissions: tool.permissions,
      annotations: tool.annotations,
    })),
  );
}

function adapterHashPayload(adapter: AdapterSpec): unknown {
  return adapter;
}

export function buildConditionInterface(
  domain: DomainDefinition,
  condition: ConditionId,
  adapter: AdapterSpec | null = null,
): ConditionInterface {
  let tools: ToolDefinition[];
  let effectiveAdapter: AdapterSpec | null = null;
  if (condition === 'original') {
    tools = domain.tools.map(toolDefinition);
  } else if (condition === 'descriptions') {
    tools = domain.tools.map((tool) => toolDefinition(applyDescriptions(domain, tool)));
  } else {
    if (!adapter) throw new Error('The adapted condition requires an adapter specification.');
    effectiveAdapter = adapter;
    // Adapted tools inherit the target's permissions and safety hints (e.g. cancel_event is destructive).
    tools = adapter.tools.map((tool) => {
      const definition = adaptedToolToDefinition(tool);
      const target = domain.tools.find((raw) => raw.name === tool.target);
      return target ? { ...definition, permissions: target.permissions, annotations: { ...target.annotations } } : definition;
    });
  }
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const adapterByName = new Map((effectiveAdapter?.tools ?? []).map((tool) => [tool.name, tool]));
  return {
    condition,
    tools,
    hash: interfaceHash(tools, effectiveAdapter),
    adapter: effectiveAdapter,
    publicTool(name: string) {
      return byName.get(name);
    },
    adaptedTool(name: string) {
      return adapterByName.get(name);
    },
  };
}

export interface PublicToolExecution {
  attempted: boolean;
  countedUnderlying: boolean;
  publicTool: ToolDefinition | null;
  validation: { ok: boolean; errors: string[] };
  compilation: { target: string; input: unknown; errors: string[]; notes: string[] } | null;
  result: ToolExecResult;
  /** Original calls actually executed (0-2). Budget accounting uses this. */
  underlyingCalls: number;
  /** v2 lookup step, when the adapted tool declares one. */
  lookup: AdaptedLookupRecord | null;
}

/** Worst-case original calls one public call may make; checked before execution. */
export function maxUnderlyingCallsFor(iface: ConditionInterface, toolName: string): number {
  return iface.condition === 'adapted' && iface.adaptedTool(toolName)?.lookup ? 2 : 1;
}

/**
 * Run a public (model-facing) tool. Adapted calls are compiled first and then
 * executed by the very same original domain executor. Exactly one underlying
 * call is possible per public call.
 */
type ToolExecutionInput = {
  iface: ConditionInterface;
  domain: DomainDefinition;
  state: unknown;
  toolName: string;
  args: unknown;
  now: string;
  trialId?: string;
};

export function executeConditionTool(input: ToolExecutionInput): PublicToolExecution {
  const execution = executeConditionToolInner(input);
  return {
    ...execution,
    // A counted attempt always costs at least one call (invalid attempts count, as before);
    // a resolved v2 lookup plus its target call costs two.
    underlyingCalls: execution.countedUnderlying ? Math.max(1, execution.underlyingCalls ?? 1) : 0,
    lookup: execution.lookup ?? null,
  };
}

type InnerExecution = Omit<PublicToolExecution, 'underlyingCalls' | 'lookup'> &
  Partial<Pick<PublicToolExecution, 'underlyingCalls' | 'lookup'>>;

function executeConditionToolInner(input: ToolExecutionInput): InnerExecution {
  const { iface, domain, state, toolName, args, now } = input;
  const publicTool = iface.publicTool(toolName);
  if (!publicTool) {
    return {
      attempted: true,
      countedUnderlying: false,
      publicTool: null,
      validation: { ok: false, errors: [`Unknown tool "${toolName}".`] },
      compilation: null,
      result: {
        ok: false,
        error: {
          code: 'unknown_tool',
          message: `Tool "${toolName}" is not in this interface. Available: ${iface.tools.map((tool) => tool.name).join(', ')}.`,
        },
      },
    };
  }

  const validation = validateAgainstSchema(publicTool.inputSchema, args);
  if (!validation.ok) {
    return {
      attempted: true,
      countedUnderlying: true,
      publicTool,
      validation,
      compilation: null,
      result: {
        ok: false,
        error: {
          code: 'tool_input_invalid',
          message: `Arguments for ${toolName} do not match its JSON Schema: ${validation.errors.join('; ')}`,
        },
      },
    };
  }

  const inputRecord = args as Record<string, unknown>;

  if (iface.condition === 'adapted') {
    const adapted = iface.adaptedTool(toolName);
    if (!adapted) {
      return {
        attempted: true,
        countedUnderlying: true,
        publicTool,
        validation,
        compilation: null,
        result: { ok: false, error: { code: 'adapter_missing', message: `No adapter mapping for "${toolName}".` } },
      };
    }
    let lookupRecord: AdaptedLookupRecord | null = null;
    let compileContext: Parameters<typeof compileAdapterCall>[3];
    if (adapted.lookup) {
      const lookupSpec = adapted.lookup;
      const lookupCompiled = compileLookupCall(adapted, inputRecord, rawToolSchemaMap(domain));
      const lookupTool = domain.tools.find((tool) => tool.name === lookupSpec.tool);
      const lookupFailure = (message: string, input: unknown, calls: number): InnerExecution => ({
        attempted: true,
        countedUnderlying: true,
        publicTool,
        validation,
        compilation: { target: adapted.target, input: null, errors: [message], notes: lookupCompiled.notes },
        result: { ok: false, error: { code: 'adapter_lookup_failed', message } },
        underlyingCalls: calls,
        lookup: { tool: lookupSpec.tool, input, ok: false, matchedId: null, matchCount: 0, candidates: [], error: message },
      });
      if (!lookupCompiled.ok || !lookupCompiled.input) {
        return lookupFailure(
          `The adapter could not build its lookup call: ${lookupCompiled.errors.map((error) => `${error.path}: ${error.message}`).join('; ')}`,
          lookupCompiled.input,
          0,
        );
      }
      if (!lookupTool || lookupTool.annotations.readOnlyHint !== true || lookupTool.permissions.some((permission) => permission.write)) {
        return lookupFailure(`Lookup tool "${lookupSpec.tool}" is missing or not read-only.`, lookupCompiled.input, 0);
      }
      const lookupValidation = validateAgainstSchema(lookupTool.inputSchema, lookupCompiled.input);
      if (!lookupValidation.ok) {
        return lookupFailure(`Compiled lookup failed the original schema: ${lookupValidation.errors.join('; ')}`, lookupCompiled.input, 0);
      }
      const lookupResult = lookupTool.execute(state, lookupCompiled.input, {
        now,
        trialId: input.trialId,
        condition: iface.condition,
        underlyingCalls: 1,
      });
      if (!lookupResult.ok) {
        return lookupFailure(`Lookup call ${lookupSpec.tool} failed: ${lookupResult.error?.message ?? 'unknown error'}`, lookupCompiled.input, 1);
      }
      const resolution = resolveLookupMatches(lookupSpec, inputRecord, lookupResult.content);
      lookupRecord = {
        tool: lookupSpec.tool,
        input: lookupCompiled.input,
        ok: resolution.ok,
        matchedId: resolution.matchedId,
        matchCount: resolution.matchCount,
        candidates: resolution.candidates,
        error: resolution.error,
      };
      if (!resolution.ok || resolution.matchedId === null) {
        return {
          attempted: true,
          countedUnderlying: true,
          publicTool,
          validation,
          compilation: { target: adapted.target, input: null, errors: [resolution.error ?? 'lookup did not resolve'], notes: lookupCompiled.notes },
          result: {
            ok: false,
            error: {
              code: resolution.matchCount > 1 ? 'adapter_lookup_ambiguous' : 'adapter_lookup_no_match',
              message: resolution.error ?? 'The lookup did not resolve exactly one record. Nothing was changed.',
              details: { candidates: resolution.candidates },
            },
          },
          underlyingCalls: 1,
          lookup: lookupRecord,
        };
      }
      compileContext = { matchedItem: resolution.matchedItem, bind: { path: lookupSpec.bindTo, value: resolution.matchedId } };
    }
    const callsBeforeTarget = lookupRecord ? 1 : 0;
    const compiled = compileAdapterCall(adapted, inputRecord, rawToolSchemaMap(domain), compileContext);
    if (!compiled.ok || !compiled.target || !compiled.input) {
      return {
        attempted: true,
        countedUnderlying: true,
        publicTool,
        validation,
        compilation: {
          target: adapted.target,
          input: compiled.input,
          errors: compiled.errors.map((error) => `${error.path}: ${error.message}`),
          notes: compiled.notes,
        },
        result: {
          ok: false,
          error: {
            code: 'adapter_compile_failed',
            message: `The adapter could not compile this call into a valid original call: ${compiled.errors.map((error) => `${error.path}: ${error.message}`).join('; ')}`,
          },
        },
        underlyingCalls: callsBeforeTarget,
        lookup: lookupRecord,
      };
    }
    const raw = domain.tools.find((tool) => tool.name === compiled.target);
    if (!raw) {
      return {
        attempted: true,
        countedUnderlying: true,
        publicTool,
        validation,
        compilation: {
          target: compiled.target,
          input: compiled.input,
          errors: [`Original tool "${compiled.target}" is missing.`],
          notes: compiled.notes,
        },
        result: { ok: false, error: { code: 'original_tool_missing', message: `Original tool "${compiled.target}" is missing.` } },
        underlyingCalls: callsBeforeTarget,
        lookup: lookupRecord,
      };
    }
    const originalValidation = validateAgainstSchema(raw.inputSchema, compiled.input);
    if (!originalValidation.ok) {
      return {
        attempted: true,
        countedUnderlying: true,
        publicTool,
        validation,
        compilation: {
          target: compiled.target,
          input: compiled.input,
          errors: originalValidation.errors,
          notes: compiled.notes,
        },
        result: {
          ok: false,
          error: { code: 'adapter_compile_failed', message: `Compiled input failed the original schema: ${originalValidation.errors.join('; ')}` },
        },
        underlyingCalls: callsBeforeTarget,
        lookup: lookupRecord,
      };
    }
    return {
      attempted: true,
      countedUnderlying: true,
      publicTool,
      validation,
      compilation: {
        target: compiled.target,
        input: compiled.input,
        errors: [],
        notes: compiled.notes,
      },
      result: raw.execute(state, compiled.input, {
        now,
        trialId: input.trialId,
        condition: iface.condition,
        underlyingCalls: callsBeforeTarget + 1,
      }),
      underlyingCalls: callsBeforeTarget + 1,
      lookup: lookupRecord,
    };
  }

  const raw = domain.tools.find((tool) => tool.name === toolName);
  if (!raw) {
    return {
      attempted: true,
      countedUnderlying: true,
      publicTool,
      validation,
      compilation: null,
      result: { ok: false, error: { code: 'original_tool_missing', message: `Original tool "${toolName}" is missing.` } },
    };
  }
  return {
    attempted: true,
    countedUnderlying: true,
    publicTool,
    validation,
    compilation: null,
    result: raw.execute(state, inputRecord, { now, trialId: input.trialId, condition: iface.condition, underlyingCalls: 1 }),
  };
}

export function countSchemas(tools: ToolDefinition[]): { fields: number } {
  let fields = 0;
  const walk = (schema: JsonSchema) => {
    for (const property of Object.values(schema.properties)) {
      fields += 1;
      if (property.type === 'object') walk(property as JsonSchema);
      else if (property.type === 'array' && property.items.type === 'object') walk(property.items as JsonSchema);
    }
  };
  tools.forEach((tool) => walk(tool.inputSchema));
  return { fields };
}

export type { JsonSchemaProperty };