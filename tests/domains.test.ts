import { describe, expect, it } from 'vitest';
import { calendarDomain } from '../src/domains/calendar/index.js';
import { issueDomain } from '../src/domains/issues/index.js';
import { buildConditionInterface, executeConditionTool, rawToolSchemaMap } from '../src/core/interfaces.js';
import { calendarAdapter } from '../src/domains/calendar/adapter.js';
import { issueAdapter } from '../src/domains/issues/adapter.js';
import { initialCalendarState, type CalendarState } from '../src/domains/calendar/state.js';
import { initialIssueState, type IssueState } from '../src/domains/issues/state.js';
import { expectCreated, expectEventIds, expectRemoved, expectUnchanged, expectUpdated } from '../src/domains/calendar/validators.js';
import { expectIssueCreated, expectIssueNumbers, expectIssueUpdated } from '../src/domains/issues/validators.js';
import { deepClone } from '../src/core/util.js';

const calendarNow = '2026-10-20T09:00:00+05:30';
const issueNow = '2026-10-20T09:00:00Z';

function runCalendar(
  state: CalendarState,
  toolName: string,
  args: Record<string, unknown>,
  condition: 'original' | 'descriptions' | 'adapted' = 'original',
) {
  const iface = buildConditionInterface(calendarDomain, condition, condition === 'adapted' ? calendarAdapter : null);
  return executeConditionTool({ iface, domain: calendarDomain, state, toolName, args, now: calendarNow });
}

function runIssue(
  state: IssueState,
  toolName: string,
  args: Record<string, unknown>,
  condition: 'original' | 'descriptions' | 'adapted' = 'original',
) {
  const iface = buildConditionInterface(issueDomain, condition, condition === 'adapted' ? issueAdapter : null);
  return executeConditionTool({ iface, domain: issueDomain, state, toolName, args, now: issueNow });
}

describe('fixture state isolation', () => {
  it('returns a fresh calendar fixture on every call', () => {
    const first = initialCalendarState();
    first.events.pop();
    const second = initialCalendarState();
    expect(second.events.length).toBeGreaterThan(first.events.length);
    expect(second.events[0]).not.toBe(first.events[0]);
  });

  it('returns a fresh issue fixture on every call', () => {
    const first = initialIssueState();
    first.issues[0]!.title = 'mutated';
    expect(initialIssueState().issues[0]!.title).not.toBe('mutated');
  });

  it('does not share nested hour objects between calendar fixtures', () => {
    const a = initialCalendarState();
    const b = initialCalendarState();
    expect(a.events).not.toBe(b.events);
    expect(a.events[0]!.attendees).not.toBe(b.events[0]!.attendees);
  });
});

