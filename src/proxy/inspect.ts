import { isPlainObject } from '../core/util.js';
import { normalizeUpstreamSchema } from './schema.js';
import type { UpstreamTool } from './upstream.js';

export type FindingSeverity = 'error' | 'warn' | 'info';

export interface Finding {
  rule: string;
  severity: FindingSeverity;
  tool: string | null;
  /** Dot path of the parameter, when the finding is about one. */
  param: string | null;
  message: string;
  /** What to change, and which adapter feature (if any) addresses it. */
  fix: string;
}

export interface ToolReport {
  name: string;
  score: number;
  params: number;
  maxDepth: number;
  estimatedTokens: number;
  findings: Finding[];
}

export interface InspectReport {
  schema: 'anvil.inspect/v1';
  server: { name: string | null; version: string | null; source: string };
  toolCount: number;
  estimatedTokens: number;
  score: number;
  counts: Record<FindingSeverity, number>;
  catalogFindings: Finding[];
  tools: ToolReport[];
}

/**
 * Function names the major tool-calling APIs accept (OpenAI-compatible and
 * Anthropic both use this pattern). Longer or dotted names get rejected or
 * silently rewritten by some clients.
 */
const PORTABLE_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const ID_PARAM = /(^id$|_id$|Id$|^uuid$|_uuid$)/;
const DATE_PARAM = /(date|time|_at$|At$|^start$|^end$|^since$|^until$|^due$|deadline|timestamp)/i;
const ENUMISH_PARAM = /(^|_)(status|state|type|kind|priority|severity|sort|order|direction|visibility|mode|level|role)$/i;
const QUERY_PARAM = /^(q|query|filter|filters|jql|sql|search|expression|where)$/i;
const LIMIT_PARAM = /(limit|per_?page|page_?size|max_?results|count|top|first|last)$/i;

interface Leaf {
  path: string;
  depth: number;
  required: boolean;
  schema: Record<string, unknown>;
}

function walk(schema: Record<string, unknown>, prefix: string, depth: number, requiredChain: boolean, out: Leaf[], objects: Leaf[]): void {
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  for (const [key, child] of Object.entries(properties)) {
    if (!isPlainObject(child)) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    const isRequired = requiredChain && required.has(key);
    if (child.type === 'object' && isPlainObject(child.properties) && Object.keys(child.properties).length > 0 && depth < 8) {
      objects.push({ path, depth, required: isRequired, schema: child });
      walk(child, path, depth + 1, isRequired, out, objects);
    } else {
      out.push({ path, depth, required: isRequired, schema: child });
    }
  }
}

function hasUnion(node: unknown, depth = 0): boolean {
  if (!isPlainObject(node) || depth > 10) return false;
  if (Array.isArray(node.anyOf) || Array.isArray(node.oneOf) || Array.isArray(node.allOf)) return true;
  if (isPlainObject(node.properties)) return Object.values(node.properties).some((child) => hasUnion(child, depth + 1));
  if (isPlainObject(node.items)) return hasUnion(node.items, depth + 1);
  return false;
}

function containsRef(node: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (Array.isArray(node)) return node.some((entry) => containsRef(entry, depth + 1));
  if (!isPlainObject(node)) return false;
  if (typeof node.$ref === 'string') return true;
  return Object.values(node).some((value) => containsRef(value, depth + 1));
}

function describes(schema: Record<string, unknown>): string {
  return typeof schema.description === 'string' ? schema.description : '';
}

function estimateTokens(value: unknown): number {
  return Math.ceil((JSON.stringify(value) ?? '').length / 4);
}

