import { jsonArrayContract } from '../../core/contract.js';
import type { TaskDefinition } from '../../core/types.js';
import { expectCreated, expectEventIds, expectRemoved, expectUnchanged, expectUpdated } from './validators.js';

const eventIdsContract = jsonArrayContract(
  'event_ids',
  '{"event_ids": ["evt_1001"]}',
  'Final message must be one JSON object with an event_ids array of event id strings.',
);

export const calendarTasks: TaskDefinition[] = [
  {
    id: 'cal-dev-create-basic',
    domain: 'calendar',
    family: 'create',
    split: 'dev',
    title: 'Create a basic event',
    prompt:
      'Schedule a 45-minute event titled "Design review follow-up" on 3 November 2026 starting at 15:30 Asia/Kolkata. It has no attendees and no location. Do not modify any existing event.',
    validate(initial, final) {
      return expectCreated(initial, final, {
        summary: 'Design review follow-up',
        start: '2026-11-03T15:30:00+05:30',
        end: '2026-11-03T16:15:00+05:30',
        attendees: [],
        location: null,
        description: null,
      });
    },
    simulation: [
      { intent: 'create', params: { summary: 'Design review follow-up', startLocal: '2026-11-03T15:30', durationMinutes: 45 } },
      { intent: 'confirm' },
    ],
  },
  {
    id: 'cal-dev-create-attendees',
    domain: 'calendar',
    family: 'create_with_attendees',
    split: 'dev',
    title: 'Create an event with attendees and a room',
    prompt:
      'Create a 60-minute event titled "Sprint planning" on 4 November 2026 starting at 09:00 Asia/Kolkata in "Room 4B", with attendees priya@acme.test and sam@acme.test. Do not modify any existing event.',
    validate(initial, final) {
      return expectCreated(initial, final, {
        summary: 'Sprint planning',
        start: '2026-11-04T09:00:00+05:30',
        end: '2026-11-04T10:00:00+05:30',
        attendees: ['priya@acme.test', 'sam@acme.test'],
        location: 'Room 4B',
        description: null,
      });
    },
    simulation: [
      {
        intent: 'create',
        params: {
          summary: 'Sprint planning',
          startLocal: '2026-11-04T09:00',
          durationMinutes: 60,
          attendees: ['priya@acme.test', 'sam@acme.test'],
          location: 'Room 4B',
        },
      },
      { intent: 'confirm' },
    ],
  },
  {
    id: 'cal-dev-reschedule',
    domain: 'calendar',
    family: 'reschedule',
    split: 'dev',
    title: 'Move an existing event',
    prompt:
      'Move the existing "Vendor sync" on 5 November 2026 at 15:00 to 17:00 the same day. Keep its 60-minute duration, attendees, location and description. Do not change any other event.',
    validate(initial, final) {
      return expectUpdated(initial, final, 'evt_1001', {
        start: '2026-11-05T17:00:00+05:30',
        end: '2026-11-05T18:00:00+05:30',
      });
    },
    simulation: [
      { intent: 'find', params: { fromLocal: '2026-11-05T00:00', toLocal: '2026-11-06T00:00', text: 'Vendor sync' } },
      { intent: 'patch', params: { matchTitle: 'Vendor sync', startLocal: '2026-11-05T17:00', durationMinutes: 60 } },
      { intent: 'confirm' },
    ],
  },
  {
    id: 'cal-dev-cancel',
    domain: 'calendar',
    family: 'cancel',
    split: 'dev',
    title: 'Delete one event',
    prompt: 'Delete the existing "Budget review" on 6 November 2026 at 11:00. Leave every other event untouched.',
    validate(initial, final) {
      return expectRemoved(initial, final, 'evt_1003');
    },
    simulation: [
      { intent: 'find', params: { fromLocal: '2026-11-06T00:00', toLocal: '2026-11-07T00:00', text: 'Budget review' } },
      { intent: 'cancel', params: { matchTitle: 'Budget review' } },
      { intent: 'confirm' },
    ],
  },
  {
    id: 'cal-dev-query-day',
    domain: 'calendar',
    family: 'query',
    split: 'dev',
    title: 'List one day of events',
    prompt:
      'List the ids of events on 9 November 2026 (Asia/Kolkata), ordered by start time. Reply with exactly one JSON object shaped like {"event_ids": ["evt_..."]} and nothing else.',
    outputContract: eventIdsContract,
    validate(initial, final, answer) {
      return expectEventIds(initial, final, answer, ['evt_1006', 'evt_1010']);
    },
    simulation: [
      { intent: 'find', params: { fromLocal: '2026-11-09T00:00', toLocal: '2026-11-10T00:00' } },
      { intent: 'answer_query' },
    ],
  },
  {
    id: 'cal-dev-update-location',
    domain: 'calendar',
    family: 'update_field',
    split: 'dev',
    title: 'Change only one field',
    prompt:
      'Change the location of the existing "Hiring sync" on 4 November 2026 at 11:00 to "Room 4B". Keep its title, time, attendees and description unchanged. Do not change any other event.',
    validate(initial, final) {
      return expectUpdated(initial, final, 'evt_1007', { location: 'Room 4B' });
    },
    simulation: [
      { intent: 'find', params: { fromLocal: '2026-11-04T00:00', toLocal: '2026-11-05T00:00', text: 'Hiring sync' } },
      { intent: 'patch', params: { matchTitle: 'Hiring sync', location: 'Room 4B' } },
      { intent: 'confirm' },
    ],
  },
  {
    id: 'cal-dev-avoid-duplicate',
    domain: 'calendar',
    family: 'conditional',
    split: 'dev',
    title: 'Create only when absent',
    prompt:
      'On 9 November 2026 there may already be an event titled "Customer demo". Create a 30-minute "Customer demo" at 10:00 Asia/Kolkata only if no event with that exact title already exists that day. If one exists, create nothing. Never modify existing events. Reply with exactly {"event_ids": [...]} containing the id of any event you created, or an empty array.',
    outputContract: eventIdsContract,
    validate(initial, final, answer) {
      return expectEventIds(initial, final, answer, []);
    },
    simulation: [
      { intent: 'find', params: { fromLocal: '2026-11-09T00:00', toLocal: '2026-11-10T00:00', text: 'Customer demo' } },
      {
        intent: 'create_unless_exists',
        params: {
          matchTitle: 'Customer demo',
          create: { summary: 'Customer demo', startLocal: '2026-11-09T10:00', durationMinutes: 30 },
        },
      },
      { intent: 'answer_created' },
    ],
    notes: 'The fixture already has a matching event, so the honest outcome is no change.',
  },
  {
    id: 'cal-eval-create',
    domain: 'calendar',
    family: 'create',
    split: 'eval',
    title: 'Create an event near a similarly titled distractor',
    prompt:
      'Schedule a 30-minute event titled "Audit kickoff" on 12 November 2026 starting at 14:15 Asia/Kolkata with attendee audit@acme.test in "Room 4B". Do not modify any existing event.',
    validate(initial, final) {
      return expectCreated(initial, final, {
        summary: 'Audit kickoff',
        start: '2026-11-12T14:15:00+05:30',
        end: '2026-11-12T14:45:00+05:30',
        attendees: ['audit@acme.test'],
        location: 'Room 4B',
        description: null,
      });
    },
    simulation: [
      {
        intent: 'create',
        params: {
          summary: 'Audit kickoff',
          startLocal: '2026-11-12T14:15',
          durationMinutes: 30,
          attendees: ['audit@acme.test'],
          location: 'Room 4B',
        },
      },
      { intent: 'confirm' },
    ],
  },
  {
    id: 'cal-eval-create-partner',
    domain: 'calendar',
    family: 'create_with_attendees',
    split: 'eval',
    title: 'Create a longer event with two attendees',
    prompt:
      'Create a 90-minute event titled "Partner workshop" on 16 November 2026 starting at 13:30 Asia/Kolkata in "Room 2A" with attendees partner@example.com and sam@acme.test. Do not modify any existing event.',
    validate(initial, final) {
      return expectCreated(initial, final, {
        summary: 'Partner workshop',
        start: '2026-11-16T13:30:00+05:30',
        end: '2026-11-16T15:00:00+05:30',
        attendees: ['partner@example.com', 'sam@acme.test'],
        location: 'Room 2A',
        description: null,
      });
    },
    simulation: [
      {
        intent: 'create',
        params: {
          summary: 'Partner workshop',
          startLocal: '2026-11-16T13:30',
          durationMinutes: 90,
          attendees: ['partner@example.com', 'sam@acme.test'],
          location: 'Room 2A',
        },
      },
      { intent: 'confirm' },
    ],
  },
  {
    id: 'cal-eval-reschedule',
    domain: 'calendar',
    family: 'reschedule',
    split: 'eval',
    title: 'Move an event earlier without changing its details',
    prompt:
      'Move the existing "Retro" on 18 November 2026 at 16:00 to 11:30 the same day, keeping its 60-minute duration, attendee and location. Do not change any other event.',
    validate(initial, final) {
      return expectUpdated(initial, final, 'evt_1011', {
        start: '2026-11-18T11:30:00+05:30',
        end: '2026-11-18T12:30:00+05:30',
      });
    },
    simulation: [
      { intent: 'find', params: { fromLocal: '2026-11-18T00:00', toLocal: '2026-11-19T00:00', text: 'Retro' } },
      { intent: 'patch', params: { matchTitle: 'Retro', startLocal: '2026-11-18T11:30', durationMinutes: 60 } },
      { intent: 'confirm' },
    ],
  },
  {
    id: 'cal-eval-cancel',
    domain: 'calendar',
    family: 'cancel',
    split: 'eval',
    title: 'Delete the right event among near-duplicates',
    prompt:
      'Delete exactly the existing "Board prep" on 13 November 2026 at 10:00. Do not delete or modify "Board prep archive", "Board prep dry run", or any other event.',
    validate(initial, final) {
      return expectRemoved(initial, final, 'evt_1004');
    },
    simulation: [
      { intent: 'find', params: { fromLocal: '2026-11-13T00:00', toLocal: '2026-11-14T00:00', text: 'Board prep' } },
      { intent: 'cancel', params: { matchTitle: 'Board prep' } },
      { intent: 'confirm' },
    ],
    notes: 'Three events share the phrase "Board prep"; the exact title and time matter.',
  },
  {
    id: 'cal-eval-query-range',
    domain: 'calendar',
    family: 'query_range',
    split: 'eval',
    title: 'List a two-day range',
    prompt:
      'List the ids of events that overlap 12 November 2026 00:00 through 13 November 2026 23:59 Asia/Kolkata, ordered by start time. Reply with exactly one JSON object shaped like {"event_ids": ["evt_..."]}.',
    outputContract: eventIdsContract,
    validate(initial, final, answer) {
      return expectEventIds(initial, final, answer, ['evt_1009', 'evt_1014', 'evt_1004', 'evt_1005']);
    },
    simulation: [
      { intent: 'find', params: { fromLocal: '2026-11-12T00:00', toLocal: '2026-11-14T00:00' } },
      { intent: 'answer_query' },
    ],
  },
  {
    id: 'cal-eval-query-attendee',
    domain: 'calendar',
    family: 'query_filter',
    split: 'eval',
    title: 'Find events by attendee',
    prompt:
      'List the ids of all events in November 2026 that include sam@acme.test as an attendee, ordered by start time. Reply with exactly {"event_ids": ["evt_..."]}.',
    outputContract: eventIdsContract,
    validate(initial, final, answer) {
      return expectEventIds(initial, final, answer, ['evt_1006', 'evt_1015']);
    },
    simulation: [
      { intent: 'find', params: { fromLocal: '2026-11-01T00:00', toLocal: '2026-12-01T00:00', text: 'sam@acme.test' } },
      { intent: 'answer_query', params: { requireAttendee: 'sam@acme.test' } },
    ],
  },
  {
    id: 'cal-eval-availability',
    domain: 'calendar',
    family: 'availability',
    split: 'eval',
    title: 'Respect an existing conflict',
    prompt:
      'On 17 November 2026, "Focus block" is on the calendar from 15:00 to 16:00. Schedule a 30-minute "Budget pairing" at 15:30 Asia/Kolkata only if that half-hour slot does not overlap any existing event. If it overlaps, create nothing and do not move or modify anything. Reply with exactly {"event_ids": [...]} containing the created id or an empty array.',
    outputContract: eventIdsContract,
    validate(initial, final, answer) {
      return expectEventIds(initial, final, answer, []);
    },
    simulation: [
      { intent: 'find', params: { fromLocal: '2026-11-17T00:00', toLocal: '2026-11-18T00:00' } },
      {
        intent: 'create_if_free',
        params: {
          summary: 'Budget pairing',
          startLocal: '2026-11-17T15:30',
          durationMinutes: 30,
        },
      },
      { intent: 'answer_created' },
    ],
    notes: 'The requested slot overlaps Focus block, so the correct action is no write.',
  },
];