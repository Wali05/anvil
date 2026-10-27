import { numberArrayContract } from '../../core/contract.js';
import type { TaskDefinition } from '../../core/types.js';
import { expectIssueCommented, expectIssueNumbers, expectIssueUpdated } from './validators.js';

/**
 * Sealed evaluation set v2 (issues). Written on 27 Oct 2026 BEFORE any model
 * run on these tasks; the issue adapter is unchanged from the 26 Oct pilot.
 * Do not edit after the first live run; add a v3 set instead.
 * New families not present in dev: reassign, query_closed,
 * query_priority_label, comment_on_closed.
 */

const issueNumbersContract = numberArrayContract(
  'issue_numbers',
  '{"issue_numbers": [1, 2]}',
  'Final message must be one JSON object with an issue_numbers array of integers.',
);

export const issueEval2Tasks: TaskDefinition[] = [
  {
    id: 'iss-e2-close-wontfix-similar',
    domain: 'issues',
    family: 'close',
    split: 'eval2',
    title: 'Close the open one of two similar issues',
    prompt:
      'Close acme/rocket issue #61 ("Deploy retry storm") with resolution wontfix. Do not touch #62 ("Old webhook retry storm") or any other issue, and keep #61\'s priority, labels, assignee, milestone and comments unchanged.',
    validate(initial, final) {
      return expectIssueUpdated(initial, final, 'acme/rocket', 61, { status: 'closed', resolution: 'wontfix' });
    },
    simulation: [
      { intent: 'close', params: { repo: 'acme/rocket', number: 61, resolution: 'wontfix' } },
      { intent: 'confirm' },
    ],
  },
  {
    id: 'iss-e2-reassign',
    domain: 'issues',
    family: 'reassign',
    split: 'eval2',
    title: 'Hand an issue to someone else',
    prompt:
      'Reassign acme/orbit issue #22 ("Webhook retries duplicate events") from bob to carol. Keep its status, priority, labels, milestone and comments unchanged, and do not modify any other issue.',
    validate(initial, final) {
      return expectIssueUpdated(initial, final, 'acme/orbit', 22, { assignee: 'carol' });
    },
    simulation: [
      { intent: 'update', params: { repo: 'acme/orbit', number: 22, changes: { assignee: 'carol' } } },
      { intent: 'confirm' },
    ],
  },
  {
    id: 'iss-e2-raise-priority-distractor',
    domain: 'issues',
    family: 'update_fields',
    split: 'eval2',
    title: 'Raise priority next to a near-identical title',
    prompt:
      'Raise acme/rocket issue #63 ("Search latency regression (mobile)") to priority P0. Do not change #42 ("Search latency regression") or any other issue, and keep everything else about #63 unchanged.',
    validate(initial, final) {
      return expectIssueUpdated(initial, final, 'acme/rocket', 63, { priority: 'P0' });
    },
    simulation: [
      { intent: 'update', params: { repo: 'acme/rocket', number: 63, changes: { priority: 'P0' } } },
      { intent: 'confirm' },
    ],
  },
  {
    id: 'iss-e2-query-closed',
    domain: 'issues',
    family: 'query_closed',
    split: 'eval2',
    title: 'List closed issues',
    prompt:
      'List the numbers of all closed issues in acme/rocket, in ascending order. Reply with exactly one JSON object shaped like {"issue_numbers": [1, 2]}.',
    outputContract: issueNumbersContract,
    validate(initial, final, answer) {
      return expectIssueNumbers(initial, final, answer, [60, 62]);
    },
    simulation: [
      { intent: 'find', params: { repo: 'acme/rocket', status: 'closed' } },
      { intent: 'answer_query' },
    ],
  },
  {
    id: 'iss-e2-query-priority-label',
    domain: 'issues',
    family: 'query_priority_label',
    split: 'eval2',
    title: 'Filter by priority and label in the other repo',
    prompt:
      'List the numbers of open P2 issues in acme/orbit that are labeled bug, in ascending order. Reply with exactly one JSON object shaped like {"issue_numbers": [1, 2]}.',
    outputContract: issueNumbersContract,
    validate(initial, final, answer) {
      return expectIssueNumbers(initial, final, answer, [7, 9, 12, 22]);
    },
    simulation: [
      { intent: 'find', params: { repo: 'acme/orbit', status: 'open', priority: 'P2', label: 'bug' } },
      { intent: 'answer_query' },
    ],
  },
  {
    id: 'iss-e2-comment-closed',
    domain: 'issues',
    family: 'comment_on_closed',
    split: 'eval2',
    title: 'Comment on a closed issue without reopening it',
    prompt:
      'Add the comment "Superseded by #61." to the closed acme/rocket issue #62. Do not reopen it or change any of its fields, and do not modify any other issue.',
    validate(initial, final) {
      return expectIssueCommented(initial, final, 'acme/rocket', 62, 'Superseded by #61.');
    },
    simulation: [
      { intent: 'comment', params: { repo: 'acme/rocket', number: 62, body: 'Superseded by #61.' } },
      { intent: 'confirm' },
    ],
  },
];
