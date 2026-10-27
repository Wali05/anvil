import type { DomainTool, JsonSchema, ToolExecResult } from '../../core/types.js';
import { asCalendarState, CALENDAR_ID, CALENDAR_TZ, nextEventId, type CalendarEvent, type CalendarState } from './state.js';

const listSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['calendar_id', 'time_min', 'time_max'],
  properties: {
    calendar_id: { type: 'string', description: 'Calendar identifier.' },
    time_min: { type: 'string', format: 'date-time', description: 'Lower bound.' },
    time_max: { type: 'string', format: 'date-time', description: 'Upper bound.' },
    query: { type: 'string', description: 'Free text filter.' },
    max_results: { type: 'integer', minimum: 1, maximum: 50, description: 'Page size.' },
  },
};

const dateTimeObject = (timeZoneRequired: boolean): JsonSchema => ({
  type: 'object',
  additionalProperties: false,
  required: timeZoneRequired ? ['dateTime', 'timeZone'] : ['dateTime'],
  properties: {
    dateTime: { type: 'string', format: 'date-time', description: 'RFC 3339 timestamp.' },
    timeZone: { type: 'string', description: 'IANA time zone.' },
  },
});

const attendeesSchema = {
  type: 'array' as const,
  maxItems: 20,
  items: {
    type: 'object' as const,
    additionalProperties: false,
    required: ['email'],
    properties: {
      email: { type: 'string' as const, format: 'email', description: 'Attendee email.' },
      responseStatus: { type: 'string' as const, enum: ['accepted', 'declined', 'needsAction'] },
    },
  },
};

const createSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['calendar_id', 'event'],
  properties: {
    calendar_id: { type: 'string', description: 'Calendar identifier.' },
    event: {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'start', 'end'],
      properties: {
        summary: { type: 'string', minLength: 1, maxLength: 200, description: 'Title.' },
        start: dateTimeObject(true),
        end: dateTimeObject(true),
        attendees: attendeesSchema,
        location: { type: 'string', maxLength: 200 },
        description: { type: 'string', maxLength: 2000 },
      },
    },
  },
};

const patchSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['calendar_id', 'event_id', 'patch'],
  properties: {
    calendar_id: { type: 'string' },
    event_id: { type: 'string', minLength: 1 },
    patch: {
      type: 'object',
      additionalProperties: false,
      properties: {
        summary: { type: 'string', minLength: 1, maxLength: 200 },
        start: dateTimeObject(false),
        end: dateTimeObject(false),
        attendees: attendeesSchema,
        location: { type: 'string', maxLength: 200 },
        description: { type: 'string', maxLength: 2000 },
      },
    },
  },
};

const deleteSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['calendar_id', 'event_id'],
  properties: {
    calendar_id: { type: 'string' },
    event_id: { type: 'string', minLength: 1 },
  },
};

function requireCalendar(state: CalendarState, calendarId: string): ToolExecResult | null {
  if (calendarId !== state.calendarId) {
    return {
      ok: false,
      error: { code: 'calendar_not_found', message: `Calendar "${calendarId}" is not connected. The connected calendar id is "${state.calendarId}".` },
    };
  }
  return null;
}

function toWireEvent(event: CalendarEvent) {
  return {
    id: event.id,
    summary: event.summary,
    start: { dateTime: event.start, timeZone: CALENDAR_TZ },
    end: { dateTime: event.end, timeZone: CALENDAR_TZ },
    ...(event.attendees.length > 0 ? { attendees: event.attendees.map((email) => ({ email })) } : {}),
    ...(event.location ? { location: event.location } : {}),
    ...(event.description ? { description: event.description } : {}),
    status: event.status,
    created_at: event.created_at,
  };
}

function assertTimeRange(start: string, end: string): ToolExecResult | null {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return { ok: false, error: { code: 'invalid_time', message: 'start and end must be valid RFC 3339 date-times.' } };
  }
  if (endMs <= startMs) {
    return { ok: false, error: { code: 'invalid_time_range', message: 'Event end must be after event start.' } };
  }
  return null;
}

