import type { CheckResult } from '../../core/types.js';
import { deepEqual } from '../../core/util.js';
import { parseContractArray } from '../../core/contract.js';
import { asCalendarState, type CalendarEvent, type CalendarState } from './state.js';

export interface ExpectedEvent {
  summary: string;
  start: string;
  end: string;
  attendees?: string[];
  location?: string | null;
  description?: string | null;
}

type FieldName = 'summary' | 'start' | 'end' | 'location' | 'description' | 'attendees' | 'status';

type PartialExpected = Partial<Pick<CalendarEvent, FieldName>>;

function eventsById(state: CalendarState): Map<string, CalendarEvent> {
  return new Map(state.events.map((event) => [event.id, event]));
}

function eventSnapshot(event: CalendarEvent): Record<string, unknown> {
  return {
    id: event.id,
    summary: event.summary,
    start: event.start,
    end: event.end,
    location: event.location ?? '',
    description: event.description ?? '',
    attendees: [...event.attendees].sort(),
    status: event.status,
  };
}

function sortedAttendees(values: string[]): string[] {
  return [...values].sort();
}

function locationMatches(actual: string | null, expected: string | null | undefined): boolean {
  if (expected === undefined) return true;
  return (actual ?? '') === (expected ?? '');
}

function matchesExpected(event: CalendarEvent, expected: ExpectedEvent): boolean {
  return (
    event.summary === expected.summary &&
    event.start === expected.start &&
    event.end === expected.end &&
    sortedAttendees(event.attendees).join(',') === sortedAttendees(expected.attendees ?? []).join(',') &&
    locationMatches(event.location, expected.location) &&
    (expected.description === undefined ? true : (event.description ?? '') === (expected.description ?? ''))
  );
}

function fieldMatches(event: CalendarEvent, field: FieldName, expected: unknown): boolean {
  if (field === 'attendees') {
    return sortedAttendees(event.attendees).join(',') === (expected as string[]).slice().sort().join(',');
  }
  if (field === 'location' || field === 'description') {
    return (event[field] ?? '') === (expected ?? '');
  }
  return deepEqual(event[field], expected);
}

function splitChanges(initial: CalendarState, final: CalendarState) {
  const before = eventsById(initial);
  const after = eventsById(final);
  const added = final.events.filter((event) => !before.has(event.id));
  const removed = initial.events.filter((event) => !after.has(event.id));
  const changed = initial.events
    .filter((event) => after.has(event.id) && !deepEqual(eventSnapshot(event), eventSnapshot(after.get(event.id)!)))
    .map((event) => ({ before: event, after: after.get(event.id)! }));
  return { before, after, added, removed, changed };
}

export function expectCreated(initialState: unknown, finalState: unknown, expected: ExpectedEvent): CheckResult[] {
  const initial = asCalendarState(initialState);
  const final = asCalendarState(finalState);
  const { before, added, removed, changed } = splitChanges(initial, final);
  const checks: CheckResult[] = [];

  checks.push({
    id: 'created-one-event',
    label: 'Exactly one event was created',
    kind: 'intent',
    ok: added.length === 1 && removed.length === 0,
    detail: `${added.length} added, ${removed.length} removed; expected exactly one added event and no removals.`,
  });

  const created = added[0];
  checks.push({
    id: 'created-fields',
    label: 'Created event matches the requested fields',
    kind: 'intent',
    ok: Boolean(created && matchesExpected(created, expected)),
    detail: created
      ? `Actual: ${created.summary} | ${created.start} → ${created.end} | attendees ${created.attendees.join(', ') || 'none'} | location ${created.location ?? 'none'}.`
      : 'No created event to inspect.',
  });

  checks.push({
    id: 'existing-events-preserved',
    label: 'Every existing event is byte-for-byte preserved',
    kind: 'preservation',
    ok: changed.length === 0,
    detail: changed.length === 0 ? 'No existing event changed.' : `Changed existing events: ${changed.map((entry) => entry.before.id).join(', ')}.`,
  });

  checks.push({
    id: 'no-extra-events',
    label: 'No extra event was written',
    kind: 'hygiene',
    ok: final.events.length === initial.events.length + 1,
    detail: `Final size ${final.events.length}; initial size ${initial.events.length}; expected +1.`,
  });
  return checks;
}