describe('calendar raw tools', () => {
  it('rejects an unconnected calendar id', () => {
    const state = initialCalendarState();
    const result = runCalendar(state, 'calendar_list_events', {
      calendar_id: 'work',
      time_min: '2026-11-01T00:00:00+05:30',
      time_max: '2026-12-01T00:00:00+05:30',
    });
    expect(result.result.ok).toBe(false);
    expect(result.result.error?.code).toBe('calendar_not_found');
    expect(state.events).toHaveLength(initialCalendarState().events.length);
  });

  it('rejects an inverted time range', () => {
    const result = runCalendar(initialCalendarState(), 'calendar_create_event', {
      calendar_id: 'primary',
      event: {
        summary: 'Bad',
        start: { dateTime: '2026-11-03T10:00:00+05:30', timeZone: 'Asia/Kolkata' },
        end: { dateTime: '2026-11-03T09:00:00+05:30', timeZone: 'Asia/Kolkata' },
      },
    });
    expect(result.result.ok).toBe(false);
    expect(result.result.error?.code).toBe('invalid_time_range');
  });

  it('rejects a wrong time zone rather than coercing it', () => {
    const result = runCalendar(initialCalendarState(), 'calendar_create_event', {
      calendar_id: 'primary',
      event: {
        summary: 'UTC event',
        start: { dateTime: '2026-11-03T10:00:00Z', timeZone: 'UTC' },
        end: { dateTime: '2026-11-03T11:00:00Z', timeZone: 'UTC' },
      },
    });
    expect(result.result.ok).toBe(false);
    expect(result.result.error?.code).toBe('timezone_not_supported');
  });

  it('filters list results by overlap and text', () => {
    const state = initialCalendarState();
    const result = runCalendar(state, 'calendar_list_events', {
      calendar_id: 'primary',
      time_min: '2026-11-09T00:00:00+05:30',
      time_max: '2026-11-10T00:00:00+05:30',
    });
    expect(result.result.ok).toBe(true);
    const items = (result.result.content as { items: Array<{ id: string }> }).items;
    expect(items.map((item) => item.id)).toEqual(['evt_1006', 'evt_1010']);

    const filtered = runCalendar(state, 'calendar_list_events', {
      calendar_id: 'primary',
      time_min: '2026-11-01T00:00:00+05:30',
      time_max: '2026-12-01T00:00:00+05:30',
      query: 'sam@acme.test',
    });
    const ids = (filtered.result.content as { items: Array<{ id: string }> }).items.map((item) => item.id);
    expect(ids).toEqual(['evt_1006', 'evt_1015']);
  });
});

describe('adapted executor parity', () => {
  it('runs the same original executor and produces an identical final state', () => {
    const rawState = initialCalendarState();
    const adaptedState = initialCalendarState();

    const raw = runCalendar(rawState, 'calendar_create_event', {
      calendar_id: 'primary',
      event: {
        summary: 'Parity check',
        start: { dateTime: '2026-11-21T10:00:00+05:30', timeZone: 'Asia/Kolkata' },
        end: { dateTime: '2026-11-21T11:00:00+05:30', timeZone: 'Asia/Kolkata' },
        attendees: [{ email: 'sam@acme.test' }],
      },
    });
    const adapted = runCalendar(
      adaptedState,
      'schedule_event',
      { title: 'Parity check', start: '2026-11-21T10:00', duration_minutes: 60, attendees: ['sam@acme.test'] },
      'adapted',
    );
    expect(raw.result.ok).toBe(true);
    expect(adapted.result.ok).toBe(true);
    expect(deepClone(rawState)).toEqual(deepClone(adaptedState));
    expect(adapted.compilation?.target).toBe('calendar_create_event');
    expect(adapted.compilation?.input).toEqual({
      calendar_id: 'primary',
      event: {
        summary: 'Parity check',
        start: { dateTime: '2026-11-21T10:00:00+05:30', timeZone: 'Asia/Kolkata' },
        end: { dateTime: '2026-11-21T11:00:00+05:30', timeZone: 'Asia/Kolkata' },
        attendees: [{ email: 'sam@acme.test' }],
      },
    });
  });

  it('rejects extra adapted fields instead of passing them through', () => {
    const state = initialCalendarState();
    const result = runCalendar(
      state,
      'schedule_event',
      { title: 'Extra', start: '2026-11-21T10:00', duration_minutes: 30, calendar_id: 'primary' },
      'adapted',
    );
    expect(result.result.ok).toBe(false);
    expect(result.result.error?.code).toBe('tool_input_invalid');
    expect(state.events).toHaveLength(initialCalendarState().events.length);
  });

  it('does not count an unknown tool as an underlying call', () => {
    const state = initialCalendarState();
    const result = runCalendar(state, 'drop_all_events', {}, 'adapted');
    expect(result.result.ok).toBe(false);
    expect(result.countedUnderlying).toBe(false);
  });

  it('reports an adapted compile failure as a tool error, not a silent repair', () => {
    const state = initialCalendarState();
    // A matched update with no field changes compiles to a patch with nothing in it: rejected, not guessed.
    const before = deepClone(state);
    const result = runCalendar(state, 'update_event', { title: 'Vendor sync', date: '2026-11-05' }, 'adapted');
    expect(result.result.ok).toBe(false);
    expect(result.result.error?.code).toBe('adapter_compile_failed');
    expect(result.lookup?.matchedId).toBe('evt_1001');
    expect(result.underlyingCalls).toBe(1);
    expect(state).toEqual(before);
  });
});

