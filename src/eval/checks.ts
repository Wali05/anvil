import type { CheckResult } from '../core/types.js';
import { extractCandidateObjects } from '../core/contract.js';
import { isPlainObject, readPath, stableStringify } from '../core/util.js';
import { toExecResult, type UpstreamCallResult } from '../proxy/upstream.js';
import type { EvalCheck } from './tasks.js';

export interface RecordedUpstreamCall {
  tool: string;
  input: unknown;
  ok: boolean;
  role: 'lookup' | 'target';
}

/**
 * Deep subset: every key in `expected` must be in `actual` with a matching value.
 * Arrays must have the same length and match element by element, or as a set when
 * `unordered` (each expected element matched by a distinct actual element).
 */
export function matchesSubset(actual: unknown, expected: unknown, unordered = false): boolean {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    if (!unordered) return expected.every((item, index) => matchesSubset(actual[index], item, unordered));
    const used = new Set<number>();
    return expected.every((item) => {
      const found = actual.findIndex((candidate, index) => !used.has(index) && matchesSubset(candidate, item, unordered));
      if (found < 0) return false;
      used.add(found);
      return true;
    });
  }
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) return false;
    return Object.entries(expected).every(([key, value]) => Object.prototype.hasOwnProperty.call(actual, key) && matchesSubset(actual[key], value, unordered));
  }
  return actual === expected;
}

function short(value: unknown, max = 240): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text === undefined ? 'undefined' : text.length > max ? `${text.slice(0, max)}…` : text;
}

function list(value: string | string[] | undefined): string[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

/** The answer's JSON objects, most complete first. */
function answerObjects(answer: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const candidate of extractCandidateObjects(answer)) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (isPlainObject(parsed)) out.push(parsed);
    } catch {
      // not JSON
    }
  }
  return out;
}

/** Checks that only need the trial's record (no upstream call). */
export function evaluateTraceCheck(check: EvalCheck, index: number, calls: RecordedUpstreamCall[], answer: string): CheckResult | null {
  const id = `${check.kind}-${index}`;
  if (check.kind === 'called') {
    const matching = calls.filter((call) => call.tool === check.tool && call.ok && call.role === 'target' && (check.args === undefined || matchesSubset(call.input, check.args)));
    const ok = check.times !== undefined ? matching.length === check.times : matching.length >= 1;
    const attempted = calls.filter((call) => call.tool === check.tool);
    return {
      id,
      kind: 'intent',
      label: check.label ?? `${check.tool} called${check.args !== undefined ? ` with ${short(check.args, 120)}` : ''}${check.times !== undefined ? ` exactly ${check.times}×` : ''}`,
      ok,
      detail: ok
        ? `${matching.length} matching call(s).`
        : attempted.length === 0
          ? `${check.tool} was never called.`
          : `${matching.length} matching successful call(s) of ${attempted.length}; inputs were ${attempted.slice(0, 3).map((call) => short(call.input, 160)).join(' | ')}.`,
    };
  }
  if (check.kind === 'not_called') {
    const hits = calls.filter((call) => call.tool === check.tool && call.role === 'target' && (check.args === undefined || matchesSubset(call.input, check.args)));
    return {
      id,
      kind: 'preservation',
      label: check.label ?? `${check.tool} not called${check.args !== undefined ? ` with ${short(check.args, 120)}` : ''}`,
      ok: hits.length === 0,
      detail: hits.length === 0 ? 'No such call reached the upstream.' : `${hits.length} call(s) reached the upstream, e.g. ${short(hits[0]!.input, 160)}.`,
    };
  }
  if (check.kind === 'answer') {
    const lower = answer.toLowerCase();
    const missing = list(check.contains).filter((needle) => !lower.includes(needle.toLowerCase()));
    const present = list(check.notContains).filter((needle) => lower.includes(needle.toLowerCase()));
    const regexOk = check.regex === undefined || new RegExp(check.regex, 'i').test(answer);
    let jsonOk = true;
    let jsonDetail = '';
    if (check.json) {
      const objects = answerObjects(answer);
      jsonOk = objects.some((object) => matchesSubset(object, check.json, check.unordered === true));
      if (!jsonOk) jsonDetail = objects.length === 0 ? 'no JSON object in the answer' : `answer JSON ${short(objects[0], 160)} does not match ${short(check.json, 160)}`;
    }
    const ok = missing.length === 0 && present.length === 0 && regexOk && jsonOk;
    const problems = [
      missing.length > 0 ? `missing ${missing.map((value) => JSON.stringify(value)).join(', ')}` : '',
      present.length > 0 ? `contains ${present.map((value) => JSON.stringify(value)).join(', ')}` : '',
      regexOk ? '' : `does not match /${check.regex}/`,
      jsonDetail,
    ].filter((part) => part.length > 0);
    return {
      id,
      kind: 'contract',
      label: check.label ?? 'final answer',
      ok,
      detail: ok ? 'The answer matches.' : `${problems.join('; ')}. Answer: ${short(answer, 200) || '(empty)'}`,
    };
  }
  if (check.kind === 'max_calls') {
    const total = calls.length;
    return {
      id,
      kind: 'hygiene',
      label: check.label ?? `at most ${check.max} upstream calls`,
      ok: total <= check.max,
      detail: `${total} upstream call(s).`,
    };
  }
  return null;
}

/** A state check: Anvil reads the upstream itself after the trial. */
export async function evaluateStateCheck(
  check: Extract<EvalCheck, { kind: 'state' }>,
  index: number,
  callUpstream: (tool: string, args: Record<string, unknown>) => Promise<UpstreamCallResult>,
): Promise<CheckResult> {
  const id = `state-${index}`;
  const label = check.label ?? `state: ${check.call.tool}${check.path ? ` → ${check.path}` : ''}`;
  let raw: UpstreamCallResult;
  try {
    raw = await callUpstream(check.call.tool, check.call.args ?? {});
  } catch (error) {
    return { id, kind: 'intent', label, ok: false, detail: `Could not read state: ${(error as Error).message}` };
  }
  const parsed = toExecResult(raw);
  if (!parsed.ok) return { id, kind: 'intent', label, ok: false, detail: `The state call failed: ${parsed.error?.message ?? 'unknown error'}` };
  let value: unknown = parsed.content;
  if (check.path) {
    const read = readPath(value, check.path);
    if (!read.found) return { id, kind: 'intent', label, ok: false, detail: `"${check.path}" is absent in ${short(value, 160)}.` };
    value = read.value;
  }
  const problems: string[] = [];
  if (check.equals !== undefined && stableStringify(value) !== stableStringify(check.equals)) problems.push(`expected ${short(check.equals, 160)}`);
  if (check.contains !== undefined) {
    // A single expected item against a list means "some item matches".
    const ok = Array.isArray(value) && !Array.isArray(check.contains) ? value.some((item) => matchesSubset(item, check.contains)) : matchesSubset(value, check.contains);
    if (!ok) problems.push(`expected to contain ${short(check.contains, 160)}`);
  }
  if (check.count !== undefined) {
    if (!Array.isArray(value)) problems.push(`expected an array of ${check.count}`);
    else if (value.length !== check.count) problems.push(`expected ${check.count} item(s), found ${value.length}`);
  }
  return {
    id,
    kind: 'intent',
    label,
    ok: problems.length === 0,
    detail: problems.length === 0 ? `Matches (${short(value, 120)}).` : `${problems.join('; ')}; got ${short(value, 200)}.`,
  };
}
