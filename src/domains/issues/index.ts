import type { DomainDefinition, StateChange } from '../../core/types.js';
import { deepEqual } from '../../core/util.js';
import { issueTools, issueFieldDescriptions } from './tools.js';
import { issueTasks } from './tasks.js';
import { issueEval2Tasks } from './tasks-eval2.js';
import { asIssueState, initialIssueState, type Issue } from './state.js';
import { simulateIssue } from './simulator.js';

function snapshot(issue: Issue): Record<string, unknown> {
  return {
    title: issue.title,
    body: issue.body,
    status: issue.status,
    priority: issue.priority,
    labels: issue.labels,
    assignee: issue.assignee,
    milestone: issue.milestone,
    resolution: issue.resolution,
    comments: issue.comments,
  };
}

function key(issue: Issue): string {
  return `${issue.repo}#${issue.number}`;
}

export const issueDomain: DomainDefinition = {
  id: 'issues',
  name: 'Issue tracker',
  shortName: 'Issues',
  description:
    'A resettable local issue tracker fixture with two repositories, nested create/update envelopes, query syntax, comments and milestones.',
  environment:
    'Connected repositories: acme/rocket and acme/orbit. Known users: alice, bob, carol, dana. Milestones: acme/rocket has v1.4 and v1.5; acme/orbit has beta. Acting user: anvil-agent. Fixture clock: 20 October 2026. Every write hits a disposable in-memory fixture; no GitHub is contacted.',
  // 2026.10.3: added the sealed eval v2 tasks; fixtures, dev and eval v1 tasks unchanged.
  taskSetVersion: 'issues-2026.10.3',
  initialState: initialIssueState,
  tools: issueTools,
  tasks: [...issueTasks, ...issueEval2Tasks],
  diff(initialState, finalState) {
    const initial = asIssueState(initialState);
    const final = asIssueState(finalState);
    const before = new Map(initial.issues.map((issue) => [key(issue), issue]));
    const after = new Map(final.issues.map((issue) => [key(issue), issue]));
    const changes: StateChange[] = [];
    for (const issue of final.issues) {
      if (!before.has(key(issue))) {
        changes.push({
          entity: key(issue),
          kind: 'added',
          fields: Object.entries(snapshot(issue)).map(([field, afterValue]) => ({ field, before: undefined, after: afterValue })),
        });
      }
    }
    for (const issue of initial.issues) {
      const next = after.get(key(issue));
      if (!next) {
        changes.push({
          entity: key(issue),
          kind: 'removed',
          fields: Object.entries(snapshot(issue)).map(([field, beforeValue]) => ({ field, before: beforeValue, after: undefined })),
        });
        continue;
      }
      const oldRecord = snapshot(issue);
      const newRecord = snapshot(next);
      const fields = Object.keys(oldRecord)
        .filter((field) => !deepEqual(oldRecord[field], newRecord[field]))
        .map((field) => ({ field, before: oldRecord[field], after: newRecord[field] }));
      if (fields.length > 0) changes.push({ entity: key(issue), kind: 'changed', fields });
    }
    const unchangedCount = final.issues.filter((issue) => {
      const old = before.get(key(issue));
      return old ? deepEqual(snapshot(old), snapshot(issue)) : false;
    }).length;
    const summary =
      changes.length === 0
        ? `No issue changes; ${unchangedCount} issues unchanged.`
        : `${changes.filter((change) => change.kind === 'added').length} added, ${changes.filter((change) => change.kind === 'removed').length} removed, ${changes.filter((change) => change.kind === 'changed').length} changed.`;
    return { domain: 'issues', changes, unchangedCount, summary };
  },
  describeToolField(toolName, fieldPath) {
    return issueFieldDescriptions[toolName]?.[fieldPath];
  },
  simulate: simulateIssue,
};