export function expectUpdated(
  initialState: unknown,
  finalState: unknown,
  eventId: string,
  expected: PartialExpected,
): CheckResult[] {
  const initial = asCalendarState(initialState);
  const final = asCalendarState(finalState);
  const { added, removed, changed } = splitChanges(initial, final);
  const before = initial.events.find((event) => event.id === eventId);
  const after = final.events.find((event) => event.id === eventId);
  const checks: CheckResult[] = [];

  checks.push({
    id: 'target-present',
    label: `Event ${eventId} still exists`,
    kind: 'intent',
    ok: Boolean(before && after),
    detail: before ? (after ? 'Found before and after.' : 'The target event was removed.') : 'The fixture did not contain the target event.',
  });

  const mismatches: string[] = [];
  if (before && after) {
    for (const [field, value] of Object.entries(expected) as Array<[FieldName, unknown]>) {
      if (!fieldMatches(after, field, value)) mismatches.push(`${field}: expected ${JSON.stringify(value)}, got ${JSON.stringify(after[field])}`);
    }
    const allowed = new Set(Object.keys(expected));
    for (const field of ['summary', 'start', 'end', 'location', 'description', 'attendees', 'status'] as FieldName[]) {
      if (allowed.has(field)) continue;
      if (!fieldMatches(after, field, (before as unknown as Record<string, unknown>)[field])) {
        mismatches.push(`${field} changed unexpectedly`);
      }
    }
  }
  checks.push({
    id: 'target-fields',
    label: 'Target fields match the request and nothing else changed',
    kind: 'intent',
    ok: Boolean(before && after) && mismatches.length === 0,
    detail: mismatches.length === 0 ? 'Target fields are exactly as requested.' : mismatches.join('; '),
  });

  checks.push({
    id: 'no-additions',
    label: 'No events were added',
    kind: 'hygiene',
    ok: added.length === 0,
    detail: added.length === 0 ? 'No additions.' : `Added: ${added.map((event) => event.id).join(', ')}.`,
  });
  checks.push({
    id: 'no-removals',
    label: 'No events were removed',
    kind: 'preservation',
    ok: removed.length === 0,
    detail: removed.length === 0 ? 'No removals.' : `Removed: ${removed.map((event) => event.id).join(', ')}.`,
  });
  const unrelatedChanged = changed.filter((entry) => entry.before.id !== eventId);
  checks.push({
    id: 'unrelated-unchanged',
    label: 'Unrelated events are unchanged',
    kind: 'preservation',
    ok: unrelatedChanged.length === 0,
    detail:
      unrelatedChanged.length === 0
        ? 'All other events match the initial fixture.'
        : `Unexpected changes: ${unrelatedChanged.map((entry) => entry.before.id).join(', ')}.`,
  });
  return checks;
}

export function expectRemoved(initialState: unknown, finalState: unknown, eventId: string): CheckResult[] {
  const initial = asCalendarState(initialState);
  const final = asCalendarState(finalState);
  const { added, removed, changed } = splitChanges(initial, final);
  const targetGone = !final.events.some((event) => event.id === eventId);
  const checks: CheckResult[] = [];

  checks.push({
    id: 'target-removed',
    label: `Event ${eventId} was deleted`,
    kind: 'intent',
    ok: targetGone,
    detail: targetGone ? 'Target event is absent from the final state.' : 'Target event is still present.',
  });
  checks.push({
    id: 'only-target-removed',
    label: 'Only the requested event was deleted',
    kind: 'preservation',
    ok: removed.length === 1 && removed[0]?.id === eventId,
    detail: removed.length === 0 ? 'Nothing was deleted.' : `Deleted: ${removed.map((event) => event.id).join(', ')}.`,
  });
  checks.push({
    id: 'no-additions',
    label: 'No events were added',
    kind: 'hygiene',
    ok: added.length === 0,
    detail: added.length === 0 ? 'No additions.' : `Added: ${added.map((event) => event.id).join(', ')}.`,
  });
  checks.push({
    id: 'survivors-unchanged',
    label: 'All surviving events are unchanged',
    kind: 'preservation',
    ok: changed.length === 0,
    detail: changed.length === 0 ? 'No surviving event changed.' : `Changed: ${changed.map((entry) => entry.before.id).join(', ')}.`,
  });
  return checks;
}

export function expectUnchanged(initialState: unknown, finalState: unknown): CheckResult[] {
  const initial = asCalendarState(initialState);
  const final = asCalendarState(finalState);
  const same = deepEqual(initial, final);
  return [
    {
      id: 'state-unchanged',
      label: 'The calendar state is unchanged',
      kind: 'preservation',
      ok: same,
      detail: same
        ? `All ${initial.events.length} events are identical to the fixture.`
        : 'The final calendar differs from the initial fixture.',
    },
  ];
}

export function expectEventIds(initialState: unknown, finalState: unknown, finalAnswer: string, expectedIds: string[]): CheckResult[] {
  const checks = expectUnchanged(initialState, finalState);
  const parsed = parseContractArray(finalAnswer ?? '', 'event_ids');
  const actual = parsed.ok ? parsed.values : [];
  const orderOk = parsed.ok && actual.length === expectedIds.length && actual.every((id, index) => id === expectedIds[index]);
  checks.push({
    id: 'event-ids-contract',
    label: 'Final answer satisfies the event_ids contract',
    kind: 'contract',
    ok: orderOk,
    detail: parsed.ok
      ? `Expected [${expectedIds.join(', ')}], got [${actual.join(', ')}].`
      : `Could not parse the contract: ${parsed.reason}. Expected [${expectedIds.join(', ')}].`,
  });
  return checks;
}

/** Kept for tests that want the raw change split without asserting a scenario. */
export function inspectCalendarChanges(initialState: unknown, finalState: unknown) {
  return splitChanges(asCalendarState(initialState), asCalendarState(finalState));
}
