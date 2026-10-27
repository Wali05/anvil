import type { AdapterSpec } from '../core/types.js';
import { calendarAdapter } from './calendar/adapter.js';
import { issueAdapter } from './issues/adapter.js';

export const defaultAdapters: Record<string, AdapterSpec> = {
  calendar: calendarAdapter,
  issues: issueAdapter,
};

export function getDefaultAdapter(domain: string): AdapterSpec | undefined {
  return defaultAdapters[domain];
}