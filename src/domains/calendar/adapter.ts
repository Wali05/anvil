import type { AdapterLookupSpec, AdapterSpec } from '../../core/types.js';
import { makeAdapterSpec } from '../../core/adapter.js';

const localDateTime = {
  type: 'string' as const,
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$',
  description: 'Local date-time in Asia/Kolkata, e.g. 2026-11-03T15:30 (no offset).',
};

const localDate = {
  type: 'string' as const,
  pattern: '^\\d{4}-\\d{2}-\\d{2}$',
  description: 'Local date in Asia/Kolkata, e.g. 2026-11-05.',
};

const localClock = {
  type: 'string' as const,
  pattern: '^([01]\\d|2[0-3]):[0-5]\\d$',
  description: 'Optional current local start time HH:MM, only needed if two events share the title that day.',
};

/** Shared v2 lookup: one read-only list call for that local day, exact title (+ optional HH:MM start). */
const dayLookup: AdapterLookupSpec = {
  tool: 'calendar_list_events',
  arguments: [
    { to: 'calendar_id', const: 'primary' },
    { to: 'time_min', from: 'date', transform: { kind: 'dayStart', assumeOffset: '+05:30' }, required: true },
    { to: 'time_max', from: 'date', transform: { kind: 'dayEnd', assumeOffset: '+05:30' }, required: true },
    { to: 'max_results', const: 50 },
  ],
  resultsPath: 'items',
  match: [
    { field: 'summary', from: 'title', compare: 'exact' },
    { field: 'start.dateTime', from: 'start_time', compare: 'localTime' },
  ],
  idField: 'id',
  bindTo: 'event_id',
  display: ['id', 'summary', 'start.dateTime', 'end.dateTime', 'location'],
};

const emailList = {
  type: 'array' as const,
  maxItems: 20,
  items: { type: 'string' as const, format: 'email' },
  description: 'Attendee email addresses. The adapter wraps them into the original attendee objects.',
};

