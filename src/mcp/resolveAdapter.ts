import { readFile } from 'node:fs/promises';
import type { AdapterSpec } from '../core/types.js';
import type { Store } from '../core/store.js';
import { getDefaultAdapter } from '../domains/adapters.js';
import { parseAdapterSpec, validateAdapter } from '../core/adapter.js';
import { rawToolSchemaMap, readOnlyToolNames } from '../core/interfaces.js';
import { requireDomain } from '../domains/index.js';
import { AnvilError } from '../core/errors.js';

export interface ResolveAdapterInput {
  domain: string;
  source: 'default' | 'saved' | 'file';
  file?: string;
  store: Store;
}

export async function resolveAdapterSpec(input: ResolveAdapterInput): Promise<{ spec: AdapterSpec; source: 'default' | 'saved' | 'file' }> {
  const domain = requireDomain(input.domain);
  let spec: AdapterSpec | undefined;
  let source: 'default' | 'saved' | 'file' = input.source;
  if (input.source === 'file') {
    if (!input.file) throw new AnvilError('adapter_file_required', '--adapter-file requires a path.');
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(input.file, 'utf8'));
    } catch (error) {
      throw new AnvilError('adapter_file_unreadable', `Could not read adapter file: ${(error as Error).message}`);
    }
    if (parsed && typeof parsed === 'object' && (parsed as { schema?: unknown }).schema === 'anvil.adapter-bundle/v1') {
      parsed = (parsed as { adapter?: unknown }).adapter;
    }
    const result = parseAdapterSpec(parsed);
    if (!result.ok || !result.spec) {
      throw new AnvilError('adapter_invalid', 'The adapter file is invalid.', 400, {
        issues: result.issues.filter((issue) => issue.severity === 'error'),
      });
    }
    spec = result.spec;
  } else if (input.source === 'saved') {
    const saved = await input.store.getSavedAdapter(domain.id);
    if (!saved) throw new AnvilError('adapter_missing', `No saved adapter exists for ${domain.id}.`);
    spec = saved.spec;
    source = 'saved';
  } else {
    spec = getDefaultAdapter(domain.id);
    if (!spec) throw new AnvilError('adapter_missing', `No default adapter exists for ${domain.id}.`);
    source = 'default';
  }
  const validation = validateAdapter(spec, {
    toolSchemas: rawToolSchemaMap(domain),
    rawToolNames: domain.tools.map((tool) => tool.name),
    readOnlyTools: readOnlyToolNames(domain),
  });
  if (!validation.ok) {
    throw new AnvilError('adapter_invalid', 'The adapter failed validation.', 400, {
      issues: validation.issues.filter((issue) => issue.severity === 'error'),
    });
  }
  if (spec.domain !== domain.id) {
    throw new AnvilError('adapter_domain_mismatch', `Adapter targets ${spec.domain}, not ${domain.id}.`);
  }
  return { spec, source };
}