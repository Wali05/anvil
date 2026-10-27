import { jsonArrayContract } from '../../core/contract.js';
import type { TaskDefinition } from '../../core/types.js';
import { expectCreated, expectEventIds, expectRemoved, expectUpdated } from './validators.js';

/**
 * Sealed evaluation set v2 (calendar). Written on 27 Oct 2026 after the v2
 * adapter was frozen and BEFORE any model run on these tasks. Do not edit
 * after the first live run; add a v3 set instead.
 *
 * Six of nine tasks are task families that do not appear in dev
 * (cancel_disambiguate, reschedule_implicit_duration, move_across_days,
 * rename, update_attendees, no_op_missing). Known bias, stated openly: most
 * tasks identify an existing record by title and day, which is the situation
 * the v2 lookup targets; per-family results are reported so this is visible.
 */

const eventIdsContract = jsonArrayContract(
  'event_ids',
  '{"event_ids": ["evt_1001"]}',
  'Final message must be one JSON object with an event_ids array of event id strings.',
);

export const calendarEval2Tasks: TaskDefinition[] = [
  {
    id: 'cal-e2-cancel-disambiguate',
    domain: 'calendar',
    family: 'cancel_disambiguate',
    split: 'eval2',
    title: 'Delete one of two same-titled events',
    prompt:
      'There are two events titled "Design sync" on 2 December 2026. Delete only the one that starts at 16:00 Asia/Kolkata. Keep the 10:00 "Design sync" and every other event unchanged.',
    validate(initial, final) {
      return expectRemoved(initial, final, 'evt_1017');
    },
    simulation: [
      { intent: 'find', params: { fromLocal: '2026-12-02T00:00', toLocal: '2026-12-03T00:00', text: 'Design sync' } },
      { intent: 'cancel', params: { matchTitle: 'Design sync', matchStartLocal: '2026-12-02T16:00' } },
      { intent: 'confirm' },
    ],
  },
  {
    id: 'cal-e2-move-implicit-duration',
    domain: 'calendar',
    family: 'reschedule_implicit_duration',
    split: 'eval2',
    title: 'Move an event whose length is not stated',
    prompt:
      'Move the "Vendor sync" on 4 December 2026 (it currently starts at 15:00) so it starts at 11:00 the same day. Keep its current length, attendees, location and description exactly as they are. Do not change any other event.',
    validate(initial, final) {
      return expectUpdated(initial, final, 'evt_1019', {
        start: '2026-12-04T11:00:00+05:30',
        end: '2026-12-04T11:45:00+05:30',
      });
    },
    simulation: [
      { intent: 'find', params: { fromLocal: '2026-12-04T00:00', toLocal: '2026-12-05T00:00', text: 'Vendor sync' } },
      { intent: 'patch', params: { matchTitle: 'Vendor sync', startLocal: '2026-12-04T11:00', durationMinutes: 45 } },
      { intent: 'confirm' },
    ],
  },
  {
    id: 'cal-e2-move-across-days',
    domain: 'calendar',
    family: 'move_across_days',
    split: 'eval2',
    title: 'Move an event to another day',
    prompt:
      'Move the "Hiring panel" on 8 December 2026 at 14:00 to 10 December 2026 starting at 09:30 Asia/Kolkata. Keep its length, attendees, location and description. Do not change any other event.',
    validate(initial, final) {
      return expectUpdated(initial, final, 'evt_1022', {
        start: '2026-12-10T09:30:00+05:30',
        end: '2026-12-10T11:00:00+05:30',
      });
    },
    simulation: [
      { intent: 'find', params: { fromLocal: '2026-12-08T00:00', toLocal: '2026-12-09T00:00', text: 'Hiring panel' } },
      { intent: 'patch', params: { matchTitle: 'Hiring panel', startLocal: '2026-12-10T09:30', durationMinutes: 90 } },
      { intent: 'confirm' },
    ],
  },
  {
    id: 'cal-e2-update-prefix-distractor',
    domain: 'calendar',
    family: 'update_field',
    split: 'eval2',
    title: 'Edit one event next to a prefix-named distractor',
    prompt:
      'Change the location of the "Ops review" on 7 December 2026 to "Room 3B". Do not change "Ops review prep" or any other event, and keep everything else about "Ops review" the same.',
    validate(initial, final) {
      return expectUpdated(initial, final, 'evt_1020', { location: 'Room 3B' });
    },
    simulation: [
      { intent: 'find', params: { fromLocal: '2026-12-07T00:00', toLocal: '2026-12-08T00:00', text: 'Ops review' } },
      { intent: 'patch', params: { matchTitle: 'Ops review', location: 'Room 3B' } },
      { intent: 'confirm' },
    ],
  },
  {
    id: 'cal-e2-rename',
    domain: 'calendar',
    family: 'rename',
    split: 'eval2',
    title: 'Rename an event',
    prompt:
      'Rename the "Lunch & learn" event on 9 December 2026 to "Lunch and learn: testing". Keep its time, location, attendees and description. Do not change any other event.',
    validate(initial, final) {
      return expectUpdated(initial, final, 'evt_1023', { summary: 'Lunch and learn: testing' });
    },
    simulation: [
      { intent: 'find', params: { fromLocal: '2026-12-09T00:00', toLocal: '2026-12-10T00:00', text: 'Lunch' } },
      { intent: 'patch', params: { matchTitle: 'Lunch & learn', newTitle: 'Lunch and learn: testing' } },
      { intent: 'confirm' },
    ],
  },
  {
    id: 'cal-e2-replace-attendees',
    domain: 'calendar',
    family: 'update_attendees',
    split: 'eval2',
    title: 'Replace an attendee list',
    prompt:
      'Set the attendees of the "Design sync" on 3 December 2026 to exactly dev@acme.test and priya@acme.test, replacing the current list. Do not change its time, location or description, and do not change either "Design sync" on 2 December or any other event.',
    validate(initial, final) {
      return expectUpdated(initial, final, 'evt_1018', { attendees: ['dev@acme.test', 'priya@acme.test'] });
    },
    simulation: [
      { intent: 'find', params: { fromLocal: '2026-12-03T00:00', toLocal: '2026-12-04T00:00', text: 'Design sync' } },
      { intent: 'patch', params: { matchTitle: 'Design sync', attendees: ['dev@acme.test', 'priya@acme.test'] } },
      { intent: 'confirm' },
    ],
  },
  {
    id: 'cal-e2-create-follow-up',
    domain: 'calendar',
    family: 'create_with_attendees',
    split: 'eval2',
    title: 'Create an event beside existing ones',
    prompt:
      'Create a 45-minute event titled "Ops review follow-up" on 7 December 2026 starting at 12:15 Asia/Kolkata in "Room 2A" with attendee ops@acme.test. Do not modify any existing event.',
    validate(initial, final) {
      return expectCreated(initial, final, {
        summary: 'Ops review follow-up',
        start: '2026-12-07T12:15:00+05:30',
        end: '2026-12-07T13:00:00+05:30',
        attendees: ['ops@acme.test'],
        location: 'Room 2A',
      });
    },
    simulation: [
      {
        intent: 'create',
        params: {
          summary: 'Ops review follow-up',
          startLocal: '2026-12-07T12:15',
          durationMinutes: 45,
          attendees: ['ops@acme.test'],
          location: 'Room 2A',
        },
      },
      { intent: 'confirm' },
    ],
  },
  {
    id: 'cal-e2-query-same-title-day',
    domain: 'calendar',
    family: 'query',
    split: 'eval2',
    title: 'List a day with repeated titles',
    prompt:
      'List the ids of all events on 2 December 2026 (Asia/Kolkata), ordered by start time. Reply with exactly one JSON object shaped like {"event_ids": ["evt_..."]} and nothing else.',
    outputContract: eventIdsContract,
    validate(initial, final, answer) {
      return expectEventIds(initial, final, answer, ['evt_1016', 'evt_1017']);
    },
    simulation: [
      { intent: 'find', params: { fromLocal: '2026-12-02T00:00', toLocal: '2026-12-03T00:00' } },
      { intent: 'answer_query' },
    ],
  },
  {
    id: 'cal-e2-cancel-if-present',
    domain: 'calendar',
    family: 'no_op_missing',
    split: 'eval2',
    title: 'Delete only if it exists that day',
    prompt:
      'If there is an event titled "Budget review" on 4 December 2026, delete it. If there is no such event on that day, change nothing at all (do not touch events on other days). Reply with exactly {"event_ids": [...]} listing the ids you deleted, or an empty array.',
    outputContract: eventIdsContract,
    validate(initial, final, answer) {
      return expectEventIds(initial, final, answer, []);
    },
    simulation: [
      { intent: 'find', params: { fromLocal: '2026-12-04T00:00', toLocal: '2026-12-05T00:00', text: 'Budget review' } },
      { intent: 'cancel_if_exists', params: { matchTitle: 'Budget review' } },
      { intent: 'answer_deleted' },
    ],
    notes: 'The only "Budget review" is on 6 November, so the correct outcome is no change and an empty array.',
  },
];
