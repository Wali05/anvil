import { describe, expect, it } from 'vitest';
import { compileAdapterCall, parseAdapterSpec, validateAdapter } from '../src/core/adapter.js';
import { buildConditionInterface, rawToolSchemaMap, readOnlyToolNames } from '../src/core/interfaces.js';
import { schemasEquivalentIgnoringDescriptions, stripDescriptions } from '../src/core/schema.js';
import { calendarDomain } from '../src/domains/calendar/index.js';
import { issueDomain } from '../src/domains/issues/index.js';
import { calendarAdapter } from '../src/domains/calendar/adapter.js';
import { issueAdapter } from '../src/domains/issues/adapter.js';
import type { AdapterSpec, DomainDefinition } from '../src/core/types.js';

function validate(domain: DomainDefinition, spec: unknown) {
  const parsed = parseAdapterSpec(spec);
  if (!parsed.ok || !parsed.spec) return { parsed, validation: null };
  return {
    parsed,
    validation: validateAdapter(parsed.spec, {
      toolSchemas: rawToolSchemaMap(domain),
      rawToolNames: domain.tools.map((tool) => tool.name),
      readOnlyTools: readOnlyToolNames(domain),
    }),
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function firstTool(spec: AdapterSpec) {
  return spec.tools[0]!;
}

describe('adapter specification validation', () => {
  it('accepts both built-in adapters', () => {
    for (const [domain, spec] of [
      [calendarDomain, calendarAdapter],
      [issueDomain, issueAdapter],
    ] as const) {
      const { parsed, validation } = validate(domain, spec);
      expect(parsed.ok).toBe(true);
      expect(validation?.ok).toBe(true);
      expect(validation?.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    }
  });

  it('rejects a wrong spec version and unknown domain', () => {
    const { parsed } = validate(calendarDomain, { ...clone(calendarAdapter), schema: 'anvil.adapter/v9' });
    expect(parsed.ok).toBe(false);
    expect(parsed.issues.some((issue) => issue.path === '$.schema')).toBe(true);
  });

  it('rejects duplicate tool names and a name colliding with a raw tool', () => {
    const duplicate = clone(calendarAdapter) as AdapterSpec;
    duplicate.tools[1]!.name = duplicate.tools[0]!.name;
    const duplicateResult = validate(calendarDomain, duplicate);
    expect(duplicateResult.parsed.ok && duplicateResult.validation?.ok).toBe(false);

    const collision = clone(calendarAdapter) as AdapterSpec;
    collision.tools[0]!.name = 'calendar_list_events';
    const { validation } = validate(calendarDomain, collision);
    expect(validation?.ok).toBe(false);
    expect(validation?.issues.some((issue) => issue.message.includes('collides with an original tool'))).toBe(true);
  });

  it('rejects an unknown target and a missing required target field', () => {
    const unknownTarget = clone(calendarAdapter) as AdapterSpec;
    unknownTarget.tools[0]!.target = 'calendar_nonexistent';
    expect(validate(calendarDomain, unknownTarget).validation?.ok).toBe(false);

    const missingRequired = clone(calendarAdapter) as AdapterSpec;
    missingRequired.tools[0]!.arguments = missingRequired.tools[0]!.arguments.filter((arg) => arg.to !== 'time_min');
    const { validation } = validate(calendarDomain, missingRequired);
    expect(validation?.ok).toBe(false);
    expect(validation?.issues.some((issue) => issue.message.includes('time_min'))).toBe(true);
  });

  it('rejects unsafe object keys and prototype paths', () => {
    const spec = clone(calendarAdapter) as AdapterSpec;
    spec.tools[0]!.arguments.push({ to: '__proto__.polluted', from: 'from', transform: { kind: 'identity' } });
    const { validation } = validate(calendarDomain, spec);
    expect(validation?.ok).toBe(false);

    const protoFrom = clone(calendarAdapter) as AdapterSpec;
    protoFrom.tools[0]!.arguments[0] = { to: 'calendar_id', from: '__proto__.x' };
    expect(validate(calendarDomain, protoFrom).validation?.ok).toBe(false);
  });

  it('rejects unsafe keys nested inside constants and defaults', () => {
    const spec = clone(calendarAdapter) as AdapterSpec;
    spec.tools[0]!.arguments[0] = {
      to: 'calendar_id',
      const: JSON.parse('{"__proto__":{"polluted":true}}') as never,
    };
    const { validation } = validate(calendarDomain, spec);
    expect(validation?.ok).toBe(false);
    expect(validation?.issues.some((issue) => issue.message.includes('unsafe object keys'))).toBe(true);
  });

  it('rejects a declared input that is never mapped', () => {
    const spec = clone(calendarAdapter) as AdapterSpec;
    spec.tools[0]!.inputSchema.properties.unused = { type: 'string' };
    const { validation } = validate(calendarDomain, spec);
    expect(validation?.ok).toBe(false);
    expect(validation?.issues.some((issue) => issue.message.includes('never mapped'))).toBe(true);
  });

  it('rejects an ambiguous mapping that sets both from and const', () => {
    const spec = clone(calendarAdapter) as AdapterSpec;
    spec.tools[0]!.arguments[0] = { to: 'calendar_id', from: 'from', const: 'primary' };
    expect(validate(calendarDomain, spec).validation?.ok).toBe(false);
  });

  it('rejects unsupported transforms and requires a closed adapted schema', () => {
    const badTransform = clone(calendarAdapter) as AdapterSpec;
    badTransform.tools[0]!.arguments[1] = {
      to: 'time_min',
      from: 'from',
      transform: { kind: 'evalJavaScript' } as never,
    };
    expect(validate(calendarDomain, badTransform).validation?.ok).toBe(false);

    const openSchema = clone(calendarAdapter) as AdapterSpec;
    delete (openSchema.tools[0]!.inputSchema as { additionalProperties?: boolean }).additionalProperties;
    const openResult = validate(calendarDomain, openSchema);
    expect(openResult.parsed.ok && openResult.validation?.ok).toBe(false);

    const refSchema = clone(calendarAdapter) as AdapterSpec;
    (refSchema.tools[0]!.inputSchema.properties as Record<string, unknown>).from = { $ref: '#/definitions/x' };
    const refResult = validate(calendarDomain, refSchema);
    expect(refResult.parsed.ok && refResult.validation?.ok).toBe(false);
  });

  it('rejects a tool count above the declared limit', () => {
    const spec = clone(calendarAdapter) as AdapterSpec;
    spec.limits.maxTools = 2;
    const result = validate(calendarDomain, spec);
    expect(result.parsed.ok && result.validation?.ok).toBe(false);
  });
});

describe('adapter compilation', () => {
  it('compiles a flat calendar create into a nested original call', () => {
    const schemas = rawToolSchemaMap(calendarDomain);
    const tool = calendarAdapter.tools.find((candidate) => candidate.name === 'schedule_event')!;
    const compiled = compileAdapterCall(
      tool,
      {
        title: 'Compiled sync',
        start: '2026-11-03T23:30',
        duration_minutes: 90,
        attendees: ['sam@acme.test', 'dev@acme.test'],
        location: 'Room 1C',
      },
      schemas,
    );
    expect(compiled.ok).toBe(true);
    expect(compiled.input).toEqual({
      calendar_id: 'primary',
      event: {
        summary: 'Compiled sync',
        start: { dateTime: '2026-11-03T23:30:00+05:30', timeZone: 'Asia/Kolkata' },
        end: { dateTime: '2026-11-04T01:00:00+05:30', timeZone: 'Asia/Kolkata' },
        attendees: [{ email: 'sam@acme.test' }, { email: 'dev@acme.test' }],
        location: 'Room 1C',
      },
    });
  });

  it('rolls durations across midnight and month boundaries', () => {
    const schemas = rawToolSchemaMap(calendarDomain);
    const tool = calendarAdapter.tools.find((candidate) => candidate.name === 'schedule_event')!;
    const monthEnd = compileAdapterCall(
      tool,
      { title: 'Month end', start: '2026-11-30T23:45', duration_minutes: 30 },
      schemas,
    );
    expect(monthEnd.ok).toBe(true);
    expect((monthEnd.input as { event: { end: { dateTime: string } } }).event.end.dateTime).toBe('2026-12-01T00:15:00+05:30');
  });

  it('fails compilation when a duration is supplied without a start', () => {
    const schemas = rawToolSchemaMap(calendarDomain);
    const tool = calendarAdapter.tools.find((candidate) => candidate.name === 'schedule_event')!;
    const compiled = compileAdapterCall(tool, { title: 'No start', duration_minutes: 30 }, schemas);
    expect(compiled.ok).toBe(false);
    expect(compiled.errors.some((error) => error.message.includes('start'))).toBe(true);
  });

  it('rejects an invalid calendar date instead of silently normalising it', () => {
    const schemas = rawToolSchemaMap(calendarDomain);
    const tool = calendarAdapter.tools.find((candidate) => candidate.name === 'schedule_event')!;
    const compiled = compileAdapterCall(tool, { title: 'Bad date', start: '2026-02-30T10:00', duration_minutes: 30 }, schemas);
    expect(compiled.ok).toBe(false);
  });

  it('compiles structured issue filters into the original query dialect', () => {
    const schemas = rawToolSchemaMap(issueDomain);
    const tool = issueAdapter.tools.find((candidate) => candidate.name === 'search_issues')!;
    const compiled = compileAdapterCall(
      tool,
      { repo: 'acme/rocket', status: 'open', priority: 'P1', label: 'bug', assignee: 'alice' },
      schemas,
    );
    expect(compiled.ok).toBe(true);
    expect((compiled.input as { q: string }).q).toBe('is:open priority:P1 label:bug assignee:alice');
  });

  it('compiles a close into one update call with a constant status', () => {
    const schemas = rawToolSchemaMap(issueDomain);
    const tool = issueAdapter.tools.find((candidate) => candidate.name === 'close_issue')!;
    const compiled = compileAdapterCall(tool, { repo: 'acme/orbit', number: 12, resolution: 'duplicate' }, schemas);
    expect(compiled.ok).toBe(true);
    expect(compiled.input).toEqual({ repo: 'acme/orbit', number: 12, changes: { status: 'closed', resolution: 'duplicate' } });
  });

  it('does not repair an unknown enum value', () => {
    const schemas = rawToolSchemaMap(issueDomain);
    const tool = issueAdapter.tools.find((candidate) => candidate.name === 'search_issues')!;
    const compiled = compileAdapterCall(tool, { repo: 'acme/rocket', status: 'in_progress' }, schemas);
    expect(compiled.ok).toBe(false);
  });
});

describe('interface construction', () => {
  it('preserves raw schemas exactly in the descriptions condition after stripping docs', () => {
    const raw = buildConditionInterface(calendarDomain, 'original');
    const described = buildConditionInterface(calendarDomain, 'descriptions');
    expect(raw.tools.map((tool) => tool.name)).toEqual(described.tools.map((tool) => tool.name));
    for (const [index, tool] of raw.tools.entries()) {
      const other = described.tools[index]!;
      expect(schemasEquivalentIgnoringDescriptions(tool.inputSchema, other.inputSchema)).toBe(true);
      expect(tool.permissions).toEqual(other.permissions);
      expect(tool.annotations).toEqual(other.annotations);
    }
    const changed = described.tools.filter((tool, index) => tool.description !== raw.tools[index]!.description);
    expect(changed.length).toBeGreaterThan(0);
  });

  it('produces distinct interface hashes per condition and stable hashes per build', () => {
    const raw = buildConditionInterface(calendarDomain, 'original');
    const described = buildConditionInterface(calendarDomain, 'descriptions');
    const adapted = buildConditionInterface(calendarDomain, 'adapted', calendarAdapter);
    expect(new Set([raw.hash, described.hash, adapted.hash]).size).toBe(3);
    expect(buildConditionInterface(calendarDomain, 'original').hash).toBe(raw.hash);
    expect(buildConditionInterface(calendarDomain, 'adapted', calendarAdapter).hash).toBe(adapted.hash);
  });

  it('does not leak the raw executor into adapted tool definitions', () => {
    const adapted = buildConditionInterface(calendarDomain, 'adapted', calendarAdapter);
    expect((adapted.tools[0] as unknown as { execute?: unknown }).execute).toBeUndefined();
    expect(adapted.tools.every((tool) => Object.keys(tool).every((key) => key !== 'execute'))).toBe(true);
  });

  it('strips only documentation keys', () => {
    const schema = {
      type: 'object',
      description: 'top',
      properties: { a: { type: 'string', description: 'field', examples: ['x'] } },
    };
    expect(stripDescriptions(schema)).toEqual({ type: 'object', properties: { a: { type: 'string' } } });
  });

  it('keeps call limits inspectable: v2 calendar lookup = 2 calls, v1 issues = 1 call', () => {
    expect(calendarAdapter.schema).toBe('anvil.adapter/v2');
    expect(calendarAdapter.limits.oneToOne).toBe(false);
    expect(calendarAdapter.limits.maxUnderlyingCallsPerInvocation).toBe(2);
    expect(issueAdapter.schema).toBe('anvil.adapter/v1');
    expect(issueAdapter.limits.oneToOne).toBe(true);
    expect(issueAdapter.limits.maxUnderlyingCallsPerInvocation).toBe(1);
    expect(firstTool(calendarAdapter).arguments.length).toBeGreaterThan(0);
  });
});