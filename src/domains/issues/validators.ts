import type { CheckResult } from '../../core/types.js';
import { deepEqual } from '../../core/util.js';
import { parseNumberContract } from '../../core/contract.js';
import { asIssueState, type Issue, type IssuePriority, type Resolution } from './state.js';

export interface ExpectedIssue {
  title: string;
  body?: string;
  labels?: string[];
  assignee?: string | null;
  milestone?: string | null;
  priority?: IssuePriority;
  status?: 'open' | 'closed';
  resolution?: Resolution;
}

type IssueField = 'title' | 'body' | 'status' | 'priority' | 'labels' | 'assignee' | 'milestone' | 'resolution' | 'comments';
type PartialExpected = Partial<Pick<Issue, IssueField>>;

const ISSUE_FIELDS: IssueField[] = ['title', 'body', 'status', 'priority', 'labels', 'assignee', 'milestone', 'resolution', 'comments'];

function key(issue: Issue): string {
  return `${issue.repo}#${issue.number}`;
}

function sorted(values: string[] | undefined): string[] {
  return [...(values ?? [])].sort();
}

function snapshot(issue: Issue): Record<string, unknown> {
  return {
    title: issue.title,
    body: issue.body,
    status: issue.status,
    priority: issue.priority,
    labels: sorted(issue.labels),
    assignee: issue.assignee,
    milestone: issue.milestone,
    resolution: issue.resolution,
    comments: issue.comments,
    created_at: issue.created_at,
  };
}

function fullSnapshot(issue: Issue): Record<string, unknown> {
  return { ...snapshot(issue), updated_at: issue.updated_at };
}

function fieldMatches(issue: Issue, field: IssueField, expected: unknown): boolean {
  if (field === 'labels') return sorted(issue.labels).join(',') === sorted(expected as string[]).join(',');
  if (field === 'comments') return deepEqual(issue.comments, expected);
  return deepEqual(issue[field], expected);
}

function split(initialState: unknown, finalState: unknown) {
  const initial = asIssueState(initialState);
  const final = asIssueState(finalState);
  const before = new Map(initial.issues.map((issue) => [key(issue), issue]));
  const after = new Map(final.issues.map((issue) => [key(issue), issue]));
  const added = final.issues.filter((issue) => !before.has(key(issue)));
  const removed = initial.issues.filter((issue) => !after.has(key(issue)));
  const changed = initial.issues
    .filter((issue) => after.has(key(issue)) && !deepEqual(fullSnapshot(issue), fullSnapshot(after.get(key(issue))!)))
    .map((issue) => ({ before: issue, after: after.get(key(issue))! }));
  return { initial, final, before, after, added, removed, changed };
}

export function expectIssueCreated(
  initialState: unknown,
  finalState: unknown,
  repo: string,
  expected: ExpectedIssue,
): CheckResult[] {
  const { initial, final, added, removed, changed } = split(initialState, finalState);
  const checks: CheckResult[] = [];
  checks.push({
    id: 'created-one-issue',
    label: 'Exactly one issue was created',
    kind: 'intent',
    ok: added.length === 1 && removed.length === 0,
    detail: `${added.length} added, ${removed.length} removed; expected exactly one added issue and no removals.`,
  });
  const created = added[0];
  const expectedRecord: PartialExpected = {
    title: expected.title,
    body: expected.body ?? '',
    status: expected.status ?? 'open',
    priority: expected.priority ?? 'P2',
    labels: sorted(expected.labels),
    assignee: expected.assignee ?? null,
    milestone: expected.milestone ?? null,
    resolution: expected.resolution ?? null,
    comments: [],
  };
  const mismatches: string[] = [];
  if (created) {
    for (const field of ISSUE_FIELDS) {
      if (!fieldMatches(created, field, expectedRecord[field])) {
        mismatches.push(`${field}: expected ${JSON.stringify(expectedRecord[field])}, got ${JSON.stringify(created[field])}`);
      }
    }
    if (created.repo !== repo) mismatches.push(`repo: expected ${repo}, got ${created.repo}`);
  }
  checks.push({
    id: 'created-fields',
    label: 'The created issue matches the requested fields',
    kind: 'intent',
    ok: Boolean(created) && mismatches.length === 0,
    detail: created ? (mismatches.length === 0 ? `#${created.number} ${created.title} matches.` : mismatches.join('; ')) : 'No created issue to inspect.',
  });
  checks.push({
    id: 'existing-issues-preserved',
    label: 'Every existing issue is unchanged',
    kind: 'preservation',
    ok: changed.length === 0,
    detail: changed.length === 0 ? `All ${initial.issues.length} existing issues are unchanged.` : `Changed: ${changed.map((entry) => key(entry.before)).join(', ')}.`,
  });
  checks.push({
    id: 'issue-count',
    label: 'Exactly one issue was added',
    kind: 'hygiene',
    ok: final.issues.length === initial.issues.length + 1 && added.length === 1,
    detail: `Initial ${initial.issues.length}, final ${final.issues.length}; expected one added issue.`,
  });
  return checks;
}

