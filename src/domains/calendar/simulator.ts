import type { ConditionId, SimulatedAction, SimulationContext, SimulationStep, ToolCallContext, ToolExecResult } from '../../core/types.js';

interface SimEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  attendees: string[];
}

const TZ = 'Asia/Kolkata';

function iso(local: string): string {
  return `${local}:00+05:30`;
}

function addMinutes(local: string, minutes: number): string {
  const date = new Date(`${local}:00Z`);
  const end = new Date(date.getTime() + minutes * 60_000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${end.getUTCFullYear()}-${pad(end.getUTCMonth() + 1)}-${pad(end.getUTCDate())}T${pad(end.getUTCHours())}:${pad(end.getUTCMinutes())}`;
}

function findResults(ctx: SimulationContext): SimEvent[] {
  for (let index = ctx.toolCalls.length - 1; index >= 0; index -= 1) {
    const call = ctx.toolCalls[index]!;
    if (!call.result.ok) continue;
    if (call.tool !== 'calendar_list_events' && call.tool !== 'find_events') continue;
    const content = call.result.content as { items?: Array<Record<string, unknown>> } | undefined;
    const items = content?.items ?? [];
    return items.map((item) => {
      const start = (item.start as { dateTime?: string } | undefined)?.dateTime ?? '';
      const end = (item.end as { dateTime?: string } | undefined)?.dateTime ?? '';
      const attendees = Array.isArray(item.attendees)
        ? (item.attendees as Array<{ email?: string }>).map((attendee) => attendee.email ?? '').filter(Boolean)
        : [];
      return {
        id: String(item.id ?? ''),
        summary: String(item.summary ?? ''),
        start,
        end,
        attendees,
      };
    });
  }
  return [];
}

function createdIds(ctx: SimulationContext): string[] {
  const ids: string[] = [];
  for (const call of ctx.toolCalls) {
    if (!call.result.ok) continue;
    if (call.tool !== 'calendar_create_event' && call.tool !== 'schedule_event') continue;
    const content = call.result.content as { id?: unknown } | undefined;
    if (typeof content?.id === 'string') ids.push(content.id);
  }
  return ids;
}

function findArgs(
  condition: ConditionId,
  params: Record<string, unknown>,
): { tool: string; args: Record<string, unknown> } {
  const from = String(params.fromLocal);
  const to = String(params.toLocal);
  const text = typeof params.text === 'string' ? params.text : undefined;
  if (condition === 'adapted') {
    return {
      tool: 'find_events',
      args: { from, to, ...(text ? { text } : {}), limit: 50 },
    };
  }
  return {
    tool: 'calendar_list_events',
    args: {
      calendar_id: 'primary',
      time_min: iso(from),
      time_max: iso(to),
      ...(text ? { query: text } : {}),
      max_results: 50,
    },
  };
}

function createArgs(
  condition: ConditionId,
  params: Record<string, unknown>,
): { tool: string; args: Record<string, unknown> } {
  const summary = String(params.summary);
  const startLocal = String(params.startLocal);
  const duration = Number(params.durationMinutes);
  const attendees = Array.isArray(params.attendees) ? (params.attendees as string[]) : [];
  const location = typeof params.location === 'string' ? params.location : undefined;
  const notes = typeof params.notes === 'string' ? params.notes : undefined;
  if (condition === 'adapted') {
    return {
      tool: 'schedule_event',
      args: {
        title: summary,
        start: startLocal,
        duration_minutes: duration,
        ...(attendees.length > 0 ? { attendees } : {}),
        ...(location ? { location } : {}),
        ...(notes ? { notes } : {}),
      },
    };
  }
  return {
    tool: 'calendar_create_event',
    args: {
      calendar_id: 'primary',
      event: {
        summary,
        start: { dateTime: iso(startLocal), timeZone: TZ },
        end: { dateTime: iso(addMinutes(startLocal, duration)), timeZone: TZ },
        ...(attendees.length > 0 ? { attendees: attendees.map((email) => ({ email })) } : {}),
        ...(location ? { location } : {}),
        ...(notes ? { description: notes } : {}),
      },
    },
  };
}

function selectorsFor(target: SimEvent): { title: string; date: string; start_time: string } {
  return { title: target.summary, date: target.start.slice(0, 10), start_time: target.start.slice(11, 16) };
}

function patchArgs(
  condition: ConditionId,
  params: Record<string, unknown>,
  target: SimEvent,
): { tool: string; args: Record<string, unknown> } {
  const eventId = target.id;
  const startLocal = typeof params.startLocal === 'string' ? params.startLocal : undefined;
  const duration = typeof params.durationMinutes === 'number' ? params.durationMinutes : undefined;
  const location = typeof params.location === 'string' ? params.location : undefined;
  const notes = typeof params.notes === 'string' ? params.notes : undefined;
  const attendees = Array.isArray(params.attendees) ? (params.attendees as string[]) : undefined;
  const newTitle = typeof params.newTitle === 'string' ? params.newTitle : undefined;
  if (condition === 'adapted') {
    // v2 adapter: target by title + date (+ current HH:MM); time moves keep the event's own duration.
    if (startLocal) {
      return { tool: 'move_event', args: { ...selectorsFor(target), new_start: startLocal } };
    }
    return {
      tool: 'update_event',
      args: {
        ...selectorsFor(target),
        ...(newTitle ? { new_title: newTitle } : {}),
        ...(location ? { location } : {}),
        ...(notes ? { notes } : {}),
        ...(attendees ? { attendees } : {}),
      },
    };
  }
  return {
    tool: 'calendar_patch_event',
    args: {
      calendar_id: 'primary',
      event_id: eventId,
      patch: {
        ...(startLocal ? { start: { dateTime: iso(startLocal) } } : {}),
        ...(startLocal && duration ? { end: { dateTime: iso(addMinutes(startLocal, duration)) } } : {}),
        ...(newTitle ? { summary: newTitle } : {}),
        ...(location ? { location } : {}),
        ...(notes ? { description: notes } : {}),
        ...(attendees ? { attendees: attendees.map((email) => ({ email })) } : {}),
      },
    },
  };
}

/** Exact title, optionally narrowed by the current local start "YYYY-MM-DDTHH:MM". */
function pickTarget(ctx: SimulationContext, params: Record<string, unknown>): SimEvent | undefined {
  const title = String(params.matchTitle);
  const startLocal = typeof params.matchStartLocal === 'string' ? params.matchStartLocal : undefined;
  return findResults(ctx).find((event) => event.summary === title && (!startLocal || event.start.startsWith(startLocal)));
}

function cancelArgs(condition: ConditionId, target: SimEvent): { tool: string; args: Record<string, unknown> } {
  if (condition === 'adapted') return { tool: 'cancel_event', args: selectorsFor(target) };
  return { tool: 'calendar_delete_event', args: { calendar_id: 'primary', event_id: target.id } };
}

export function simulateCalendar(step: SimulationStep, ctx: SimulationContext): SimulatedAction {
  const params = step.params ?? {};
  const condition = ctx.condition;
  switch (step.intent) {
    case 'find':
      return findArgs(condition, params);
    case 'create':
      return createArgs(condition, params);
    case 'patch': {
      const target = pickTarget(ctx, params);
      if (!target) {
        return { answer: `Unable to resolve an event id for "${String(params.matchTitle)}" from the tool results.` };
      }
      return patchArgs(condition, params, target);
    }
    case 'cancel_if_exists': {
      const target = pickTarget(ctx, params);
      if (!target) return { answer: JSON.stringify({ event_ids: [] }) };
      return cancelArgs(condition, target);
    }
    case 'answer_deleted': {
      const deleted = ctx.toolCalls
        .filter((call) => call.result.ok && (call.tool === 'calendar_delete_event' || call.tool === 'cancel_event'))
        .map((call) => String((call.result.content as { event_id?: unknown } | undefined)?.event_id ?? ''))
        .filter(Boolean);
      return { answer: JSON.stringify({ event_ids: deleted }) };
    }
    case 'cancel': {
      const target = pickTarget(ctx, params);
      if (!target) {
        return { answer: `Unable to resolve an event id for "${String(params.matchTitle)}" from the tool results.` };
      }
      return cancelArgs(condition, target);
    }
    case 'create_unless_exists': {
      const create = (params.create ?? {}) as Record<string, unknown>;
      const results = findResults(ctx);
      const exists = results.some((event) => event.summary === String(params.matchTitle));
      if (exists) return { answer: JSON.stringify({ event_ids: [] }) };
      return createArgs(condition, create);
    }
    case 'create_if_free': {
      const startLocal = String(params.startLocal);
      const duration = Number(params.durationMinutes);
      const candidateStart = Date.parse(iso(startLocal));
      const candidateEnd = candidateStart + duration * 60_000;
      const conflicts = findResults(ctx).some((event) => Date.parse(event.start) < candidateEnd && Date.parse(event.end) > candidateStart);
      if (conflicts) return { answer: JSON.stringify({ event_ids: [] }) };
      return createArgs(condition, params);
    }
    case 'answer_query': {
      let results = findResults(ctx);
      if (typeof params.requireAttendee === 'string') {
        results = results.filter((event) => event.attendees.includes(String(params.requireAttendee)));
      }
      results.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
      return { answer: JSON.stringify({ event_ids: results.map((event) => event.id) }) };
    }
    case 'answer_created':
      return { answer: JSON.stringify({ event_ids: createdIds(ctx) }) };
    case 'confirm':
      return { answer: 'Done.' };
    default:
      return { answer: `The scripted policy does not implement intent "${step.intent}".` };
  }
}

/** Exposed for unit tests of the labelled rehearsal policy. */
export function calendarSimulatorContext(
  state: unknown,
  condition: ConditionId,
  toolCalls: Array<{ tool: string; args: Record<string, unknown>; result: ToolExecResult }> = [],
): SimulationContext {
  return { state, memory: {}, toolCalls, stepIndex: 0, condition };
}

export type CalendarSimToolContext = ToolCallContext;