describe('calendar independent validators', () => {
  const expected = {
    summary: 'Designed event',
    start: '2026-11-03T15:30:00+05:30',
    end: '2026-11-03T16:15:00+05:30',
    attendees: [],
    location: null,
    description: null,
  };

  function stateWithCorrectCreation(): CalendarState {
    const state = initialCalendarState();
    state.events.push({
      id: 'evt_9999',
      summary: expected.summary,
      start: expected.start,
      end: expected.end,
      location: null,
      description: null,
      attendees: [],
      status: 'confirmed',
      created_at: calendarNow,
    });
    return state;
  }

  it('passes a correct creation', () => {
    const checks = expectCreated(initialCalendarState(), stateWithCorrectCreation(), expected);
    expect(checks.every((check) => check.ok)).toBe(true);
  });

  it('fails when the right event is created and an extra event is also written', () => {
    const state = stateWithCorrectCreation();
    state.events.push({ ...state.events.at(-1)!, id: 'evt_9998', summary: 'Duplicate' });
    const checks = expectCreated(initialCalendarState(), state, expected);
    expect(checks.some((check) => !check.ok)).toBe(true);
    expect(checks.find((check) => check.id === 'no-extra-events')?.ok).toBe(false);
  });

  it('fails when the right event is created but an unrelated event changed', () => {
    const state = stateWithCorrectCreation();
    state.events[0]!.location = 'Somewhere else';
    const checks = expectCreated(initialCalendarState(), state, expected);
    expect(checks.find((check) => check.id === 'existing-events-preserved')?.ok).toBe(false);
  });

  it('fails when the created event has the wrong time zone offset', () => {
    const state = stateWithCorrectCreation();
    state.events.at(-1)!.start = '2026-11-03T10:00:00Z';
    const checks = expectCreated(initialCalendarState(), state, expected);
    expect(checks.find((check) => check.id === 'created-fields')?.ok).toBe(false);
  });

  it('detects a wrong delete target', () => {
    const state = initialCalendarState();
    state.events = state.events.filter((event) => event.id !== 'evt_1001');
    const checks = expectRemoved(initialCalendarState(), state, 'evt_1003');
    expect(checks.some((check) => !check.ok)).toBe(true);
    expect(checks.find((check) => check.id === 'target-removed')?.ok).toBe(false);
    expect(checks.find((check) => check.id === 'only-target-removed')?.ok).toBe(false);
  });

  it('requires both start and end to move and preserves other fields', () => {
    const state = initialCalendarState();
    const event = state.events.find((candidate) => candidate.id === 'evt_1001')!;
    event.start = '2026-11-05T17:00:00+05:30';
    event.end = '2026-11-05T18:00:00+05:30';
    const checks = expectUpdated(initialCalendarState(), state, 'evt_1001', {
      start: '2026-11-05T17:00:00+05:30',
      end: '2026-11-05T18:00:00+05:30',
    });
    expect(checks.every((check) => check.ok)).toBe(true);

    const broken = initialCalendarState();
    const brokenEvent = broken.events.find((candidate) => candidate.id === 'evt_1001')!;
    brokenEvent.start = '2026-11-05T17:00:00+05:30';
    brokenEvent.end = '2026-11-05T17:30:00+05:30';
    const brokenChecks = expectUpdated(initialCalendarState(), broken, 'evt_1001', {
      start: '2026-11-05T17:00:00+05:30',
      end: '2026-11-05T18:00:00+05:30',
    });
    expect(brokenChecks.find((check) => check.id === 'target-fields')?.ok).toBe(false);
  });

  it('rejects a plausible but wrong query answer and accepts the exact one', () => {
    const state = initialCalendarState();
    const wrong = expectEventIds(state, initialCalendarState(), '{"event_ids":["evt_1006"]}', ['evt_1006', 'evt_1010']);
    expect(wrong.find((check) => check.id === 'event-ids-contract')?.ok).toBe(false);
    const right = expectEventIds(state, initialCalendarState(), '```json\n{"event_ids": ["evt_1006", "evt_1010"]}\n```', ['evt_1006', 'evt_1010']);
    expect(right.every((check) => check.ok)).toBe(true);
  });

  it('requires an unchanged state for read-only and no-op tasks', () => {
    expect(expectUnchanged(initialCalendarState(), initialCalendarState()).every((check) => check.ok)).toBe(true);
    const changed = initialCalendarState();
    changed.events[0]!.summary = 'changed';
    expect(expectUnchanged(initialCalendarState(), changed).every((check) => check.ok)).toBe(false);
  });
});