export const calendarAdapter: AdapterSpec = makeAdapterSpec({
  domain: 'calendar',
  version: '2.0.0',
  description:
    'Calendar adapter v2: flat local times, explicit durations, constant calendar id, string attendee emails, and title+date targeting (one exact-match read-only lookup) for update, move and cancel instead of model-supplied ids.',
  tools: [
    {
      name: 'find_events',
      description:
        'Find calendar events with simple local-time bounds. Returns the original calendar#events envelope; event ids are in items[].id.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['from', 'to'],
        properties: {
          from: { ...localDateTime, description: 'Inclusive local start bound, e.g. 2026-11-09T00:00.' },
          to: { ...localDateTime, description: 'Exclusive local end bound, e.g. 2026-11-10T00:00.' },
          text: { type: 'string', description: 'Optional case-insensitive text filter.' },
          limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum events to return.' },
        },
      },
      target: 'calendar_list_events',
      arguments: [
        { to: 'calendar_id', const: 'primary' },
        { to: 'time_min', from: 'from', transform: { kind: 'isoDateTime', assumeOffset: '+05:30' }, required: true },
        { to: 'time_max', from: 'to', transform: { kind: 'isoDateTime', assumeOffset: '+05:30' }, required: true },
        { to: 'query', from: 'text' },
        { to: 'max_results', from: 'limit' },
      ],
      notes: 'No output remapping: the original envelope is returned unchanged.',
    },
    {
      name: 'schedule_event',
      description:
        'Schedule an event from a title, local start, duration and optional attendee emails. The adapter supplies the calendar id, time zone, offset and end time.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'start', 'duration_minutes'],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 200 },
          start: localDateTime,
          duration_minutes: { type: 'integer', minimum: 1, maximum: 1440 },
          attendees: emailList,
          location: { type: 'string', maxLength: 200 },
          notes: { type: 'string', maxLength: 2000 },
        },
      },
      target: 'calendar_create_event',
      arguments: [
        { to: 'calendar_id', const: 'primary' },
        { to: 'event.summary', from: 'title', required: true },
        { to: 'event.start.dateTime', from: 'start', transform: { kind: 'isoDateTime', assumeOffset: '+05:30' }, required: true },
        { to: 'event.start.timeZone', const: 'Asia/Kolkata' },
        {
          to: 'event.end.dateTime',
          from: 'duration_minutes',
          transform: { kind: 'durationEnd', startField: 'start', durationField: 'duration_minutes', assumeOffset: '+05:30' },
          required: true,
        },
        { to: 'event.end.timeZone', const: 'Asia/Kolkata' },
        { to: 'event.attendees', from: 'attendees', transform: { kind: 'wrapEmail' } },
        { to: 'event.location', from: 'location' },
        { to: 'event.description', from: 'notes' },
      ],
      notes: 'Start plus duration deterministically computes the end in Asia/Kolkata.',
    },
    {
      name: 'update_event',
      description:
        'Change the title, location, notes or attendees of ONE existing event. Identify it by its current exact title and its date (add start_time if two events share that title on that day). The adapter finds it with one read-only search and edits only that event; if zero or several events match, nothing is changed and the candidates are returned. To change the time, use move_event.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'date'],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 200, description: 'Current exact title of the event to change.' },
          date: localDate,
          start_time: localClock,
          new_title: { type: 'string', minLength: 1, maxLength: 200, description: 'Replacement title, only if the title should change.' },
          attendees: emailList,
          location: { type: 'string', maxLength: 200, description: 'Replacement location.' },
          notes: { type: 'string', maxLength: 2000, description: 'Replacement description.' },
        },
      },
      target: 'calendar_patch_event',
      lookup: dayLookup,
      arguments: [
        { to: 'calendar_id', const: 'primary' },
        { to: 'patch.summary', from: 'new_title' },
        { to: 'patch.attendees', from: 'attendees', transform: { kind: 'wrapEmail' } },
        { to: 'patch.location', from: 'location' },
        { to: 'patch.description', from: 'notes' },
      ],
      notes: 'One read-only lookup (exact title on that local day, optional HH:MM start) binds event_id; then exactly one patch call.',
    },
    {
      name: 'move_event',
      description:
        'Move ONE existing event to a new local start time, keeping its own duration, attendees, location and description. Identify it by its current exact title and date (add start_time if two events share that title that day). If zero or several events match, nothing is changed and the candidates are returned.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'date', 'new_start'],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 200, description: 'Current exact title of the event to move.' },
          date: { ...localDate, description: 'The day the event is on NOW, e.g. 2026-11-05.' },
          start_time: { ...localClock, description: 'Optional current start time HH:MM, only to tell same-titled events apart.' },
          new_start: { ...localDateTime, description: 'New local start in Asia/Kolkata, e.g. 2026-11-05T17:00.' },
        },
      },
      target: 'calendar_patch_event',
      lookup: dayLookup,
      arguments: [
        { to: 'calendar_id', const: 'primary' },
        { to: 'patch.start.dateTime', from: 'new_start', transform: { kind: 'isoDateTime', assumeOffset: '+05:30' }, required: true },
        {
          to: 'patch.end.dateTime',
          from: 'new_start',
          transform: { kind: 'keepDurationEnd', itemStart: 'start.dateTime', itemEnd: 'end.dateTime', assumeOffset: '+05:30' },
          required: true,
        },
      ],
      notes: 'The new end is the new start plus the matched event\'s own duration; no other field is sent.',
    },
    {
      name: 'cancel_event',
      description:
        'Delete ONE existing event. Identify it by its exact title and date (add start_time if two events share that title that day). Destructive. If zero or several events match, nothing is deleted and the candidates are returned.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'date'],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 200, description: 'Exact title of the event to delete.' },
          date: localDate,
          start_time: localClock,
        },
      },
      target: 'calendar_delete_event',
      lookup: dayLookup,
      arguments: [{ to: 'calendar_id', const: 'primary' }],
      notes: 'One read-only lookup binds event_id; then exactly one delete call through the original executor.',
    },
  ],
});