export const calendarTools: DomainTool[] = [
  {
    name: 'calendar_list_events',
    description: 'List calendar events. Requires a calendar id and RFC 3339 bounds.',
    outputDescription: 'A calendar#events envelope with items containing nested start/end objects.',
    permissions: [{ scope: 'calendar.events:read', write: false }],
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: listSchema,
    execute(state, args) {
      const calendar = asCalendarState(state);
      const calendarId = String(args.calendar_id);
      const badCalendar = requireCalendar(calendar, calendarId);
      if (badCalendar) return badCalendar;
      const min = Date.parse(String(args.time_min));
      const max = Date.parse(String(args.time_max));
      if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
        return { ok: false, error: { code: 'invalid_time_range', message: 'time_min and time_max must be valid and time_max must be later.' } };
      }
      const text = typeof args.query === 'string' ? args.query.toLowerCase().trim() : '';
      const limit = typeof args.max_results === 'number' ? args.max_results : 20;
      const items = calendar.events
        .filter((event) => Date.parse(event.start) < max && Date.parse(event.end) > min)
        .filter((event) => {
          if (!text) return true;
          const haystack = [event.summary, event.description ?? '', event.location ?? '', ...event.attendees].join(' ').toLowerCase();
          return haystack.includes(text);
        })
        .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
        .slice(0, limit)
        .map(toWireEvent);
      return {
        ok: true,
        content: {
          kind: 'calendar#events',
          calendar_id: calendarId,
          time_zone: calendar.timezone,
          items,
          next_page_token: null,
        },
      };
    },
  },
  {
    name: 'calendar_create_event',
    description: 'Create an event. Input is a calendar envelope with a nested event resource.',
    outputDescription: 'The created event resource, including its generated id.',
    permissions: [{ scope: 'calendar.events:write', write: true }],
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: createSchema,
    execute(state, args, ctx) {
      const calendar = asCalendarState(state);
      const badCalendar = requireCalendar(calendar, String(args.calendar_id));
      if (badCalendar) return badCalendar;
      const event = args.event as {
        summary: string;
        start: { dateTime: string; timeZone: string };
        end: { dateTime: string; timeZone: string };
        attendees?: Array<{ email: string }>;
        location?: string;
        description?: string;
      };
      const timeError = assertTimeRange(event.start.dateTime, event.end.dateTime);
      if (timeError) return timeError;
      if (event.start.timeZone !== calendar.timezone || event.end.timeZone !== calendar.timezone) {
        return {
          ok: false,
          error: {
            code: 'timezone_not_supported',
            message: `This fixture calendar only accepts the time zone "${calendar.timezone}".`,
          },
        };
      }
      const created: CalendarEvent = {
        id: nextEventId(calendar),
        summary: event.summary,
        start: event.start.dateTime,
        end: event.end.dateTime,
        location: event.location ?? null,
        description: event.description ?? null,
        attendees: (event.attendees ?? []).map((attendee) => attendee.email),
        status: 'confirmed',
        created_at: ctx.now,
      };
      calendar.events.push(created);
      return { ok: true, content: toWireEvent(created) };
    },
  },
  {
    name: 'calendar_patch_event',
    description: 'Patch selected fields of one event by id. Unspecified fields are unchanged.',
    outputDescription: 'The updated event resource.',
    permissions: [{ scope: 'calendar.events:write', write: true }],
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: patchSchema,
    execute(state, args) {
      const calendar = asCalendarState(state);
      const badCalendar = requireCalendar(calendar, String(args.calendar_id));
      if (badCalendar) return badCalendar;
      const event = calendar.events.find((candidate) => candidate.id === String(args.event_id));
      if (!event) {
        return { ok: false, error: { code: 'event_not_found', message: `No event with id "${String(args.event_id)}".` } };
      }
      const patch = args.patch as {
        summary?: string;
        start?: { dateTime: string; timeZone?: string };
        end?: { dateTime: string; timeZone?: string };
        attendees?: Array<{ email: string }>;
        location?: string;
        description?: string;
      };
      const nextStart = patch.start?.dateTime ?? event.start;
      const nextEnd = patch.end?.dateTime ?? event.end;
      const timeError = assertTimeRange(nextStart, nextEnd);
      if (timeError) return timeError;
      if (patch.summary !== undefined) event.summary = patch.summary;
      if (patch.start?.dateTime !== undefined) event.start = patch.start.dateTime;
      if (patch.end?.dateTime !== undefined) event.end = patch.end.dateTime;
      if (patch.location !== undefined) event.location = patch.location;
      if (patch.description !== undefined) event.description = patch.description;
      if (patch.attendees !== undefined) event.attendees = patch.attendees.map((attendee) => attendee.email);
      return { ok: true, content: toWireEvent(event) };
    },
  },
  {
    name: 'calendar_delete_event',
    description: 'Delete one event by id.',
    outputDescription: 'A deletion confirmation envelope.',
    permissions: [{ scope: 'calendar.events:write', write: true }],
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: deleteSchema,
    execute(state, args) {
      const calendar = asCalendarState(state);
      const badCalendar = requireCalendar(calendar, String(args.calendar_id));
      if (badCalendar) return badCalendar;
      const index = calendar.events.findIndex((event) => event.id === String(args.event_id));
      if (index < 0) {
        return { ok: false, error: { code: 'event_not_found', message: `No event with id "${String(args.event_id)}".` } };
      }
      const [removed] = calendar.events.splice(index, 1);
      return { ok: true, content: { deleted: true, event_id: removed?.id ?? String(args.event_id) } };
    },
  },
];

