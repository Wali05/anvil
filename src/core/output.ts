import { isPlainObject } from './util.js';

/** Validation for `output` shapes (see OutputShape). Applied by the proxy in src/proxy/output.ts. */

const PATH_SEGMENT = /^([A-Za-z_$][A-Za-z0-9_$-]*)?(\[\])?$/;

export function parsePickPath(path: string): { ok: true; segments: string[] } | { ok: false; reason: string } {
  if (typeof path !== 'string' || path.length === 0 || path.length > 200) return { ok: false, reason: 'must be a non-empty path up to 200 characters' };
  const segments = path.split('.');
  for (const segment of segments) {
    const match = PATH_SEGMENT.exec(segment);
    if (!match || (!match[1] && !match[2])) return { ok: false, reason: `segment "${segment}" must be a key, "key[]" or "[]"` };
    if (match[1] === '__proto__' || match[1] === 'constructor' || match[1] === 'prototype') return { ok: false, reason: `unsafe key "${match[1]}"` };
  }
  return { ok: true, segments };
}

export function validateOutputShape(shape: unknown, at: string): string[] {
  if (shape === undefined) return [];
  if (!isPlainObject(shape)) return [`${at} must be an object`];
  const errors: string[] = [];
  for (const key of Object.keys(shape)) {
    if (!['pick', 'maxItems', 'maxChars'].includes(key)) errors.push(`${at}.${key} is not a known output option (pick, maxItems, maxChars)`);
  }
  if (shape.pick !== undefined) {
    if (!Array.isArray(shape.pick) || shape.pick.length === 0 || shape.pick.length > 60) errors.push(`${at}.pick must list 1-60 paths`);
    else {
      shape.pick.forEach((path, index) => {
        const parsed = parsePickPath(path as string);
        if (!parsed.ok) errors.push(`${at}.pick[${index}] ${parsed.reason}`);
      });
    }
  }
  if (shape.maxItems !== undefined && (!Number.isInteger(shape.maxItems) || (shape.maxItems as number) < 1 || (shape.maxItems as number) > 1000)) {
    errors.push(`${at}.maxItems must be an integer from 1 to 1000`);
  }
  if (shape.maxChars !== undefined && (!Number.isInteger(shape.maxChars) || (shape.maxChars as number) < 200 || (shape.maxChars as number) > 1_000_000)) {
    errors.push(`${at}.maxChars must be an integer from 200 to 1000000`);
  }
  return errors;
}
