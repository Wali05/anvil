import type { DomainDefinition, StateChange } from '../../core/types.js';
import { deepEqual } from '../../core/util.js';
import { calendarTools, calendarFieldDescriptions } from './tools.js';
import { calendarTasks } from './tasks.js';
import { calendarEval2Tasks } from './tasks-eval2.js';
import { initialCalendarState, asCalendarState, type CalendarEvent } from './state.js';
import { simulateCalendar } from './simulator.js';

function snapshot(event: CalendarEvent): Record<string, unknown> {
  return {
    summary: event.summary,
    start: event.start,
    end: event.end,
    location: event.location,
    description: event.description,
    attendees: event.attendees,
    status: event.status,
  };
}

export const calendarDomain: DomainDefinition = {
  id: 'calendar',
  name: 'Calendar',
  shortName: 'Calendar',
  description:
    'A resettable local calendar fixture with nested event resources, RFC 3339 times, attendees and destructive deletes.',
  environment:
    'Connected calendar id: "primary". Time zone: Asia/Kolkata (UTC+05:30). Fixture clock: 20 October 2026. Every write hits a disposable in-memory fixture; no real calendar is contacted.',
  // 2026.10.2: added December fixtures and the sealed eval v2 tasks; dev and eval v1 tasks unchanged.
  taskSetVersion: 'calendar-2026.10.2',
  initialState: initialCalendarState,
  tools: calendarTools,
  tasks: [...calendarTasks, ...calendarEval2Tasks],
  diff(initialState, finalState) {
    const initial = asCalendarState(initialState);
    const final = asCalendarState(finalState);
    const before = new Map(initial.events.map((event) => [event.id, event]));
    const after = new Map(final.events.map((event) => [event.id, event]));
    const changes: StateChange[] = [];
    for (const event of final.events) {
      if (!before.has(event.id)) {
        changes.push({
          entity: event.id,
          kind: 'added',
          fields: Object.entries(snapshot(event)).map(([field, afterValue]) => ({ field, before: undefined, after: afterValue })),
        });
      }
    }
    for (const event of initial.events) {
      const next = after.get(event.id);
      if (!next) {
        changes.push({
          entity: event.id,
          kind: 'removed',
          fields: Object.entries(snapshot(event)).map(([field, beforeValue]) => ({ field, before: beforeValue, after: undefined })),
        });
        continue;
      }
      const oldRecord = snapshot(event);
      const newRecord = snapshot(next);
      const fields = Object.keys(oldRecord)
        .filter((field) => !deepEqual(oldRecord[field], newRecord[field]))
        .map((field) => ({ field, before: oldRecord[field], after: newRecord[field] }));
      if (fields.length > 0) changes.push({ entity: event.id, kind: 'changed', fields });
    }
    const unchangedCount = final.events.filter((event) => {
      const old = before.get(event.id);
      return old ? deepEqual(snapshot(old), snapshot(event)) : false;
    }).length;
    const summary =
      changes.length === 0
        ? `No calendar changes; ${unchangedCount} events unchanged.`
        : `${changes.filter((change) => change.kind === 'added').length} added, ${changes.filter((change) => change.kind === 'removed').length} removed, ${changes.filter((change) => change.kind === 'changed').length} changed.`;
    return { domain: 'calendar', changes, unchangedCount, summary };
  },
  describeToolField(toolName, fieldPath) {
    return calendarFieldDescriptions[toolName]?.[fieldPath];
  },
  simulate: simulateCalendar,
};