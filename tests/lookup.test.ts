import { describe, expect, it } from 'vitest';
import { calendarDomain } from '../src/domains/calendar/index.js';
import { calendarAdapter } from '../src/domains/calendar/adapter.js';
import { initialCalendarState, type CalendarState } from '../src/domains/calendar/state.js';
import { buildConditionInterface, executeConditionTool, rawToolSchemaMap, readOnlyToolNames, maxUnderlyingCallsFor } from '../src/core/interfaces.js';
import { parseAdapterSpec, previewAdapterCall, validateAdapter } from '../src/core/adapter.js';
import { deepClone } from '../src/core/util.js';
import type { AdapterSpec } from '../src/core/types.js';

const NOW = '2026-10-20T09:00:00+05:30';
const adaptedIface = buildConditionInterface(calendarDomain, 'adapted', calendarAdapter);
const originalIface = buildConditionInterface(calendarDomain, 'original');

function adapted(state: CalendarState, toolName: string, args: Record<string, unknown>) {
  return executeConditionTool({ iface: adaptedIface, domain: calendarDomain, state, toolName, args, now: NOW });
}

function original(state: CalendarState, toolName: string, args: Record<string, unknown>) {
  return executeConditionTool({ iface: originalIface, domain: calendarDomain, state, toolName, args, now: NOW });
}

function validate(spec: unknown) {
  const parsed = parseAdapterSpec(spec);
  if (!parsed.ok || !parsed.spec) return { parsed, validation: null };
  return {
    parsed,
    validation: validateAdapter(parsed.spec, {
      toolSchemas: rawToolSchemaMap(calendarDomain),
      rawToolNames: calendarDomain.tools.map((tool) => tool.name),
      readOnlyTools: readOnlyToolNames(calendarDomain),
    }),
  };
}

function withDuplicateRetro(): CalendarState {
  const state = initialCalendarState();
  const retro = state.events.find((event) => event.summary === 'Retro')!;
  state.events.push({
    ...deepClone(retro),
    id: 'evt_9001',
    start: retro.start.replace(/T\d{2}:\d{2}/, 'T17:00'),
    end: retro.end.replace(/T\d{2}:\d{2}/, 'T17:45'),
  });
  return state;
}

describe('v2 lookup-then-act', () => {
  it('deletes exactly the uniquely matched event, with the same final state as the equivalent original call', () => {
    const viaAdapter = initialCalendarState();
    const viaOriginal = initialCalendarState();
    const result = adapted(viaAdapter, 'cancel_event', { title: 'Budget review', date: '2026-11-06' });
    original(viaOriginal, 'calendar_delete_event', { calendar_id: 'primary', event_id: 'evt_1003' });
    expect(result.result.ok).toBe(true);
    expect(result.lookup?.matchedId).toBe('evt_1003');
    expect(result.underlyingCalls).toBe(2);
    expect(viaAdapter).toEqual(viaOriginal);
  });

  it('matches titles exactly (case-insensitive, trimmed), never by substring', () => {
    const state = initialCalendarState();
    const before = deepClone(state);
    // "Board prep" must not match "Board prep archive" or "Board prep dry run" by substring.
    const partial = adapted(state, 'cancel_event', { title: 'board', date: '2026-11-07' });
    expect(partial.result.ok).toBe(false);
    expect(state).toEqual(before);
    const cased = adapted(deepClone(before) as CalendarState, 'cancel_event', { title: '  budget REVIEW ', date: '2026-11-06' });
    expect(cased.lookup?.matchedId).toBe('evt_1003');
  });

  it('writes nothing and returns candidates when no record matches', () => {
    const state = initialCalendarState();
    const before = deepClone(state);
    const result = adapted(state, 'cancel_event', { title: 'Budget review', date: '2026-11-07' });
    expect(result.result.ok).toBe(false);
    expect(result.result.error?.code).toBe('adapter_lookup_no_match');
    expect(result.result.error?.message).toContain('Nothing was changed');
    expect(result.underlyingCalls).toBe(1);
    expect(result.lookup?.matchCount).toBe(0);
    expect(state).toEqual(before);
  });

  it('refuses an ambiguous target and lists every same-titled candidate', () => {
    const state = withDuplicateRetro();
    const before = deepClone(state);
    const retro = before.events.find((event) => event.id !== 'evt_9001' && event.summary === 'Retro')!;
    const date = retro.start.slice(0, 10);
    const result = adapted(state, 'cancel_event', { title: 'Retro', date });
    expect(result.result.ok).toBe(false);
    expect(result.result.error?.code).toBe('adapter_lookup_ambiguous');
    const candidates = (result.result.error?.details as { candidates: Array<{ id: string }> }).candidates;
    expect(candidates.map((candidate) => candidate.id).sort()).toEqual([retro.id, 'evt_9001'].sort());
    expect(state).toEqual(before);
  });

  it('disambiguates same-titled events with start_time', () => {
    const state = withDuplicateRetro();
    const retro = state.events.find((event) => event.id !== 'evt_9001' && event.summary === 'Retro')!;
    const result = adapted(state, 'cancel_event', { title: 'Retro', date: retro.start.slice(0, 10), start_time: '17:00' });
    expect(result.result.ok).toBe(true);
    expect(result.lookup?.matchedId).toBe('evt_9001');
    expect(state.events.some((event) => event.id === retro.id)).toBe(true);
    expect(state.events.some((event) => event.id === 'evt_9001')).toBe(false);
  });

  it('moves an event and keeps its own duration, matching the equivalent original patch', () => {
    const viaAdapter = initialCalendarState();
    const viaOriginal = initialCalendarState();
    const result = adapted(viaAdapter, 'move_event', { title: 'Vendor sync', date: '2026-11-05', new_start: '2026-11-05T17:00' });
    original(viaOriginal, 'calendar_patch_event', {
      calendar_id: 'primary',
      event_id: 'evt_1001',
      patch: { start: { dateTime: '2026-11-05T17:00:00+05:30' }, end: { dateTime: '2026-11-05T18:00:00+05:30' } },
    });
    expect(result.result.ok).toBe(true);
    expect(viaAdapter).toEqual(viaOriginal);
  });

  it('updates one field on the matched event only', () => {
    const state = initialCalendarState();
    const before = deepClone(state);
    const result = adapted(state, 'update_event', { title: 'Hiring sync', date: '2026-11-04', location: 'Room 4B' });
    expect(result.result.ok).toBe(true);
    const changed = state.events.filter((event, index) => JSON.stringify(event) !== JSON.stringify(before.events[index]));
    expect(changed.map((event) => event.id)).toEqual(['evt_1007']);
    expect(changed[0]!.location).toBe('Room 4B');
  });

  it('reserves two underlying calls for lookup tools and one for everything else', () => {
    expect(maxUnderlyingCallsFor(adaptedIface, 'cancel_event')).toBe(2);
    expect(maxUnderlyingCallsFor(adaptedIface, 'find_events')).toBe(1);
    expect(maxUnderlyingCallsFor(originalIface, 'calendar_delete_event')).toBe(1);
  });

  it('previews the lookup and the target call without executing either', () => {
    const tool = calendarAdapter.tools.find((candidate) => candidate.name === 'cancel_event')!;
    const preview = previewAdapterCall(tool, { title: 'Budget review', date: '2026-11-06' }, rawToolSchemaMap(calendarDomain));
    expect(preview.ok).toBe(true);
    expect(preview.lookupCall?.tool).toBe('calendar_list_events');
    expect(preview.lookupCall?.input).toMatchObject({ time_min: '2026-11-06T00:00:00+05:30', time_max: '2026-11-07T00:00:00+05:30' });
    expect(preview.originalCall.tool).toBe('calendar_delete_event');
  });
});