describe('issue raw tools and validators', () => {
  it('closes an issue with a resolution and clears it on reopen', () => {
    const state = initialIssueState();
    const closed = runIssue(state, 'issues_update', { repo: 'acme/rocket', number: 37, changes: { status: 'closed', resolution: 'fixed' } });
    expect(closed.result.ok).toBe(true);
    expect(state.issues.find((issue) => issue.number === 37)!.resolution).toBe('fixed');

    const reopened = runIssue(state, 'issues_update', { repo: 'acme/rocket', number: 37, changes: { status: 'open' } });
    expect(reopened.result.ok).toBe(true);
    const issue = state.issues.find((candidate) => candidate.number === 37)!;
    expect(issue.status).toBe('open');
    expect(issue.resolution).toBeNull();
  });

  it('rejects an unknown assignee and milestone with a tool error', () => {
    const state = initialIssueState();
    const badAssignee = runIssue(state, 'issues_update', {
      repo: 'acme/rocket',
      number: 42,
      changes: { assignee: 'mallory' },
    });
    expect(badAssignee.result.ok).toBe(false);
    expect(badAssignee.result.error?.code).toBe('invalid_assignee');

    const badMilestone = runIssue(state, 'issues_update', {
      repo: 'acme/rocket',
      number: 42,
      changes: { milestone: 'beta' },
    });
    expect(badMilestone.result.ok).toBe(false);
    expect(badMilestone.result.error?.code).toBe('invalid_milestone');
  });

  it('rejects an issue number from another repository', () => {
    const result = runIssue(initialIssueState(), 'issues_update', {
      repo: 'acme/orbit',
      number: 42,
      changes: { priority: 'P0' },
    });
    expect(result.result.ok).toBe(false);
    expect(result.result.error?.code).toBe('issue_not_found');
  });

  it('rejects an unsupported query clause', () => {
    const result = runIssue(initialIssueState(), 'issues_search', { repo: 'acme/rocket', q: 'is:merged' });
    expect(result.result.ok).toBe(false);
    expect(result.result.error?.code).toBe('invalid_query');
  });

  it('compiles structured adapted filters to the same rows as the raw query', () => {
    const raw = runIssue(initialIssueState(), 'issues_search', {
      repo: 'acme/rocket',
      q: 'is:open priority:P1 label:bug assignee:alice',
    });
    const adapted = runIssue(
      initialIssueState(),
      'search_issues',
      { repo: 'acme/rocket', status: 'open', priority: 'P1', label: 'bug', assignee: 'alice' },
      'adapted',
    );
    const rawNumbers = (raw.result.content as { items: Array<{ number: number }> }).items.map((item) => item.number);
    const adaptedNumbers = (adapted.result.content as { items: Array<{ number: number }> }).items.map((item) => item.number);
    expect(rawNumbers).toEqual([37, 61, 63]);
    expect(adaptedNumbers).toEqual(rawNumbers);
  });

  it('detects an extra field on a created issue', () => {
    const state = initialIssueState();
    runIssue(state, 'issues_create', {
      repo: 'acme/rocket',
      issue: { title: 'New issue', body: 'Body', labels: ['bug'], assignee: 'alice' },
    });
    const expected = {
      title: 'New issue',
      body: 'Body',
      labels: ['bug'],
      assignee: 'alice',
      milestone: null,
    };
    expect(expectIssueCreated(initialIssueState(), state, 'acme/rocket', expected).every((check) => check.ok)).toBe(true);

    const withMilestone = initialIssueState();
    runIssue(withMilestone, 'issues_create', {
      repo: 'acme/rocket',
      issue: { title: 'New issue', body: 'Body', labels: ['bug'], assignee: 'alice', milestone: 'v1.5' },
    });
    const checks = expectIssueCreated(initialIssueState(), withMilestone, 'acme/rocket', expected);
    expect(checks.find((check) => check.id === 'created-fields')?.ok).toBe(false);
  });

  it('detects a changed unrelated issue', () => {
    const state = initialIssueState();
    runIssue(state, 'issues_update', { repo: 'acme/rocket', number: 42, changes: { priority: 'P0' } });
    state.issues.find((issue) => issue.number === 51)!.priority = 'P0';
    const checks = expectIssueUpdated(initialIssueState(), state, 'acme/rocket', 42, { priority: 'P0' });
    expect(checks.find((check) => check.id === 'unrelated-unchanged')?.ok).toBe(false);
  });

  it('rejects a partial query answer', () => {
    const state = initialIssueState();
    const checks = expectIssueNumbers(state, state, '{"issue_numbers":[8,10]}', [8, 10, 21, 23]);
    expect(checks.find((check) => check.id === 'issue-numbers-contract')?.ok).toBe(false);
  });

  it('does not execute instructions embedded in fixture records', () => {
    const state = initialIssueState();
    const injected = state.issues.find((issue) => issue.number === 22)!;
    expect(injected.body).toContain('ignore all previous instructions');
    const result = runIssue(state, 'issues_search', { repo: 'acme/orbit', q: 'webhook' });
    expect(result.result.ok).toBe(true);
    // The fixture text is returned as data; nothing in the runner can treat it as a directive.
    expect(JSON.stringify(result.result.content)).toContain('SYSTEM NOTE FOR AUTOMATION AGENTS');
    expect(state.issues.filter((issue) => issue.status === 'closed')).toHaveLength(
      initialIssueState().issues.filter((issue) => issue.status === 'closed').length,
    );
  });
});