export function inspectTool(tool: UpstreamTool): ToolReport {
  const findings: Finding[] = [];
  const add = (rule: string, severity: FindingSeverity, param: string | null, message: string, fix: string) =>
    findings.push({ rule, severity, tool: tool.name, param, message, fix });
  const raw = isPlainObject(tool.inputSchema) ? tool.inputSchema : {};
  const schema = normalizeUpstreamSchema(raw) as unknown as Record<string, unknown>;
  const leaves: Leaf[] = [];
  const objects: Leaf[] = [];
  walk(schema, '', 1, true, leaves, objects);
  const maxDepth = leaves.reduce((max, leaf) => Math.max(max, leaf.depth), 0);
  const readOnly = tool.annotations?.readOnlyHint === true;

  if (!PORTABLE_NAME.test(tool.name)) {
    add('name-not-portable', 'error', null, `"${tool.name}" does not match ^[a-zA-Z0-9_-]{1,64}$, which several model APIs require for function names.`, 'Rename it with a proxy override (tools.overrides.<name>.name) or an adapted tool.');
  }
  const description = tool.description ?? '';
  if (description.trim().length < 20) {
    add('description-missing', 'warn', null, description.trim().length === 0 ? 'The tool has no description.' : `The description is only ${description.trim().length} characters.`, 'Say what the tool does, when to use it and what it returns (tools.overrides.<name>.description).');
  } else if (description.length > 1500) {
    add('description-long', 'info', null, `The description is ${description.length} characters; it is sent on every request.`, 'Move reference material out of the description and keep the when-to-use part.');
  }

  if (['anyOf', 'oneOf', 'allOf'].some((key) => Array.isArray(raw[key]))) {
    add('top-level-union', 'error', null, 'The input schema is a union at the top level. OpenAI-compatible APIs reject it and many models cannot choose a branch.', 'Expose one adapted tool per branch, each with a flat object schema.');
  }
  if (raw.type !== undefined && raw.type !== 'object') {
    add('input-not-object', 'error', null, `The input schema type is "${String(raw.type)}", not "object".`, 'Tool inputs must be JSON objects; wrap the value in an adapted tool.');
  }
  if (containsRef(raw)) {
    add('schema-refs', 'info', null, 'The schema uses $ref. Some clients and models do not resolve references and see an empty type.', 'An adapted tool inlines the shape as a flat schema (anvil scaffold does this).');
  }

  const undocumented = leaves.filter((leaf) => describes(leaf.schema).trim().length === 0 && leaf.schema.enum === undefined);
  if (leaves.length >= 2 && undocumented.length / leaves.length > 0.5) {
    add('params-undocumented', 'warn', null, `${undocumented.length} of ${leaves.length} parameters have no description (${undocumented.slice(0, 5).map((leaf) => leaf.path).join(', ')}${undocumented.length > 5 ? ', …' : ''}).`, 'Document units, formats and allowed values; the descriptions condition in the workbench measures how much this alone helps.');
  }

  for (const object of objects) {
    if (object.depth >= 1) {
      const childLeaves = leaves.filter((leaf) => leaf.path.startsWith(`${object.path}.`));
      const deepest = childLeaves.reduce((max, leaf) => Math.max(max, leaf.depth), 0);
      if (object.depth === 1 && deepest >= 3) {
        add('nested-input', object.required ? 'warn' : 'info', object.path, `"${object.path}" nests ${deepest - 1} levels deep (e.g. ${childLeaves.find((leaf) => leaf.depth === deepest)?.path}). Smaller models often misplace or flatten nested fields.`, 'Flatten it: an adapted tool with top-level fields mapped to the nested paths (anvil scaffold generates one).');
      } else if (object.depth === 1 && object.required && childLeaves.length >= 2) {
        add('nested-input', 'info', object.path, `Required object "${object.path}" wraps ${childLeaves.length} fields.`, 'Consider flattening it with an adapted tool.');
      }
    }
  }

  for (const leaf of leaves) {
    const s = leaf.schema;
    const name = leaf.path.split('.').pop()!;
    const doc = describes(s);
    if (Array.isArray(s.anyOf) || Array.isArray(s.oneOf)) {
      add('param-union', 'warn', leaf.path, `"${leaf.path}" accepts several shapes (anyOf/oneOf).`, 'Pick the shape models should use and expose only that one in an adapted tool.');
    }
    if (s.type === undefined && s.anyOf === undefined && s.oneOf === undefined && s.enum === undefined && s.const === undefined) {
      add('param-untyped', 'warn', leaf.path, `"${leaf.path}" has no type.`, 'Give it a type; models guess otherwise.');
    }
    if (s.type === 'array' && isPlainObject(s.items) && s.items.type === 'object') {
      add('array-of-objects', 'info', leaf.path, `"${leaf.path}" is an array of objects, which models often build with the wrong item shape.`, 'If items wrap one value (e.g. {email}), accept a list of strings and wrap it (wrapEmail-style mapping).');
    }
    if (s.type === 'string' && DATE_PARAM.test(name) && !/(zone|_tz$|^tz$|unit|format)/i.test(name) && s.format === undefined && s.pattern === undefined && !/(iso|rfc|yyyy|format|e\.g\.|example|\d{4}-\d{2})/i.test(doc)) {
      add('datetime-format-unstated', 'warn', leaf.path, `"${leaf.path}" looks like a date or time but states no format or time zone.`, 'Say the format (e.g. RFC 3339 with offset), or accept local time in an adapted tool and convert it (isoDateTime / dayStart transforms).');
    }
    if (s.type === 'string' && s.enum === undefined && ENUMISH_PARAM.test(name) && !/(one of|either|allowed|valid values|\||`)/i.test(doc)) {
      add('enum-unstated', 'info', leaf.path, `"${leaf.path}" looks like a fixed set of values but declares no enum.`, 'Declare the allowed values as an enum (adapters can map friendly values with valueMap).');
    }
    if (s.type === 'string' && QUERY_PARAM.test(name)) {
      add('query-dialect', 'warn', leaf.path, `"${leaf.path}" takes a free-text query. Models invent syntax the server does not support, then trust an empty result.`, 'Expose structured filter fields and assemble the query string in an adapted tool (bounded query assembly).');
    }
    if ((s.type === 'integer' || s.type === 'number') && typeof s.maximum === 'number' && LIMIT_PARAM.test(name) && !doc.includes(String(s.maximum))) {
      add('hidden-maximum', 'warn', leaf.path, `"${leaf.path}" has maximum ${s.maximum}, but the description does not say so. Models routinely ask for more and get a validation error.`, `State the limit in the description, or set a default in an adapted tool.`);
    }
    if (!readOnly && leaf.required && s.type === 'string' && ID_PARAM.test(name) && leaf.depth <= 2) {
      add('opaque-id-required', 'warn', leaf.path, `A write needs the opaque id "${leaf.path}". Models without the id at hand tend to guess one.`, 'Add an adapted tool with a read-only lookup: the model names the record, Anvil finds exactly one match and binds the id (or lists candidates and writes nothing).');
    }
  }

  const requiredCount = leaves.filter((leaf) => leaf.required).length;
  if (leaves.length > 15) add('many-params', 'info', null, `${leaves.length} parameters.`, 'Expose the commonly used subset in an adapted tool; set the rest with defaults or constants.');
  if (requiredCount > 6) add('many-required', 'info', null, `${requiredCount} required parameters.`, 'Use defaults or constants for values that rarely change.');
  if (tool.annotations?.readOnlyHint === undefined && tool.annotations?.destructiveHint === undefined) {
    add('annotations-missing', 'info', null, 'No readOnlyHint / destructiveHint annotation.', 'Annotate tools so clients can ask before destructive calls. Anvil lookups only use tools annotated readOnlyHint: true.');
  }

  const penalty = findings.reduce((sum, finding) => sum + (finding.severity === 'error' ? 30 : finding.severity === 'warn' ? 12 : 3), 0);
  return {
    name: tool.name,
    score: Math.max(0, 100 - penalty),
    params: leaves.length,
    maxDepth,
    estimatedTokens: estimateTokens({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }),
    findings,
  };
}

export function inspectCatalog(tools: UpstreamTool[], server: InspectReport['server']): InspectReport {
  const catalogFindings: Finding[] = [];
  const add = (rule: string, severity: FindingSeverity, message: string, fix: string) =>
    catalogFindings.push({ rule, severity, tool: null, param: null, message, fix });

  const seen = new Map<string, string>();
  for (const tool of tools) {
    const key = tool.name.toLowerCase();
    const other = seen.get(key);
    if (other) add('duplicate-names', 'error', `"${tool.name}" and "${other}" differ only by case.`, 'Rename one with a proxy override.');
    seen.set(key, tool.name);
  }
  if (tools.length > 40) {
    add('too-many-tools', 'warn', `${tools.length} tools. Tool-selection accuracy drops as catalogs grow, and every tool costs prompt tokens on every turn.`, 'Expose only what the task needs: tools.include / tools.exclude, or passthrough "none" with an adapter.');
  } else if (tools.length > 20) {
    add('many-tools', 'info', `${tools.length} tools.`, 'Consider hiding tools the agent does not need (tools.exclude).');
  }
  const reports = tools.map(inspectTool);
  const estimatedTokens = reports.reduce((sum, report) => sum + report.estimatedTokens, 0);
  if (estimatedTokens > 15_000) {
    add('catalog-tokens', 'warn', `The tool catalog is roughly ${estimatedTokens.toLocaleString('en-US')} tokens, sent with every model request.`, 'Hide unused tools and shorten long descriptions.');
  }
  const all = [...catalogFindings, ...reports.flatMap((report) => report.findings)];
  const counts: Record<FindingSeverity, number> = { error: 0, warn: 0, info: 0 };
  for (const finding of all) counts[finding.severity] += 1;
  const average = reports.length > 0 ? reports.reduce((sum, report) => sum + report.score, 0) / reports.length : 100;
  const catalogPenalty = catalogFindings.reduce((sum, finding) => sum + (finding.severity === 'error' ? 15 : finding.severity === 'warn' ? 8 : 2), 0);
  return {
    schema: 'anvil.inspect/v1',
    server,
    toolCount: tools.length,
    estimatedTokens,
    score: Math.max(0, Math.round(average - catalogPenalty)),
    counts,
    catalogFindings,
    tools: reports.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name)),
  };
}

const MARK: Record<FindingSeverity, string> = { error: '✖', warn: '▲', info: '·' };

export function formatInspectReport(report: InspectReport, options: { verbose?: boolean } = {}): string {
  const lines: string[] = [];
  lines.push(`Anvil inspect — ${report.server.name ?? 'unknown server'}${report.server.version ? ` ${report.server.version}` : ''}`);
  lines.push(`${report.server.source}`);
  lines.push('');
  lines.push(
    `Score ${report.score}/100 · ${report.toolCount} tools · ~${report.estimatedTokens.toLocaleString('en-US')} catalog tokens · ` +
      `${report.counts.error} errors, ${report.counts.warn} warnings, ${report.counts.info} notes`,
  );
  for (const finding of report.catalogFindings) {
    lines.push(`  ${MARK[finding.severity]} ${finding.message}`);
    lines.push(`      fix: ${finding.fix}`);
  }
  lines.push('');
  for (const tool of report.tools) {
    const visible = options.verbose ? tool.findings : tool.findings.filter((finding) => finding.severity !== 'info');
    lines.push(`${String(tool.score).padStart(3)}  ${tool.name}  (${tool.params} params, depth ${tool.maxDepth}, ~${tool.estimatedTokens} tokens)`);
    for (const finding of visible) {
      lines.push(`     ${MARK[finding.severity]} ${finding.param ? `${finding.param}: ` : ''}${finding.message}`);
      lines.push(`         fix: ${finding.fix}`);
    }
    const hiddenInfo = tool.findings.length - visible.length;
    if (hiddenInfo > 0) lines.push(`     · ${hiddenInfo} note(s); use --verbose to show`);
  }
  lines.push('');
  lines.push('Next: `anvil scaffold` writes a starter adapter for the nested tools; `anvil proxy --adapter <file>` serves it.');
  return `${lines.join('\n')}\n`;
}
