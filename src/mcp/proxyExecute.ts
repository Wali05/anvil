import type { AdaptedLookupRecord, AdaptedToolSpec, AdapterSpec, JsonSchema, ToolDefinition } from '../core/types.js';
import {
  adaptedToolToDefinition,
  compileAdapterCall,
  compileLookupCall,
  resolveLookupMatches,
  validateAdapter,
} from '../core/adapter.js';
import { validateAgainstSchema } from '../core/schema.js';
import type { UpstreamCallResult, UpstreamMcpClient, UpstreamToolInfo } from './upstreamClient.js';

export interface ProxyExecution {
  publicTool: string;
  proposedInput: Record<string, unknown>;
  compilation: { target: string; input: unknown; errors: string[]; notes: string[] } | null;
  lookup: AdaptedLookupRecord | null;
  underlyingCalls: number;
  result: UpstreamCallResult;
}

export function buildProxyPublicTools(
  adapter: AdapterSpec,
  upstreamTools: UpstreamToolInfo[],
): ToolDefinition[] {
  const byUpstream = new Map(upstreamTools.map((tool) => [tool.name, tool]));
  return adapter.tools.map((tool) => {
    const definition = adaptedToolToDefinition(tool);
    const target = byUpstream.get(tool.target);
    if (!target) return definition;
    return {
      ...definition,
      annotations: {
        readOnlyHint: target.annotations.readOnlyHint,
        destructiveHint: target.annotations.destructiveHint,
      },
    };
  });
}

export function validateProxyAdapter(
  adapter: AdapterSpec,
  toolSchemas: Map<string, JsonSchema>,
  readOnlyTools: Set<string>,
): ReturnType<typeof validateAdapter> {
  return validateAdapter(adapter, {
    toolSchemas,
    rawToolNames: [...toolSchemas.keys()],
    readOnlyTools,
  });
}

/**
 * Compile an adapted public call and execute the original call(s) against an
 * upstream MCP catalog. Same honesty as the fixture DomainDefinition path:
 * lookups are exact-match, zero/several matches write nothing, both calls count.
 */
export async function executeProxyAdaptedCall(input: {
  tool: AdaptedToolSpec;
  args: Record<string, unknown>;
  upstream: UpstreamMcpClient;
}): Promise<ProxyExecution> {
  const { tool, args, upstream } = input;
  const publicValidation = validateAgainstSchema(tool.inputSchema, args);
  if (!publicValidation.ok) {
    return {
      publicTool: tool.name,
      proposedInput: args,
      compilation: null,
      lookup: null,
      underlyingCalls: 1,
      result: {
        ok: false,
        error: `Invalid arguments: ${publicValidation.errors.join('; ')}`,
      },
    };
  }

  let lookupRecord: AdaptedLookupRecord | null = null;
  let compileContext: Parameters<typeof compileAdapterCall>[3];

  if (tool.lookup) {
    const lookupSpec = tool.lookup;
    const lookupCompiled = compileLookupCall(tool, args, upstream.toolSchemas);
    if (!lookupCompiled.ok || !lookupCompiled.input) {
      return {
        publicTool: tool.name,
        proposedInput: args,
        compilation: { target: tool.target, input: null, errors: lookupCompiled.errors.map((e) => `${e.path}: ${e.message}`), notes: lookupCompiled.notes },
        lookup: {
          tool: lookupSpec.tool,
          input: lookupCompiled.input,
          ok: false,
          matchedId: null,
          matchCount: 0,
          candidates: [],
          error: 'lookup compile failed',
        },
        underlyingCalls: 0,
        result: {
          ok: false,
          error: `The adapter could not build its lookup call: ${lookupCompiled.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`,
        },
      };
    }
    if (!upstream.readOnlyTools.has(lookupSpec.tool)) {
      return {
        publicTool: tool.name,
        proposedInput: args,
        compilation: { target: tool.target, input: null, errors: [`Lookup tool "${lookupSpec.tool}" is missing or not read-only.`], notes: [] },
        lookup: {
          tool: lookupSpec.tool,
          input: lookupCompiled.input,
          ok: false,
          matchedId: null,
          matchCount: 0,
          candidates: [],
          error: 'lookup tool not read-only',
        },
        underlyingCalls: 0,
        result: { ok: false, error: `Lookup tool "${lookupSpec.tool}" is missing or not read-only on the upstream server.` },
      };
    }
    const lookupResult = await upstream.callTool(lookupSpec.tool, lookupCompiled.input);
    if (!lookupResult.ok) {
      return {
        publicTool: tool.name,
        proposedInput: args,
        compilation: { target: tool.target, input: null, errors: [lookupResult.error ?? 'lookup failed'], notes: lookupCompiled.notes },
        lookup: {
          tool: lookupSpec.tool,
          input: lookupCompiled.input,
          ok: false,
          matchedId: null,
          matchCount: 0,
          candidates: [],
          error: lookupResult.error ?? 'lookup failed',
        },
        underlyingCalls: 1,
        result: { ok: false, error: `Lookup call ${lookupSpec.tool} failed: ${lookupResult.error ?? 'unknown error'}` },
      };
    }
    const resolution = resolveLookupMatches(lookupSpec, args, lookupResult.content);
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
      const candidates =
        resolution.candidates.length > 0 ? ` Candidates: ${JSON.stringify(resolution.candidates)}` : '';
      return {
        publicTool: tool.name,
        proposedInput: args,
        compilation: {
          target: tool.target,
          input: null,
          errors: [resolution.error ?? 'lookup did not resolve'],
          notes: lookupCompiled.notes,
        },
        lookup: lookupRecord,
        underlyingCalls: 1,
        result: {
          ok: false,
          error: `${resolution.error ?? 'The lookup did not resolve exactly one record. Nothing was changed.'}${candidates}`,
        },
      };
    }
    compileContext = { matchedItem: resolution.matchedItem, bind: { path: lookupSpec.bindTo, value: resolution.matchedId } };
  }

  const callsBeforeTarget = lookupRecord ? 1 : 0;
  const compiled = compileAdapterCall(tool, args, upstream.toolSchemas, compileContext);
  if (!compiled.ok || !compiled.target || !compiled.input) {
    return {
      publicTool: tool.name,
      proposedInput: args,
      compilation: {
        target: tool.target,
        input: compiled.input,
        errors: compiled.errors.map((e) => `${e.path}: ${e.message}`),
        notes: compiled.notes,
      },
      lookup: lookupRecord,
      underlyingCalls: callsBeforeTarget,
      result: {
        ok: false,
        error: `The adapter could not compile this call into a valid original call: ${compiled.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`,
      },
    };
  }

  const targetResult = await upstream.callTool(compiled.target, compiled.input);
  return {
    publicTool: tool.name,
    proposedInput: args,
    compilation: {
      target: compiled.target,
      input: compiled.input,
      errors: [],
      notes: compiled.notes,
    },
    lookup: lookupRecord,
    underlyingCalls: callsBeforeTarget + 1,
    result: targetResult,
  };
}