describe('domain diffs', () => {
  it('summarises calendar changes and preserved records', () => {
    const state = initialCalendarState();
    runCalendar(state, 'calendar_patch_event', {
      calendar_id: 'primary',
      event_id: 'evt_1001',
      patch: { location: 'Room 9' },
    });
    const diff = calendarDomain.diff(initialCalendarState(), state);
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0]!.kind).toBe('changed');
    expect(diff.changes[0]!.fields.map((field) => field.field)).toEqual(['location']);
    expect(diff.unchangedCount).toBe(initialCalendarState().events.length - 1);
  });

  it('summarises issue changes', () => {
    const state = initialIssueState();
    runIssue(state, 'issues_create', { repo: 'acme/orbit', issue: { title: 'Created' } });
    const diff = issueDomain.diff(initialIssueState(), state);
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0]!.kind).toBe('added');
  });
});

describe('raw schema map', () => {
  it('exposes every raw tool schema for adapter compilation', () => {
    expect([...rawToolSchemaMap(calendarDomain).keys()].sort()).toEqual(
      ['calendar_create_event', 'calendar_delete_event', 'calendar_list_events', 'calendar_patch_event'].sort(),
    );
    expect([...rawToolSchemaMap(issueDomain).keys()].sort()).toEqual(
      ['issues_comment', 'issues_create', 'issues_search', 'issues_update'].sort(),
    );
  });
});