import type { AdapterIssue, AdapterSpec, AdaptedToolSpec, JsonSchema } from '../core/types.js';
import { validateAdapter } from '../core/adapter.js';
import { AnvilError } from '../core/errors.js';
import { normalizeUpstreamSchema } from './schema.js';
import { globMatch, type ResolvedProxyConfig } from './config.js';
import type { UpstreamTool } from './upstream.js';

export type CatalogEntry =
  | {
      kind: 'adapted';
      name: string;
      description: string;
      inputSchema: JsonSchema;
      annotations: UpstreamTool['annotations'];
      spec: AdaptedToolSpec;
    }
  | {
      kind: 'passthrough';
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
      outputSchema?: Record<string, unknown>;
      annotations: UpstreamTool['annotations'];
      upstreamName: string;
    };

export interface ProxyCatalog {
  entries: CatalogEntry[];
  /** Normalized upstream schemas, keyed by upstream tool name (adapter compile + validation). */
  schemas: Map<string, JsonSchema>;
  /** Upstream tools annotated `readOnlyHint: true`: the only tools an adapter lookup may call. */
  readOnlyTools: Set<string>;
  hidden: Array<{ name: string; reason: string }>;
  warnings: string[];
  adapterIssues: AdapterIssue[];
}

/**
 * Decide what the client sees. Pure: no network, so it is unit-testable and
 * `anvil proxy --dry-run` can print it.
 *
 * - Adapted tools come first and are validated against the live upstream schemas.
 * - An adapted tool's target is hidden (unless `keepTargets`) so the model is
 *   not offered both the hard and the easy version of the same call.
 * - Remaining upstream tools pass through unchanged, filtered by include/exclude
 *   and optionally renamed or re-described.
 */
export function buildProxyCatalog(upstreamTools: UpstreamTool[], config: Pick<ResolvedProxyConfig, 'adapter' | 'tools'>): ProxyCatalog {
  const schemas = new Map(upstreamTools.map((tool) => [tool.name, normalizeUpstreamSchema(tool.inputSchema)]));
  const readOnlyTools = new Set(upstreamTools.filter((tool) => tool.annotations?.readOnlyHint === true).map((tool) => tool.name));
  const byName = new Map(upstreamTools.map((tool) => [tool.name, tool]));
  const warnings: string[] = [];
  const hidden: Array<{ name: string; reason: string }> = [];
  const entries: CatalogEntry[] = [];
  let adapterIssues: AdapterIssue[] = [];

  const adapter: AdapterSpec | null = config.adapter;
  const replacedTargets = new Set<string>();
  if (adapter) {
    const validation = validateAdapter(adapter, {
      toolSchemas: schemas,
      rawToolNames: upstreamTools.map((tool) => tool.name),
      readOnlyTools,
      allowReplacingTarget: true,
    });
    adapterIssues = validation.issues;
    const errors = validation.issues.filter((issue) => issue.severity === 'error');
    if (errors.length > 0) {
      throw new AnvilError(
        'adapter_invalid_for_upstream',
        `The adapter does not fit this upstream server:\n${errors.map((issue) => `  ${issue.path}: ${issue.message}`).join('\n')}`,
        400,
        { issues: errors },
      );
    }
    for (const tool of adapter.tools) {
      const target = byName.get(tool.target)!;
      entries.push({
        kind: 'adapted',
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        // The adapted tool does exactly what its target does, so it inherits the target's safety hints.
        annotations: target.annotations ? { ...target.annotations, title: undefined } : undefined,
        spec: tool,
      });
      replacedTargets.add(tool.target);
    }
  }

  const adaptedNames = new Set(entries.map((entry) => entry.name.toLowerCase()));
  const options = config.tools;
  for (const tool of upstreamTools) {
    if (options.passthrough === 'none') {
      hidden.push({ name: tool.name, reason: 'passthrough is "none"' });
      continue;
    }
    if (replacedTargets.has(tool.name) && (!options.keepTargets || adaptedNames.has(tool.name.toLowerCase()))) {
      hidden.push({ name: tool.name, reason: 'replaced by an adapted tool' });
      continue;
    }
    if (options.exclude.some((pattern) => globMatch(pattern, tool.name))) {
      hidden.push({ name: tool.name, reason: 'excluded' });
      continue;
    }
    if (options.include.length > 0 && !options.include.some((pattern) => globMatch(pattern, tool.name))) {
      hidden.push({ name: tool.name, reason: 'not in include list' });
      continue;
    }
    const override = options.overrides[tool.name];
    const name = override?.name ?? tool.name;
    if (adaptedNames.has(name.toLowerCase()) || entries.some((entry) => entry.name.toLowerCase() === name.toLowerCase())) {
      warnings.push(`Upstream tool "${tool.name}" would be exposed as "${name}", which is already taken; it is hidden.`);
      hidden.push({ name: tool.name, reason: 'name collision' });
      continue;
    }
    entries.push({
      kind: 'passthrough',
      name,
      description: override?.description ?? tool.description ?? '',
      inputSchema: tool.inputSchema,
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      annotations: tool.annotations,
      upstreamName: tool.name,
    });
  }

  for (const key of Object.keys(options.overrides)) {
    if (!byName.has(key)) warnings.push(`tools.overrides names "${key}", which the upstream server does not list.`);
  }
  for (const pattern of options.include) {
    if (!upstreamTools.some((tool) => globMatch(pattern, tool.name))) warnings.push(`tools.include pattern "${pattern}" matches no upstream tool.`);
  }
  if (entries.length === 0) warnings.push('No tools are exposed. Check passthrough, include and exclude.');
  return { entries, schemas, readOnlyTools, hidden, warnings, adapterIssues };
}
