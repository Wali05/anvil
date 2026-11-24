import type { OutputShape } from '../core/types.js';
import { isPlainObject } from '../core/util.js';
import { parsePickPath } from '../core/output.js';
import type { UpstreamCallResult } from './upstream.js';

/**
 * Declarative output shaping. Real APIs return far more than a model needs
 * (a GitHub issue is ~200 fields); every extra field costs tokens on every
 * later turn and gives the model more to misread. A shape keeps the fields
 * that matter, caps list lengths and caps total size, and always tells the
 * model what was cut so it never mistakes a truncated list for a complete one.
 *
 * Errors are never shaped: the model needs the whole message to recover.
 */

/** Keep only the picked paths. `[]` maps over an array; a path that is absent is skipped, never invented. */
export function pickPaths(value: unknown, paths: string[]): unknown {
  const parsed = paths.map((path) => parsePickPath(path)).filter((entry): entry is { ok: true; segments: string[] } => entry.ok).map((entry) => entry.segments);
  return pickSegments(value, parsed);
}

function pickSegments(value: unknown, paths: string[][]): unknown {
  if (paths.some((path) => path.length === 0)) return value;
  // A leading bare "[]" maps over the value itself.
  if (paths.every((path) => path[0] === '[]')) {
    if (!Array.isArray(value)) return undefined;
    const rest = paths.map((path) => path.slice(1));
    return value.map((item) => pickSegments(item, rest)).filter((item) => item !== undefined);
  }
  if (!isPlainObject(value)) return undefined;
  const groups = new Map<string, { map: boolean; rest: string[][] }>();
  for (const path of paths) {
    const head = path[0]!;
    if (head === '[]') continue;
    const map = head.endsWith('[]');
    const key = map ? head.slice(0, -2) : head;
    const group = groups.get(key) ?? { map, rest: [] };
    group.map = group.map || map;
    group.rest.push(path.slice(1));
    groups.set(key, group);
  }
  const out: Record<string, unknown> = {};
  for (const [key, group] of groups) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const child = value[key];
    if (group.map) {
      if (!Array.isArray(child)) continue;
      out[key] = group.rest.some((rest) => rest.length === 0) ? child : child.map((item) => pickSegments(item, group.rest)).filter((item) => item !== undefined);
    } else {
      const picked = pickSegments(child, group.rest);
      if (picked !== undefined) out[key] = picked;
    }
  }
  return out;
}

/** Cap every array at `maxItems`, recording which were cut. */
export function capArrays(value: unknown, maxItems: number, path = '', notes: string[] = []): unknown {
  if (Array.isArray(value)) {
    const kept = value.slice(0, maxItems).map((item, index) => capArrays(item, maxItems, `${path}[${index}]`, notes));
    if (value.length > maxItems) notes.push(`${path || 'result'}: showing ${maxItems} of ${value.length} items`);
    return kept;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) out[key] = capArrays(child, maxItems, path ? `${path}.${key}` : key, notes);
    return out;
  }
  return value;
}

export function resultChars(result: UpstreamCallResult): number {
  return (result.content ?? []).reduce((sum, part) => sum + (typeof part.text === 'string' ? part.text.length : 0), 0);
}

export interface ShapedResult {
  result: UpstreamCallResult;
  shaped: boolean;
  notes: string[];
}

/** Apply a shape to an upstream result. The result's own text is used when there is no structuredContent. */
export function shapeResult(result: UpstreamCallResult, shape: OutputShape | undefined): ShapedResult {
  if (!shape || result.isError) return { result, shaped: false, notes: [] };
  const textParts = (result.content ?? []).filter((part) => part.type === 'text' && typeof part.text === 'string');
  const otherParts = (result.content ?? []).filter((part) => !(part.type === 'text' && typeof part.text === 'string'));
  let data: unknown = result.structuredContent;
  let isJson = data !== undefined;
  if (!isJson && textParts.length === 1) {
    try {
      data = JSON.parse((textParts[0]!.text as string).trim());
      isJson = true;
    } catch {
      isJson = false;
    }
  }
  const notes: string[] = [];
  let text: string;
  if (isJson) {
    if (shape.pick) data = pickPaths(data, shape.pick) ?? null;
    if (shape.maxItems) data = capArrays(data, shape.maxItems, '', notes);
    text = JSON.stringify(data, null, 2);
  } else {
    text = textParts.map((part) => part.text as string).join('\n');
  }
  let truncated = false;
  if (shape.maxChars && text.length > shape.maxChars) {
    notes.push(`output truncated to ${shape.maxChars} of ${text.length} characters`);
    text = `${text.slice(0, shape.maxChars)}…`;
    truncated = true;
  }
  const content: Array<Record<string, unknown>> = [{ type: 'text', text }, ...otherParts];
  if (notes.length > 0) content.push({ type: 'text', text: `[anvil] ${notes.join('; ')}. Narrow the request (filters, a smaller page) to see the rest.` });
  const out: UpstreamCallResult = { content };
  // Structured content is kept only while it still matches the text (a truncated text has no complete JSON).
  if (isJson && !truncated && result.structuredContent !== undefined) out.structuredContent = data;
  return { result: out, shaped: true, notes };
}
