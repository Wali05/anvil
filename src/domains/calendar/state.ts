export const CALENDAR_ID = 'primary';
export const CALENDAR_TZ = 'Asia/Kolkata';
export const CALENDAR_OFFSET = '+05:30';
export const CALENDAR_NOW = '2026-10-20T09:00:00+05:30';

export interface CalendarEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  location: string | null;
  description: string | null;
  attendees: string[];
  status: 'confirmed' | 'tentative';
  created_at: string;
}

export interface CalendarState {
  calendarId: string;
  timezone: string;
  offset: string;
  now: string;
  events: CalendarEvent[];
}

export function initialCalendarState(): CalendarState {
  return {
    calendarId: CALENDAR_ID,
    timezone: CALENDAR_TZ,
    offset: CALENDAR_OFFSET,
    now: CALENDAR_NOW,
    events: [
      {
        id: 'evt_1001',
        summary: 'Vendor sync',
        start: '2026-11-05T15:00:00+05:30',
        end: '2026-11-05T16:00:00+05:30',
        location: 'Meet',
        description: 'Weekly procurement sync.',
        attendees: ['priya@acme.test'],
        status: 'confirmed',
        created_at: '2026-10-12T10:00:00+05:30',
      },
      {
        id: 'evt_1002',
        summary: 'Design review',
        start: '2026-11-03T14:00:00+05:30',
        end: '2026-11-03T15:00:00+05:30',
        location: 'Studio',
        description: 'Review of the onboarding flow.',
        attendees: ['dev@acme.test'],
        status: 'confirmed',
        created_at: '2026-10-10T09:15:00+05:30',
      },
      {
        id: 'evt_1003',
        summary: 'Budget review',
        start: '2026-11-06T11:00:00+05:30',
        end: '2026-11-06T12:00:00+05:30',
        location: 'Room 2A',
        description: null,
        attendees: ['finance@acme.test'],
        status: 'confirmed',
        created_at: '2026-10-11T16:40:00+05:30',
      },
      {
        id: 'evt_1004',
        summary: 'Board prep',
        start: '2026-11-13T10:00:00+05:30',
        end: '2026-11-13T11:30:00+05:30',
        location: 'Boardroom',
        description: 'Review board deck and final numbers.',
        attendees: ['ceo@acme.test'],
        status: 'confirmed',
        created_at: '2026-10-08T11:00:00+05:30',
      },
      {
        id: 'evt_1005',
        summary: 'Board prep archive',
        start: '2026-11-13T16:00:00+05:30',
        end: '2026-11-13T17:00:00+05:30',
        location: 'Archive',
        description: 'Retrospective on the previous board cycle.',
        attendees: [],
        status: 'confirmed',
        created_at: '2026-09-30T13:00:00+05:30',
      },
      {
        id: 'evt_1006',
        summary: '1:1 with Sam',
        start: '2026-11-09T09:30:00+05:30',
        end: '2026-11-09T10:00:00+05:30',
        location: 'Cafe',
        description: null,
        attendees: ['sam@acme.test'],
        status: 'confirmed',
        created_at: '2026-10-01T08:00:00+05:30',
      },
      {
        id: 'evt_1007',
        summary: 'Hiring sync',
        start: '2026-11-04T11:00:00+05:30',
        end: '2026-11-04T12:00:00+05:30',
        location: 'Room 1C',
        description: 'Pipeline review for the platform role.',
        attendees: ['hr@acme.test'],
        status: 'confirmed',
        created_at: '2026-10-02T15:30:00+05:30',
      },
      {
        id: 'evt_1008',
        summary: 'Focus block',
        start: '2026-11-17T15:00:00+05:30',
        end: '2026-11-17T16:00:00+05:30',
        location: null,
        description: 'No meetings.',
        attendees: [],
        status: 'confirmed',
        created_at: '2026-10-14T07:45:00+05:30',
      },
      {
        id: 'evt_1009',
        summary: 'Audit kickoff planning',
        start: '2026-11-12T09:00:00+05:30',
        end: '2026-11-12T10:00:00+05:30',
        location: 'Room 4B',
        description: 'Planning for the external audit.',
        attendees: ['audit@acme.test'],
        status: 'confirmed',
        created_at: '2026-10-06T12:00:00+05:30',
      },
      {
        id: 'evt_1010',
        summary: 'Customer demo',
        start: '2026-11-09T15:00:00+05:30',
        end: '2026-11-09T16:00:00+05:30',
        location: 'Zoom',
        description: 'Demo of the reporting workflow.',
        attendees: ['customer@example.com'],
        status: 'confirmed',
        created_at: '2026-10-05T18:10:00+05:30',
      },
      {
        id: 'evt_1011',
        summary: 'Retro',
        start: '2026-11-18T16:00:00+05:30',
        end: '2026-11-18T17:00:00+05:30',
        location: 'Room 3B',
        description: 'Sprint 24 retrospective.',
        attendees: ['dev@acme.test'],
        status: 'confirmed',
        created_at: '2026-10-16T10:20:00+05:30',
      },
      {
        id: 'evt_1012',
        summary: 'Partner call',
        start: '2026-11-19T13:00:00+05:30',
        end: '2026-11-19T14:00:00+05:30',
        location: 'Meet',
        description: null,
        attendees: ['partner@example.com'],
        status: 'confirmed',
        created_at: '2026-10-09T14:00:00+05:30',
      },
      {
        id: 'evt_1013',
        summary: 'Quarterly offsite',
        start: '2026-11-20T09:00:00+05:30',
        end: '2026-11-20T17:00:00+05:30',
        location: 'Lakeside',
        description: 'All-day planning offsite.',
        attendees: ['team@acme.test'],
        status: 'confirmed',
        created_at: '2026-09-22T09:00:00+05:30',
      },
      {
        id: 'evt_1014',
        summary: 'Board prep dry run',
        start: '2026-11-13T09:00:00+05:30',
        end: '2026-11-13T09:45:00+05:30',
        location: 'Boardroom',
        description: 'Timing rehearsal for the board deck.',
        attendees: ['ceo@acme.test'],
        status: 'confirmed',
        created_at: '2026-10-15T17:00:00+05:30',
      },
      {
        id: 'evt_1015',
        summary: 'Platform review',
        start: '2026-11-10T14:00:00+05:30',
        end: '2026-11-10T15:00:00+05:30',
        location: 'Studio',
        description: 'Architecture review with the platform group.',
        attendees: ['sam@acme.test', 'dev@acme.test'],
        status: 'confirmed',
        created_at: '2026-10-13T11:30:00+05:30',
      },
      // ---- December 2026 records: used only by the sealed eval v2 tasks (added 27 Oct 2026). ----
      // No dev or eval v1 task reads December, so these do not change any earlier answer.
      {
        id: 'evt_1016',
        summary: 'Design sync',
        start: '2026-12-02T10:00:00+05:30',
        end: '2026-12-02T10:30:00+05:30',
        location: 'Room 1C',
        description: 'Morning design sync.',
        attendees: ['dev@acme.test'],
        status: 'confirmed',
        created_at: '2026-10-18T10:00:00+05:30',
      },
      {
        id: 'evt_1017',
        summary: 'Design sync',
        start: '2026-12-02T16:00:00+05:30',
        end: '2026-12-02T16:30:00+05:30',
        location: 'Studio',
        description: 'Afternoon design sync with platform.',
        attendees: ['dev@acme.test', 'sam@acme.test'],
        status: 'confirmed',
        created_at: '2026-10-18T10:05:00+05:30',
      },
      {
        id: 'evt_1018',
        summary: 'Design sync',
        start: '2026-12-03T10:00:00+05:30',
        end: '2026-12-03T10:30:00+05:30',
        location: 'Room 1C',
        description: 'Morning design sync.',
        attendees: ['dev@acme.test'],
        status: 'confirmed',
        created_at: '2026-10-18T10:10:00+05:30',
      },
      {
        id: 'evt_1019',
        summary: 'Vendor sync',
        start: '2026-12-04T15:00:00+05:30',
        end: '2026-12-04T15:45:00+05:30',
        location: 'Meet',
        description: 'Shortened December procurement sync.',
        attendees: ['priya@acme.test'],
        status: 'confirmed',
        created_at: '2026-10-18T11:00:00+05:30',
      },
      {
        id: 'evt_1020',
        summary: 'Ops review',
        start: '2026-12-07T11:00:00+05:30',
        end: '2026-12-07T12:00:00+05:30',
        location: 'Room 2A',
        description: 'Monthly operations review.',
        attendees: ['ops@acme.test'],
        status: 'confirmed',
        created_at: '2026-10-18T11:30:00+05:30',
      },
      {
        id: 'evt_1021',
        summary: 'Ops review prep',
        start: '2026-12-07T10:00:00+05:30',
        end: '2026-12-07T10:30:00+05:30',
        location: 'Room 2A',
        description: 'Prep for the ops review.',
        attendees: ['ops@acme.test'],
        status: 'confirmed',
        created_at: '2026-10-18T11:35:00+05:30',
      },
      {
        id: 'evt_1022',
        summary: 'Hiring panel',
        start: '2026-12-08T14:00:00+05:30',
        end: '2026-12-08T15:30:00+05:30',
        location: 'Room 4B',
        description: 'Final-round panel.',
        attendees: ['hr@acme.test', 'sam@acme.test'],
        status: 'confirmed',
        created_at: '2026-10-18T12:00:00+05:30',
      },
      {
        id: 'evt_1023',
        summary: 'Lunch & learn',
        start: '2026-12-09T13:00:00+05:30',
        end: '2026-12-09T14:00:00+05:30',
        location: 'Cafe',
        description: 'Open session.',
        attendees: [],
        status: 'confirmed',
        created_at: '2026-10-18T12:30:00+05:30',
      },
    ],
  };
}

export function asCalendarState(state: unknown): CalendarState {
  return state as CalendarState;
}

export function nextEventId(state: CalendarState): string {
  let max = 1000;
  for (const event of state.events) {
    const match = /^evt_(\d+)$/.exec(event.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `evt_${max + 1}`;
}

export function findEvent(state: CalendarState, id: string): CalendarEvent | undefined {
  return state.events.find((event) => event.id === id);
}

export function isoAt(date: string, time: string): string {
  return `${date}T${time}:00+05:30`;
}