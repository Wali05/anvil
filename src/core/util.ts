import { createHash } from 'node:crypto';
import type { JsonValue } from './types.js';

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) out[key] = sortValue(record[key]);
    return out;
  }
  return value;
}

export function hashJson(value: unknown): string {
  return sha256(stableStringify(value));
}

export function deepClone<T>(value: T): T {
  return structuredClone(value);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SAFE_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$|^\d+$/;

export function isUnsafeKey(key: string): boolean {
  return UNSAFE_KEYS.has(key);
}

export interface PathSplit {
  ok: boolean;
  segments: string[];
  reason?: string;
}

export function splitPath(path: string, allowNumeric = false): PathSplit {
  if (typeof path !== 'string' || path.length === 0) {
    return { ok: false, segments: [], reason: 'path is empty' };
  }
  if (path.length > 160) return { ok: false, segments: [], reason: 'path is too long' };
  const segments = path.split('.');
  for (const segment of segments) {
    if (segment.length === 0) return { ok: false, segments: [], reason: `path "${path}" has an empty segment` };
    if (isUnsafeKey(segment)) return { ok: false, segments: [], reason: `path "${path}" uses the unsafe key "${segment}"` };
    if (!SAFE_SEGMENT.test(segment)) {
      return { ok: false, segments: [], reason: `path segment "${segment}" must be an identifier or an array index` };
    }
    if (/^\d+$/.test(segment) && !allowNumeric) {
      return { ok: false, segments: [], reason: `path "${path}" may not index arrays` };
    }
  }
  return { ok: true, segments };
}

export function readPath(root: unknown, path: string): { found: boolean; value?: unknown; reason?: string } {
  const split = splitPath(path, true);
  if (!split.ok) return { found: false, reason: split.reason };
  let cursor: unknown = root;
  for (const segment of split.segments) {
    if (Array.isArray(cursor)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= cursor.length) {
        return { found: false, reason: `path "${path}" is absent at "${segment}"` };
      }
      cursor = cursor[index];
      continue;
    }
    if (!isPlainObject(cursor)) return { found: false, reason: `path "${path}" is absent at "${segment}"` };
    if (!Object.prototype.hasOwnProperty.call(cursor, segment)) {
      return { found: false, reason: `path "${path}" is absent at "${segment}"` };
    }
    cursor = cursor[segment];
  }
  return { found: true, value: cursor };
}

export function writePath(target: Record<string, unknown>, path: string, value: unknown): { ok: boolean; reason?: string } {
  const split = splitPath(path);
  if (!split.ok) return { ok: false, reason: split.reason };
  let cursor: Record<string, unknown> = target;
  for (let index = 0; index < split.segments.length - 1; index += 1) {
    const segment = split.segments[index]!;
    const existing = cursor[segment];
    if (existing === undefined) {
      const next: Record<string, unknown> = {};
      cursor[segment] = next;
      cursor = next;
    } else if (isPlainObject(existing)) {
      cursor = existing;
    } else {
      return { ok: false, reason: `cannot write "${path}" because "${segment}" is not an object` };
    }
  }
  const last = split.segments[split.segments.length - 1]!;
  cursor[last] = value;
  return { ok: true };
}

export function jsonValueOrUndefined(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return undefined;
  }
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}… [${value.length - max} chars truncated]`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function safeFileSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}