describe('v2 lookup validation', () => {
  const clone = (): AdapterSpec => JSON.parse(JSON.stringify(calendarAdapter)) as AdapterSpec;

  it('accepts the default calendar v2 adapter', () => {
    const { parsed, validation } = validate(clone());
    expect(parsed.ok).toBe(true);
    expect(validation?.ok).toBe(true);
  });

  it('rejects a lookup that calls a write tool', () => {
    const spec = clone();
    spec.tools.find((tool) => tool.name === 'cancel_event')!.lookup!.tool = 'calendar_create_event';
    const { validation } = validate(spec);
    expect(validation?.ok).toBe(false);
    expect(validation?.issues.some((issue) => issue.message.includes('not read-only'))).toBe(true);
  });

  it('rejects lookup in a v1 adapter and wrong v2 call limits', () => {
    const v1 = clone();
    v1.schema = 'anvil.adapter/v1';
    expect(validate(v1).parsed.ok).toBe(false);
    const limits = clone();
    limits.limits.maxUnderlyingCallsPerInvocation = 1;
    expect(validate(limits).parsed.ok).toBe(false);
  });

  it('requires at least one match rule on a required input', () => {
    const spec = clone();
    const cancel = spec.tools.find((tool) => tool.name === 'cancel_event')!;
    cancel.lookup!.match = [{ field: 'start.dateTime', from: 'start_time', compare: 'localTime' }];
    const { validation } = validate(spec);
    expect(validation?.ok).toBe(false);
    expect(validation?.issues.some((issue) => issue.message.includes('required input'))).toBe(true);
  });

  it('rejects a mapping that also writes the bound id', () => {
    const spec = clone();
    const cancel = spec.tools.find((tool) => tool.name === 'cancel_event')!;
    cancel.arguments.push({ to: 'event_id', from: 'title' });
    const { validation } = validate(spec);
    expect(validation?.ok).toBe(false);
  });

  it('rejects keepDurationEnd on a tool without a lookup', () => {
    const spec = clone();
    const schedule = spec.tools.find((tool) => tool.name === 'schedule_event')!;
    const end = schedule.arguments.find((mapping) => mapping.to === 'event.end.dateTime')!;
    end.from = 'start';
    end.transform = { kind: 'keepDurationEnd', itemStart: 'start.dateTime', itemEnd: 'end.dateTime', assumeOffset: '+05:30' };
    const { validation } = validate(spec);
    expect(validation?.ok).toBe(false);
    expect(validation?.issues.some((issue) => issue.message.includes('needs a lookup'))).toBe(true);
  });
});