export const calendarFieldDescriptions: Record<string, Record<string, string>> = {
  calendar_list_events: {
    '': 'List events in the connected calendar. Pass bounds as full RFC 3339 timestamps with the +05:30 offset, e.g. 2026-11-09T00:00:00+05:30. The connected calendar id is "primary".',
    time_min: 'Inclusive lower bound as an RFC 3339 timestamp with the +05:30 offset.',
    time_max: 'Exclusive upper bound as an RFC 3339 timestamp with the +05:30 offset.',
    query: 'Optional case-insensitive text matched against title, description, location and attendee emails.',
    max_results: 'Maximum number of events to return; defaults to 20.',
  },
  calendar_create_event: {
    '': 'Create one event. Wrap it in the required calendar envelope. Both start and end must be full RFC 3339 timestamps with the +05:30 offset, and both timeZone values must be "Asia/Kolkata".',
    calendar_id: 'Use "primary" for the only connected calendar.',
    'event.start': 'Start time object. dateTime needs a full RFC 3339 timestamp; timeZone must be Asia/Kolkata.',
    'event.end': 'End time object. dateTime needs a full RFC 3339 timestamp; timeZone must be Asia/Kolkata.',
    'event.start.dateTime': 'RFC 3339 with offset, e.g. 2026-11-03T15:30:00+05:30.',
    'event.end.dateTime': 'RFC 3339 with offset. Must be strictly later than start.',
    'event.attendees': 'Array of attendee objects, each with an email string.',
    'event.summary': 'Event title.',
    'event.location': 'Optional room or meeting location.',
    'event.description': 'Optional notes.',
  },
  calendar_patch_event: {
    '': 'Patch one event by id. Include both start and end when moving an event; changing only one may make the interval invalid and is rejected.',
    event_id: 'Id such as evt_1001, found through calendar_list_events.',
    'patch.start.dateTime': 'Full RFC 3339 start with +05:30 offset.',
    'patch.end.dateTime': 'Full RFC 3339 end with +05:30 offset, later than patch.start.dateTime if both are given.',
    'patch.attendees': 'Replaces the attendee list when present.',
    'patch.location': 'Replaces the location when present.',
  },
  calendar_delete_event: {
    '': 'Delete exactly one event by id. This is destructive and removes the event.',
    event_id: 'Id such as evt_1003, found through calendar_list_events.',
  },
};