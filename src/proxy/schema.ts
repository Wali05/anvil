import type { JsonSchema } from '../core/types.js';
import { isPlainObject } from '../core/util.js';

/**
 * Upstream MCP servers emit whatever JSON Schema their framework produces:
 * Pydantic and zod output local `$ref`s into `$defs`, nullable fields as
 * `anyOf: [X, {type: "null"}]` or `type: ["string", "null"]`, and objects
 * without an explicit `type`. The adapter compiler resolves dot paths through
 * plain `properties`, so this normalizes a schema into that shape:
 *
 * - local `$ref` (`#/$defs/...`, `#/definitions/...`) is inlined (cycles stop at a depth limit)
 * - `anyOf` / `oneOf` with exactly one non-null branch collapses to that branch
 * - single-entry `allOf` collapses to its entry
 * - `type: [T, "null"]` becomes `type: T`
 * - a node with `properties` but no `type` becomes `type: "object"`
 *
 * Collapsing nullable unions only removes the option to send `null`, which an
 * adapter never writes, so a compiled call valid against the normalized schema
 * is valid against the original. Everything else is kept as is, and the
 * upstream server still validates every call itself.
 */
export function normalizeUpstreamSchema(raw: unknown): JsonSchema {
  if (!isPlainObject(raw)) return { type: 'object', properties: {} };
  const defs = {
    ...(isPlainObject(raw.$defs) ? raw.$defs : {}),
    ...(isPlainObject(raw.definitions) ? raw.definitions : {}),
  } as Record<string, unknown>;
  const normalized = normalizeNode(raw, defs, 0) as Record<string, unknown>;
  delete normalized.$defs;
  delete normalized.definitions;
  delete normalized.$schema;
  if (normalized.type !== 'object') normalized.type = 'object';
  if (!isPlainObject(normalized.properties)) normalized.properties = {};
  return normalized as unknown as JsonSchema;
}

const MAX_DEPTH = 12;

function resolveRef(ref: string, defs: Record<string, unknown>): unknown {
  const match = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref);
  if (!match) return undefined;
  return defs[decodeURIComponent(match[1]!.replace(/~1/g, '/').replace(/~0/g, '~'))];
}

function isNullSchema(node: unknown): boolean {
  return isPlainObject(node) && (node.type === 'null' || (Array.isArray(node.enum) && node.enum.length === 1 && node.enum[0] === null));
}

function normalizeNode(node: unknown, defs: Record<string, unknown>, depth: number): unknown {
  if (Array.isArray(node)) return node.map((entry) => normalizeNode(entry, defs, depth + 1));
  if (!isPlainObject(node)) return node;
  if (depth > MAX_DEPTH) return { ...node };

  let current: Record<string, unknown> = { ...node };

  if (typeof current.$ref === 'string') {
    const target = resolveRef(current.$ref, defs);
    if (isPlainObject(target)) {
      const { $ref: _ref, ...siblings } = current;
      current = { ...target, ...siblings };
    }
  }

  for (const key of ['anyOf', 'oneOf'] as const) {
    const branches = current[key];
    if (Array.isArray(branches)) {
      const nonNull = branches.filter((branch) => !isNullSchema(branch));
      if (nonNull.length === 1 && isPlainObject(nonNull[0])) {
        const { [key]: _union, ...rest } = current;
        const branch = normalizeNode(nonNull[0], defs, depth + 1) as Record<string, unknown>;
        current = { ...branch, ...rest };
        if (rest.description === undefined && branch.description !== undefined) current.description = branch.description;
      }
    }
  }

  if (Array.isArray(current.allOf) && current.allOf.length === 1 && isPlainObject(current.allOf[0])) {
    const { allOf, ...rest } = current;
    current = { ...(normalizeNode(allOf[0], defs, depth + 1) as Record<string, unknown>), ...rest };
  }

  if (Array.isArray(current.type)) {
    const types = current.type.filter((type) => type !== 'null');
    if (types.length === 1) current.type = types[0];
  }

  if (current.type === undefined && isPlainObject(current.properties)) current.type = 'object';

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(current)) {
    if (key === 'properties' && isPlainObject(value)) {
      const props: Record<string, unknown> = {};
      for (const [name, child] of Object.entries(value)) props[name] = normalizeNode(child, defs, depth + 1);
      out.properties = props;
    } else if (key === 'items' || key === 'additionalProperties') {
      out[key] = normalizeNode(value, defs, depth + 1);
    } else if (key === 'anyOf' || key === 'oneOf' || key === 'allOf') {
      out[key] = normalizeNode(value, defs, depth + 1);
    } else {
      out[key] = value;
    }
  }
  return out;
}
