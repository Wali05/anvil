import type { DomainDefinition } from '../core/types.js';
import { calendarDomain } from './calendar/index.js';
import { issueDomain } from './issues/index.js';

export const domainRegistry: Record<string, DomainDefinition> = {
  calendar: calendarDomain,
  issues: issueDomain,
};

export const domainList: DomainDefinition[] = [calendarDomain, issueDomain];

export function getDomain(id: string): DomainDefinition | undefined {
  return domainRegistry[id];
}

export function requireDomain(id: string): DomainDefinition {
  const domain = getDomain(id);
  if (!domain) throw new Error(`Unknown domain "${id}".`);
  return domain;
}