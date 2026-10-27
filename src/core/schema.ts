import Ajv, { type ErrorObject } from 'ajv';
import addFormats from 'ajv-formats';
import type { JsonSchema, JsonSchemaProperty } from './types.js';
import { hashJson, isPlainObject, isUnsafeKey, splitPath } from './util.js';

const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
addFormats(ajv);

const validatorCache = new Map<string, ReturnType<typeof ajv.compile>>();

export interface SchemaValidation {
  ok: boolean;
  errors: string[];
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string[] {
  if (!errors || errors.length === 0) return ['value does not match the schema'];
  return errors.map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`);
}

export function validateAgainstSchema(schema: object, value: unknown): SchemaValidation {
  const key = hashJson(schema);
  let validate = validatorCache.get(key);
  if (!validate) {
    try {
      validate = ajv.compile(schema);
    } catch (error) {
      return { ok: false, errors: [`schema could not be compiled: ${(error as Error).message}`] };
    }
    validatorCache.set(key, validate);
  }
  const ok = validate(value) as boolean;
  return { ok, errors: ok ? [] : formatAjvErrors(validate.errors) };
}

/** Deep-clone a schema and strip documentation fields used by the descriptions condition. */
export function stripDescriptions<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => stripDescriptions(item)) as unknown as T;
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === 'description' || key === 'title' || key === 'examples' || key === '$comment') continue;
      out[key] = stripDescriptions(item);
    }
    return out as T;
  }
  return value;
}

export function schemasEquivalentIgnoringDescriptions(a: object, b: object): boolean {
  return hashJson(stripDescriptions(a)) === hashJson(stripDescriptions(b));
}

const FORBIDDEN_SCHEMA_KEYS = new Set(['$ref', 'oneOf', 'anyOf', 'allOf', 'not', 'if', 'then', 'else', 'patternProperties', 'dependencies', 'dependentSchemas']);

export interface AdapterSchemaCheck {
  ok: boolean;
  errors: string[];
}

export function validateAdapterInputSchema(schema: unknown, path = 'inputSchema'): AdapterSchemaCheck {
  const errors: string[] = [];
  if (!isPlainObject(schema)) return { ok: false, errors: [`${path} must be an object`] };
  if (schema.type !== 'object') errors.push(`${path}.type must be "object"`);
  if (!isPlainObject(schema.properties)) errors.push(`${path}.properties must be an object`);
  if (schema.additionalProperties !== false) {
    errors.push(`${path}.additionalProperties must be false so extra inputs are rejected`);
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required)) errors.push(`${path}.required must be an array`);
    else {
      for (const name of schema.required) {
        if (typeof name !== 'string') errors.push(`${path}.required entries must be strings`);
        else if (!isPlainObject(schema.properties) || !(name in schema.properties)) {
          errors.push(`${path}.required references unknown property "${name}"`);
        }
      }
    }
  }
  if (isPlainObject(schema.properties)) {
    const props = schema.properties as Record<string, unknown>;
    if (Object.keys(props).length > 30) errors.push(`${path} may declare at most 30 properties`);
    for (const [key, property] of Object.entries(props)) {
      if (isUnsafeKey(key)) errors.push(`${path}.properties contains the unsafe key "${key}"`);
      else if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        errors.push(`${path}.properties key "${key}" must be an identifier`);
      }
      errors.push(...validateProperty(property, `${path}.properties.${key}`, 1));
    }
  }
  for (const key of Object.keys(schema)) {
    if (FORBIDDEN_SCHEMA_KEYS.has(key)) errors.push(`${path}.${key} is not supported by Anvil adapters`);
  }
  return { ok: errors.length === 0, errors };
}

function validateProperty(property: unknown, path: string, depth: number): string[] {
  const errors: string[] = [];
  if (depth > 5) return [`${path} is nested too deeply`];
  if (!isPlainObject(property)) return [`${path} must be an object`];
  for (const key of Object.keys(property)) {
    if (FORBIDDEN_SCHEMA_KEYS.has(key)) errors.push(`${path}.${key} is not supported by Anvil adapters`);
  }
  const type = property.type;
  if (type === 'string' || type === 'integer' || type === 'number' || type === 'boolean') {
    if (property.enum !== undefined && !Array.isArray(property.enum)) {
      errors.push(`${path}.enum must be an array`);
    }
    if (property.description !== undefined && typeof property.description !== 'string') {
      errors.push(`${path}.description must be a string`);
    }
    return errors;
  }
  if (type === 'array') {
    if (property.items === undefined) errors.push(`${path}.items is required for arrays`);
    else errors.push(...validateProperty(property.items, `${path}.items`, depth + 1));
    if (property.minItems !== undefined && typeof property.minItems !== 'number') errors.push(`${path}.minItems must be a number`);
    return errors;
  }
  if (type === 'object') {
    if (!isPlainObject(property.properties)) errors.push(`${path}.properties must be an object`);
    else {
      for (const [key, child] of Object.entries(property.properties)) {
        if (isUnsafeKey(key)) errors.push(`${path}.properties contains the unsafe key "${key}"`);
        else if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) errors.push(`${path}.properties key "${key}" must be an identifier`);
        errors.push(...validateProperty(child, `${path}.properties.${key}`, depth + 1));
      }
    }
    if (property.additionalProperties !== undefined && typeof property.additionalProperties !== 'boolean') {
      errors.push(`${path}.additionalProperties must be a boolean`);
    }
    return errors;
  }
  errors.push(`${path}.type must be one of string, integer, number, boolean, array, object`);
  return errors;
}

export interface SchemaPathInfo {
  exists: boolean;
  property?: JsonSchemaProperty;
  required: boolean;
  reason?: string;
}

/** Resolve a dot path through object properties, reporting requiredness. */
export function resolveSchemaPath(schema: JsonSchema, path: string): SchemaPathInfo {
  const split = splitPath(path);
  if (!split.ok) return { exists: false, required: false, reason: split.reason };
  let cursor: JsonSchema | JsonSchemaProperty = schema;
  let required = true;
  for (let index = 0; index < split.segments.length; index += 1) {
    const segment = split.segments[index]!;
    if (cursor.type !== 'object') {
      return { exists: false, required: false, reason: `"${path}" traverses a non-object` };
    }
    const properties: Record<string, JsonSchemaProperty> | undefined = cursor.properties;
    if (!properties || !Object.prototype.hasOwnProperty.call(properties, segment)) {
      return { exists: false, required: false, reason: `"${path}" does not exist in the target schema` };
    }
    required = required && (cursor.required ?? []).includes(segment);
    cursor = properties[segment]!;
  }
  return { exists: true, property: cursor as JsonSchemaProperty, required };
}

/**
 * Every required field (top-level and nested-object) that a complete target call must set.
 * Arrays are treated as leaves: their whole value is mapped at once.
 */
export function requiredTargetPaths(schema: JsonSchema, prefix = ''): string[] {
  const paths: string[] = [];
  const required = schema.required ?? [];
  for (const key of required) {
    const child = schema.properties[key];
    const path = prefix ? `${prefix}.${key}` : key;
    paths.push(path);
    if (child && child.type === 'object') paths.push(...requiredTargetPaths({ ...child, type: 'object' }, path));
  }
  return paths;
}

export function propertyKind(property: JsonSchemaProperty | undefined): string {
  if (!property) return 'unknown';
  if (property.type === 'array') return `array<${property.items.type}>`;
  return property.type;
}