import { numberArrayContract } from '../../core/contract.js';
import type { TaskDefinition } from '../../core/types.js';
import { expectIssueCommented, expectIssueCreated, expectIssueNumbers, expectIssueUpdated } from './validators.js';

const issueNumbersContract = numberArrayContract(
  'issue_numbers',
  '{"issue_numbers": [1, 2]}',
  'Final message must be one JSON object with an issue_numbers array of integers.',
);

export const issueTasks: TaskDefinition[] = [
  {
    id: 'iss-dev-create',
    domain: 'issues',
    family: 'create',
    split: 'dev',
    title: 'Create a prioritized, assigned issue',
    prompt:
      'Open an issue in acme/rocket titled "Webhook retry storm" with body "Deploys can retry webhook deliveries three times in a row." Use labels bug and reliability, priority P2, and assignee alice. Do not modify any existing issue.',
    validate(initial, final) {
      return expectIssueCreated(initial, final, 'acme/rocket', {
        title: 'Webhook retry storm',
        body: 'Deploys can retry webhook deliveries three times in a row.',
        labels: ['bug', 'reliability'],
        priority: 'P2',
        assignee: 'alice',
        milestone: null,
      });
    },
    simulation: [
      {
        intent: 'create',
        params: {
          repo: 'acme/rocket',
          title: 'Webhook retry storm',
          body: 'Deploys can retry webhook deliveries three times in a row.',
          labels: ['bug', 'reliability'],
          priority: 'P2',
          assignee: 'alice',
        },
      },
      { intent: 'confirm' },
    ],
  },
  {
    id: 'iss-dev-update-priority',
    domain: 'issues',
    family: 'update_fields',
    split: 'dev',
    title: 'Raise priority and reassign',
    prompt:
      'In acme/rocket issue #42 ("Search latency regression"), set priority to P0 and assignee to carol. Keep its title, body, status, labels, milestone and comments unchanged, and do not modify any other issue.',
    validate(initial, final) {
      return expectIssueUpdated(initial, final, 'acme/rocket', 42, { priority: 'P0', assignee: 'carol' });
    },
    simulation: [
      { intent: 'update', params: { repo: 'acme/rocket', number: 42, changes: { priority: 'P0', assignee: 'carol' } } },
      { intent: 'confirm' },
    ],
  },
  {
    id: 'iss-dev-close',
    domain: 'issues',
    family: 'close',
    split: 'dev',
    title: 'Close with a resolution',
    prompt:
      'Close acme/rocket issue #37 ("Stale cache after rollback") with resolution fixed. Do not change any other field on that issue and do not modify any other issue.',
    validate(initial, final) {
      return expectIssueUpdated(initial, final, 'acme/rocket', 37, { status: 'closed', resolution: 'fixed' });
    },
    simulation: [
      { intent: 'close', params: { repo: 'acme/rocket', number: 37, resolution: 'fixed' } },
      { intent: 'confirm' },
    ],
  },
  {
    id: 'iss-dev-query-label',
    domain: 'issues',
    family: 'query',
    split: 'dev',
    title: 'Query open security issues',
    prompt:
      'List the numbers of all open issues in acme/orbit labeled security, in ascending order. Reply with exactly one JSON object shaped like {"issue_numbers": [1, 2]}.',
    outputContract: issueNumbersContract,
    validate(initial, final, answer) {
      return expectIssueNumbers(initial, final, answer, [8, 10, 21, 23]);
    },
    simulation: [
      { intent: 'find', params: { repo: 'acme/orbit', status: 'open', label: 'security' } },
      { intent: 'answer_query' },
    ],
  },
  {
    id: 'iss-dev-assign-milestone',
    domain: 'issues',
    family: 'assign_milestone',
    split: 'dev',
    title: 'Assign an issue to a milestone',
    prompt:
      'In acme/rocket issue #51 ("Export CSV fails on empty table"), set assignee to bob and milestone to v1.5. Leave title, body, status, priority, labels and comments unchanged, and do not modify any other issue.',
    validate(initial, final) {
      return expectIssueUpdated(initial, final, 'acme/rocket', 51, { assignee: 'bob', milestone: 'v1.5' });
    },
    simulation: [
      { intent: 'update', params: { repo: 'acme/rocket', number: 51, changes: { assignee: 'bob', milestone: 'v1.5' } } },
      { intent: 'confirm' },
    ],
  },
  {
    id: 'iss-dev-comment',
    domain: 'issues',
    family: 'comment',
    split: 'dev',
    title: 'Add one comment',
    prompt:
      'Add a comment to acme/orbit issue #8 ("Webhook signature mismatch") with exactly this body: "I can reproduce this with the sandbox webhook; adding a failing fixture." Do not change any issue fields and do not modify any other issue.',
    validate(initial, final) {
      return expectIssueCommented(initial, final, 'acme/orbit', 8, 'I can reproduce this with the sandbox webhook; adding a failing fixture.');
    },
    simulation: [
      {
        intent: 'comment',
        params: { repo: 'acme/orbit', number: 8, body: 'I can reproduce this with the sandbox webhook; adding a failing fixture.' },
      },
      { intent: 'confirm' },
    ],
  },
  {
    id: 'iss-eval-create',
    domain: 'issues',
    family: 'create',
    split: 'eval',
    title: 'Create a low-priority UI issue',
    prompt:
      'Open an issue in acme/orbit titled "Mobile layout clips filter bar" with body "At 390px the filter bar overflows the viewport." Use labels bug and ui, priority P3, and assignee dana. Do not modify any existing issue.',
    validate(initial, final) {
      return expectIssueCreated(initial, final, 'acme/orbit', {
        title: 'Mobile layout clips filter bar',
        body: 'At 390px the filter bar overflows the viewport.',
        labels: ['bug', 'ui'],
        priority: 'P3',
        assignee: 'dana',
        milestone: null,
      });
    },
    simulation: [
      {
        intent: 'create',
        params: {
          repo: 'acme/orbit',
          title: 'Mobile layout clips filter bar',
          body: 'At 390px the filter bar overflows the viewport.',
          labels: ['bug', 'ui'],
          priority: 'P3',
          assignee: 'dana',
        },
      },
      { intent: 'confirm' },
    ],
  },
  {
    id: 'iss-eval-close-distractor',
    domain: 'issues',
    family: 'close',
    split: 'eval',
    title: 'Close the correct duplicate among similar issues',
    prompt:
      'Close acme/orbit issue #12 ("Duplicate digest emails") with resolution duplicate. Leave its priority, labels, assignee, milestone and comments unchanged, and do not close or edit any other issue.',
    validate(initial, final) {
      return expectIssueUpdated(initial, final, 'acme/orbit', 12, { status: 'closed', resolution: 'duplicate' });
    },
    simulation: [
      { intent: 'close', params: { repo: 'acme/orbit', number: 12, resolution: 'duplicate' } },
      { intent: 'confirm' },
    ],
    notes: 'Issue #9 has a nearly identical title.',
  },
  {
    id: 'iss-eval-query',
    domain: 'issues',
    family: 'query_multi_filter',
    split: 'eval',
    title: 'Combine four filters',
    prompt:
      'List the numbers of open P1 issues in acme/rocket that are labeled bug and assigned to alice, in ascending order. Reply with exactly one JSON object shaped like {"issue_numbers": [1, 2]}.',
    outputContract: issueNumbersContract,
    validate(initial, final, answer) {
      return expectIssueNumbers(initial, final, answer, [37, 61, 63]);
    },
    simulation: [
      {
        intent: 'find',
        params: { repo: 'acme/rocket', status: 'open', priority: 'P1', label: 'bug', assignee: 'alice' },
      },
      { intent: 'answer_query' },
    ],
  },
  {
    id: 'iss-eval-relabel',
    domain: 'issues',
    family: 'update_fields',
    split: 'eval',
    title: 'Replace a label set exactly',
    prompt:
      'Replace the labels on acme/rocket issue #44 ("Flaky integration test") with exactly "tests" and "flaky". Keep title, body, status, priority, assignee, milestone and comments unchanged, and do not modify any other issue.',
    validate(initial, final) {
      return expectIssueUpdated(initial, final, 'acme/rocket', 44, { labels: ['tests', 'flaky'] });
    },
    simulation: [
      { intent: 'update', params: { repo: 'acme/rocket', number: 44, changes: { labels: ['tests', 'flaky'] } } },
      { intent: 'confirm' },
    ],
  },
  {
    id: 'iss-eval-milestone-priority',
    domain: 'issues',
    family: 'assign_milestone',
    split: 'eval',
    title: 'Set milestone and priority together',
    prompt:
      'Set acme/rocket issue #55 ("Cache warmup slow") to milestone v1.4 and priority P1. Leave labels, assignee, status, title, body and comments unchanged, and do not modify any other issue.',
    validate(initial, final) {
      return expectIssueUpdated(initial, final, 'acme/rocket', 55, { milestone: 'v1.4', priority: 'P1' });
    },
    simulation: [
      { intent: 'update', params: { repo: 'acme/rocket', number: 55, changes: { milestone: 'v1.4', priority: 'P1' } } },
      { intent: 'confirm' },
    ],
  },
  {
    id: 'iss-eval-reopen',
    domain: 'issues',
    family: 'reopen',
    split: 'eval',
    title: 'Reopen a closed issue and clear resolution',
    prompt:
      'Reopen acme/orbit issue #19 ("Cron drift") and clear its resolution. Keep title, body, priority, labels, assignee, milestone and comments unchanged, and do not modify any other issue.',
    validate(initial, final) {
      return expectIssueUpdated(initial, final, 'acme/orbit', 19, { status: 'open', resolution: null });
    },
    simulation: [
      { intent: 'reopen', params: { repo: 'acme/orbit', number: 19 } },
      { intent: 'confirm' },
    ],
    notes: 'The fixture documents that reopening clears the resolution when none is supplied.',
  },
];