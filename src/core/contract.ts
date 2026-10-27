import type { OutputContract } from './types.js';

function extractCandidateObjects(text: string): string[] {
  const candidates: string[] = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of text.matchAll(fence)) {
    if (match[1]) candidates.push(match[1].trim());
  }
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) candidates.push(trimmed);
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          candidates.push(text.slice(start, index + 1));
          break;
        }
      }
    }
  }
  return candidates;
}

export function parseContractArray(finalAnswer: string, key: string): { ok: true; values: string[] } | { ok: false; reason: string } {
  const candidates = extractCandidateObjects(finalAnswer ?? '');
  if (candidates.length === 0) return { ok: false, reason: 'no JSON object found in the final answer' };
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        if (!(key in record)) continue;
        const value = record[key];
        if (!Array.isArray(value)) return { ok: false, reason: `"${key}" must be an array` };
        if (!value.every((entry) => typeof entry === 'string')) {
          return { ok: false, reason: `"${key}" must contain only strings` };
        }
        return { ok: true, values: value as string[] };
      }
    } catch {
      // Try the next candidate.
    }
  }
  return { ok: false, reason: `no parseable JSON object with a "${key}" array was found` };
}

export function jsonArrayContract(key: string, example: string, description: string): OutputContract {
  return {
    description,
    example,
    parse(finalAnswer) {
      const parsed = parseContractArray(finalAnswer, key);
      return parsed.ok ? { ok: true as const, value: parsed.values } : parsed;
    },
  };
}

export function parseNumberContract(finalAnswer: string, key: string): { ok: true; values: number[] } | { ok: false; reason: string } {
  const candidates = extractCandidateObjects(finalAnswer ?? '');
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        if (!(key in record)) continue;
        const value = record[key];
        if (!Array.isArray(value)) return { ok: false, reason: `"${key}" must be an array` };
        if (!value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))) {
          return { ok: false, reason: `"${key}" must contain only numbers` };
        }
        return { ok: true, values: value as number[] };
      }
    } catch {
      // Try the next candidate.
    }
  }
  return { ok: false, reason: `no parseable JSON object with a "${key}" array was found` };
}

export function numberArrayContract(key: string, example: string, description: string): OutputContract {
  return {
    description,
    example,
    parse(finalAnswer) {
      const parsed = parseNumberContract(finalAnswer, key);
      return parsed.ok ? { ok: true as const, value: parsed.values } : parsed;
    },
  };
}