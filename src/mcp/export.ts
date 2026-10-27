import type { AdapterSpec, RunRecord } from '../core/types.js';
import { hashJson } from '../core/util.js';
import { APP_VERSION } from '../core/version.js';
import { buildConditionInterface } from '../core/interfaces.js';
import { requireDomain } from '../domains/index.js';
import { validateAdapter } from '../core/adapter.js';
import { rawToolSchemaMap, readOnlyToolNames } from '../core/interfaces.js';

export interface AdapterBundleInput {
  spec: AdapterSpec;
  adapterSource: 'default' | 'saved' | 'file';
  rootDir: string;
  run?: RunRecord | null;
}

export function adapterBundle(input: AdapterBundleInput): Record<string, unknown> {
  const domain = requireDomain(input.spec.domain);
  const validation = validateAdapter(input.spec, {
    toolSchemas: rawToolSchemaMap(domain),
    rawToolNames: domain.tools.map((tool) => tool.name),
    readOnlyTools: readOnlyToolNames(domain),
  });
  const hashes: Record<string, string> = {};
  for (const condition of ['original', 'descriptions', 'adapted'] as const) {
    hashes[condition] = buildConditionInterface(domain, condition, condition === 'adapted' ? input.spec : null).hash;
  }
  const cliPath = `${input.rootDir.replace(/\\/g, '/')}/dist/cli.js`;
  const bundleName = `anvil-adapter-${domain.id}`;
  const mcpConfig = {
    mcpServers: {
      [bundleName]: {
        command: 'node',
        args: ['<ANVIL_CLI_OR_CHECKOUT>/dist/cli.js', 'mcp', '--domain', domain.id, '--adapter-file', '<PATH_TO_THIS_BUNDLE_JSON>'],
      },
    },
  };
  return {
    schema: 'anvil.adapter-bundle/v1',
    exportedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    domain: {
      id: domain.id,
      name: domain.name,
      taskSetVersion: domain.taskSetVersion,
      environment: domain.environment,
    },
    adapterSource: input.adapterSource,
    adapterHash: hashJson(input.spec),
    interfaceHashes: hashes,
    adapter: input.spec,
    validation: {
      ok: validation.ok,
      toolCount: validation.toolCount,
      issues: validation.issues,
    },
    executionLimits: {
      oneToOne: input.spec.limits.oneToOne,
      maxUnderlyingCallsPerInvocation: input.spec.limits.maxUnderlyingCallsPerInvocation,
      lookupTools: input.spec.tools
        .filter((tool) => tool.lookup)
        .map((tool) => ({ name: tool.name, lookup: tool.lookup!.tool, match: tool.lookup!.match, bindTo: tool.lookup!.bindTo })),
      maxTools: input.spec.limits.maxTools,
      outputMapping: 'none (the original tool result is returned unchanged)',
      permissions: 'adapted calls run through the same original executor, schema validation and fixture permissions',
    },
    supportedOperations: [
      'rename fields and select nested input paths',
      'write nested target paths with dot notation',
      'constants and defaults',
      'enum value mapping',
      'local date-time to explicit UTC offset (declared +05:30 for this calendar fixture)',
      'start time plus duration to end time (declared, deterministic)',
      'wrap string emails into {email} objects and unwrap them',
      'assemble a bounded issue search query from explicit filter parts',
      'local date to start-of-day / start-of-next-day bounds',
      '(v2) one read-only lookup with exact, case-insensitive equality filters; exactly one match required, else no write',
      '(v2) new start plus the matched record\'s own duration to end time',
    ],
    limitationNotes: [
      input.spec.limits.maxUnderlyingCallsPerInvocation === 2
        ? 'Lookup tools make one read-only original call then exactly one target call; both are logged and counted. Every other public call compiles to exactly one original call. No other composition.'
        : 'One public call compiles to exactly one original call. Composition is not supported.',
      'Only input mapping is supported; original outputs are returned unchanged.',
      'Adapters cannot call eval, generate JavaScript, run shell commands, read validators or access task answers.',
      'The bundled fixture executor is a local demonstration connector, not a Google Calendar or GitHub production client.',
    ],
    mcpConfig,
    mcpConfigNotes: [
      'Replace <ANVIL_CLI_OR_CHECKOUT> with this checkout path and <PATH_TO_THIS_BUNDLE_JSON> with the exported bundle file.',
      'Alan\'s public contribution guide (checked 26 October 2026) currently requires remote HTTPS MCP servers; this local stdio command is for local MCP clients and is not an installed Alan integration.',
      `Ready local command in this checkout: node "${cliPath}" mcp --domain ${domain.id} --adapter ${input.adapterSource === 'saved' ? 'saved' : 'default'}`,
      'A future public deployment must expose an HTTPS MCP endpoint; none exists yet.',
    ],
    alanStatus: {
      installed: false,
      transportSupportedByPublicGuide: 'https',
      remoteUrl: null,
      pluginPackage: 'plugins/anvil',
      note: 'A plugin file is included in the repository. File presence is not installation.',
    },
    evidence: input.run
      ? {
          runId: input.run.id,
          evidenceClass: input.run.provenance.evidenceClass,
          mode: input.run.mode,
          modelIdentity: input.run.provenance.modelIdentity,
          summary: input.run.summary,
          generatedAt: input.run.finishedAt,
        }
      : null,
    run: input.run ?? null,
  };
}

export function bundleFileName(domain: string, suffix = ''): string {
  return `anvil-adapter-${domain}${suffix}.json`;
}

export function evidenceFileName(run: RunRecord): string {
  return `anvil-evidence-${run.id}.json`;
}