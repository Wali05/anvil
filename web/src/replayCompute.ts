/**
 * In-page versions of the two pure server endpoints the replay keeps working:
 * adapter validation and mapping preview. Same core functions as src/server/app.ts.
 */
import { parseAdapterSpec, previewAdapterCall, validateAdapter } from '../../src/core/adapter';
import { rawToolSchemaMap, readOnlyToolNames } from '../../src/core/interfaces';
import { validateAgainstSchema } from '../../src/core/schema';
import { requireDomain } from '../../src/domains/index';
import { getDefaultAdapter } from '../../src/domains/adapters';
import type { AdapterSpec } from '../../src/core/types';

function fail(message: string): never {
  throw Object.assign(new Error(message), { code: 'invalid_request' });
}

export function computeValidate(body: Record<string, unknown>): unknown {
  const domain = requireDomain(String(body.domain ?? ''));
  const parsed = parseAdapterSpec(body.adapter);
  if (!parsed.ok || !parsed.spec) return { ok: false, parseIssues: parsed.issues, issues: parsed.issues, validation: null };
  if (parsed.spec.domain !== domain.id) fail(`Adapter targets ${parsed.spec.domain}, not ${domain.id}.`);
  const validation = validateAdapter(parsed.spec, {
    toolSchemas: rawToolSchemaMap(domain),
    rawToolNames: domain.tools.map((tool) => tool.name),
    readOnlyTools: readOnlyToolNames(domain),
  });
  return {
    ok: validation.ok,
    parseIssues: parsed.issues,
    issues: validation.issues,
    validation,
    tools: parsed.spec.tools.map((tool) => ({ name: tool.name, target: tool.target, summary: tool.arguments.map((arg) => `${arg.from ?? 'const'} → ${arg.to}`) })),
  };
}

export function computePreview(body: Record<string, unknown>): unknown {
  const domain = requireDomain(String(body.domain ?? ''));
  let spec: AdapterSpec;
  if (body.adapter !== undefined) {
    const parsed = parseAdapterSpec(body.adapter);
    if (!parsed.ok || !parsed.spec) return { ok: false, issues: parsed.issues, originalCall: null };
    spec = parsed.spec;
    if (spec.domain !== domain.id) fail(`Adapter targets ${spec.domain}, not ${domain.id}.`);
  } else {
    const fallback = getDefaultAdapter(domain.id);
    if (!fallback) fail(`No adapter for ${domain.id}.`);
    spec = fallback;
  }
  const adapted = spec.tools.find((tool) => tool.name === String(body.tool ?? ''));
  if (!adapted) fail(`Adapter has no tool "${String(body.tool)}".`);
  const args = body.args ?? {};
  const inputValidation = validateAgainstSchema(adapted.inputSchema, args);
  if (!inputValidation.ok) return { ok: false, inputErrors: inputValidation.errors, issues: [], originalCall: null };
  const preview = previewAdapterCall(adapted, args as Record<string, unknown>, rawToolSchemaMap(domain));
  return {
    ok: preview.ok,
    lookupCall: preview.lookupCall,
    originalCall: preview.originalCall,
    notes: preview.notes,
    issues: preview.errors,
    executed: false,
  };
}
