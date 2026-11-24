import type { AdaptedLookupRecord, AdaptedToolSpec, JsonSchema, ToolExecResult } from '../core/types.js';
import { compileAdapterCall, compileLookupCall, resolveLookupMatches, type CompileContext } from '../core/adapter.js';
import { validateAgainstSchema } from '../core/schema.js';
import { errorMessage } from '../core/errors.js';
import { toExecResult, type UpstreamCallResult } from './upstream.js';

export type OriginalCaller = (tool: string, input: Record<string, unknown>) => Promise<UpstreamCallResult>;

export interface AdaptedExecution {
  ok: boolean;
  /** Parsed result of the last original call (or the adapter's own error). */
  result: ToolExecResult;
  /** The target call's raw MCP result, forwarded verbatim to the client when present. */
  targetResult: UpstreamCallResult | null;
  compiled: { target: string; input: Record<string, unknown> | null; notes: string[]; errors: string[] };
  lookup: AdaptedLookupRecord | null;
  /** Original calls actually made: 0, 1 (target, or a lookup that stopped) or 2. */
  underlyingCalls: number;
}

/**
 * Execute one adapted public call against a live upstream:
 *   1. optional read-only lookup (exactly one match, otherwise stop with candidates and write nothing)
 *   2. compile the adapted arguments into the original tool's input
 *   3. validate the compiled input against the (normalized) original schema
 *   4. make exactly one original target call
 * Every failure before step 4 makes no write.
 */
export async function executeAdaptedCall(input: {
  tool: AdaptedToolSpec;
  args: Record<string, unknown>;
  schemas: Map<string, JsonSchema>;
  readOnlyTools: Set<string>;
  call: OriginalCaller;
}): Promise<AdaptedExecution> {
  const { tool, args, schemas, readOnlyTools, call } = input;
  const fail = (
    code: string,
    message: string,
    extra: Partial<AdaptedExecution> = {},
  ): AdaptedExecution => ({
    ok: false,
    result: { ok: false, error: { code, message } },
    targetResult: null,
    compiled: { target: tool.target, input: null, notes: [], errors: [message] },
    lookup: null,
    underlyingCalls: 0,
    ...extra,
  });

  const inputCheck = validateAgainstSchema(tool.inputSchema, args);
  if (!inputCheck.ok) {
    return fail('tool_input_invalid', `Invalid arguments for ${tool.name}: ${inputCheck.errors.join('; ')}`);
  }

  let context: CompileContext | undefined;
  let lookupRecord: AdaptedLookupRecord | null = null;
  let calls = 0;

  if (tool.lookup) {
    const lookup = tool.lookup;
    if (!readOnlyTools.has(lookup.tool)) {
      return fail('adapter_lookup_not_read_only', `Lookup tool "${lookup.tool}" is not annotated read-only by the upstream server; refusing to call it as a lookup.`);
    }
    const lookupCompiled = compileLookupCall(tool, args, schemas);
    if (!lookupCompiled.ok || !lookupCompiled.input) {
      return fail('adapter_lookup_failed', `The adapter could not build its lookup call: ${lookupCompiled.errors.map((error) => `${error.path}: ${error.message}`).join('; ')}`);
    }
    let lookupRaw: UpstreamCallResult;
    try {
      lookupRaw = await call(lookup.tool, lookupCompiled.input);
    } catch (error) {
      return fail('adapter_lookup_failed', `Lookup call ${lookup.tool} failed: ${errorMessage(error)}`, { underlyingCalls: 1 });
    }
    calls = 1;
    const lookupResult = toExecResult(lookupRaw);
    if (!lookupResult.ok) {
      return fail('adapter_lookup_failed', `Lookup call ${lookup.tool} failed: ${lookupResult.error?.message ?? 'unknown error'}`, {
        underlyingCalls: 1,
        lookup: { tool: lookup.tool, input: lookupCompiled.input, ok: false, matchedId: null, matchCount: 0, candidates: [], error: lookupResult.error?.message ?? null },
      });
    }
    const resolution = resolveLookupMatches(lookup, args, lookupResult.content);
    lookupRecord = {
      tool: lookup.tool,
      input: lookupCompiled.input,
      ok: resolution.ok,
      matchedId: resolution.matchedId,
      matchCount: resolution.matchCount,
      candidates: resolution.candidates,
      error: resolution.error,
    };
    if (!resolution.ok || resolution.matchedId === null) {
      return {
        ok: false,
        result: {
          ok: false,
          error: {
            code: resolution.matchCount > 1 ? 'adapter_lookup_ambiguous' : 'adapter_lookup_no_match',
            message: resolution.error ?? 'The lookup did not resolve exactly one record. Nothing was changed.',
            details: { candidates: resolution.candidates },
          },
        },
        targetResult: null,
        compiled: { target: tool.target, input: null, notes: lookupCompiled.notes, errors: [resolution.error ?? 'lookup did not resolve'] },
        lookup: lookupRecord,
        underlyingCalls: 1,
      };
    }
    context = { matchedItem: resolution.matchedItem, bind: { path: lookup.bindTo, value: resolution.matchedId } };
  }

  const compiled = compileAdapterCall(tool, args, schemas, context);
  if (!compiled.ok || !compiled.input) {
    const errors = compiled.errors.map((error) => `${error.path}: ${error.message}`);
    return {
      ...fail('adapter_compile_failed', `The adapter could not compile this call into a valid ${tool.target} call: ${errors.join('; ')}`),
      compiled: { target: tool.target, input: null, notes: compiled.notes, errors },
      lookup: lookupRecord,
      underlyingCalls: calls,
    };
  }
  const targetSchema = schemas.get(tool.target);
  if (targetSchema) {
    const validation = validateAgainstSchema(targetSchema, compiled.input);
    if (!validation.ok) {
      return {
        ...fail('adapter_compile_failed', `Compiled input failed the ${tool.target} schema: ${validation.errors.join('; ')}`),
        compiled: { target: tool.target, input: compiled.input, notes: compiled.notes, errors: validation.errors },
        lookup: lookupRecord,
        underlyingCalls: calls,
      };
    }
  }

  let targetRaw: UpstreamCallResult;
  try {
    targetRaw = await call(tool.target, compiled.input);
  } catch (error) {
    return {
      ...fail('upstream_call_failed', `${tool.target} failed: ${errorMessage(error)}`),
      compiled: { target: tool.target, input: compiled.input, notes: compiled.notes, errors: [errorMessage(error)] },
      lookup: lookupRecord,
      underlyingCalls: calls + 1,
    };
  }
  const result = toExecResult(targetRaw);
  return {
    ok: result.ok,
    result,
    targetResult: targetRaw,
    compiled: { target: tool.target, input: compiled.input, notes: compiled.notes, errors: [] },
    lookup: lookupRecord,
    underlyingCalls: calls + 1,
  };
}