export function expectIssueUpdated(
  initialState: unknown,
  finalState: unknown,
  repo: string,
  number: number,
  expected: PartialExpected,
): CheckResult[] {
  const { added, removed, changed, before } = split(initialState, finalState);
  const original = before.get(`${repo}#${number}`);
  const after = changed.find((entry) => key(entry.before) === `${repo}#${number}`)?.after;
  const checks: CheckResult[] = [];
  checks.push({
    id: 'target-issue-present',
    label: `Issue ${repo}#${number} still exists`,
    kind: 'intent',
    ok: Boolean(original),
    detail: original ? `Found #${number} in ${repo}.` : `The fixture did not contain ${repo}#${number}.`,
  });
  const mismatches: string[] = [];
  const target = after ?? original;
  if (original && target) {
    for (const [field, value] of Object.entries(expected) as Array<[IssueField, unknown]>) {
      if (!fieldMatches(target, field, value)) {
        mismatches.push(`${field}: expected ${JSON.stringify(value)}, got ${JSON.stringify(target[field])}`);
      }
    }
    const allowed = new Set(Object.keys(expected));
    for (const field of ISSUE_FIELDS) {
      if (allowed.has(field)) continue;
      if (!fieldMatches(target, field, (original as unknown as Record<string, unknown>)[field])) {
        mismatches.push(`${field} changed unexpectedly`);
      }
    }
  }
  checks.push({
    id: 'target-fields',
    label: 'Target fields match the request and nothing else changed',
    kind: 'intent',
    ok: Boolean(original) && mismatches.length === 0,
    detail: mismatches.length === 0 ? 'Target issue fields are exactly as requested.' : mismatches.join('; '),
  });
  checks.push({
    id: 'no-additions',
    label: 'No issues were added',
    kind: 'hygiene',
    ok: added.length === 0,
    detail: added.length === 0 ? 'No additions.' : `Added: ${added.map(key).join(', ')}.`,
  });
  checks.push({
    id: 'no-removals',
    label: 'No issues were removed',
    kind: 'preservation',
    ok: removed.length === 0,
    detail: removed.length === 0 ? 'No removals.' : `Removed: ${removed.map(key).join(', ')}.`,
  });
  const unrelated = changed.filter((entry) => key(entry.before) !== `${repo}#${number}`);
  checks.push({
    id: 'unrelated-unchanged',
    label: 'Unrelated issues are unchanged',
    kind: 'preservation',
    ok: unrelated.length === 0,
    detail: unrelated.length === 0 ? 'All other issues match the fixture.' : `Unexpected changes: ${unrelated.map((entry) => key(entry.before)).join(', ')}.`,
  });
  return checks;
}

export function expectIssueCommented(
  initialState: unknown,
  finalState: unknown,
  repo: string,
  number: number,
  body: string,
  author = 'anvil-agent',
): CheckResult[] {
  const { added, removed, changed, before } = split(initialState, finalState);
  const original = before.get(`${repo}#${number}`);
  const after = changed.find((entry) => key(entry.before) === `${repo}#${number}`)?.after;
  const checks: CheckResult[] = [];
  const comments = after?.comments ?? original?.comments ?? [];
  const appended = comments.at(-1);
  const expectedCount = (original?.comments.length ?? 0) + 1;
  checks.push({
    id: 'comment-appended',
    label: 'Exactly one matching comment was appended',
    kind: 'intent',
    ok: Boolean(after) && comments.length === expectedCount && appended?.body === body && appended?.author === author,
    detail: after
      ? `${comments.length} comments (expected ${expectedCount}); last: ${appended?.author ?? 'none'}: ${appended?.body ?? 'none'}.`
      : 'The target issue was not modified.',
  });
  const fieldsPreserved = Boolean(original && after) &&
    ['title', 'body', 'status', 'priority', 'labels', 'assignee', 'milestone', 'resolution'].every((field) =>
      fieldMatches(after!, field as IssueField, (original as unknown as Record<string, unknown>)[field]),
    ) &&
    deepEqual(after!.comments.slice(0, -1), original!.comments);
  checks.push({
    id: 'comment-only-change',
    label: 'Only a comment was added; every issue field is preserved',
    kind: 'preservation',
    ok: fieldsPreserved,
    detail: fieldsPreserved ? 'The comment is the only change on the issue.' : 'Another issue field or an earlier comment changed.',
  });
  checks.push({
    id: 'no-issue-churn',
    label: 'No other issue was added, removed or changed',
    kind: 'preservation',
    ok: added.length === 0 && removed.length === 0 && changed.every((entry) => key(entry.before) === `${repo}#${number}`),
    detail: `Added ${added.length}, removed ${removed.length}, changed ${changed.map((entry) => key(entry.before)).join(', ') || 'none'}.`,
  });
  return checks;
}

export function expectIssuesUnchanged(initialState: unknown, finalState: unknown): CheckResult[] {
  const { initial, final } = split(initialState, finalState);
  const same = deepEqual(initial, final);
  return [
    {
      id: 'state-unchanged',
      label: 'The issue tracker state is unchanged',
      kind: 'preservation',
      ok: same,
      detail: same ? `All ${initial.issues.length} issues are identical to the fixture.` : 'The final issue state differs from the fixture.',
    },
  ];
}

export function expectIssueNumbers(
  initialState: unknown,
  finalState: unknown,
  finalAnswer: string,
  expectedNumbers: number[],
): CheckResult[] {
  const checks = expectIssuesUnchanged(initialState, finalState);
  const parsed = parseNumberContract(finalAnswer ?? '', 'issue_numbers');
  const actual = parsed.ok ? parsed.values : [];
  const ok = parsed.ok && actual.length === expectedNumbers.length && actual.every((value, index) => value === expectedNumbers[index]);
  checks.push({
    id: 'issue-numbers-contract',
    label: 'Final answer satisfies the issue_numbers contract',
    kind: 'contract',
    ok,
    detail: parsed.ok
      ? `Expected [${expectedNumbers.join(', ')}], got [${actual.join(', ')}].`
      : `Could not parse the contract: ${parsed.reason}. Expected [${expectedNumbers.join(', ')}].`,
  });
  return checks;
}

export function inspectIssueChanges(initialState: unknown, finalState: unknown) {
  return split(initialState, finalState);
}