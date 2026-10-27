import type { DomainTool, JsonSchema, ToolExecResult } from '../../core/types.js';
import {
  asIssueState,
  nextIssueNumber,
  requireRepo,
  validateAssignment,
  validateMilestone,
  type Issue,
  type IssuePriority,
  type IssueState,
  type IssueStatus,
  type Resolution,
} from './state.js';

const priorities: IssuePriority[] = ['P0', 'P1', 'P2', 'P3'];
const resolutions: string[] = ['fixed', 'wontfix', 'duplicate'];

function wireIssue(issue: Issue) {
  return {
    repo: issue.repo,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.status,
    priority: issue.priority,
    labels: issue.labels.map((name) => ({ name })),
    assignee: issue.assignee ? { login: issue.assignee } : null,
    milestone: issue.milestone ? { title: issue.milestone } : null,
    resolution: issue.resolution,
    comments: issue.comments.map((comment) => ({ ...comment })),
    created_at: issue.created_at,
    updated_at: issue.updated_at,
  };
}

interface ParsedQuery {
  status?: IssueStatus;
  labels: string[];
  assignees: string[];
  priorities: IssuePriority[];
  text: string[];
}

function parseQuery(raw: string): { ok: true; query: ParsedQuery } | { ok: false; message: string } {
  const query: ParsedQuery = { labels: [], assignees: [], priorities: [], text: [] };
  for (const token of raw.trim().split(/\s+/).filter(Boolean)) {
    if (token.startsWith('is:')) {
      const value = token.slice(3);
      if (value !== 'open' && value !== 'closed') return { ok: false, message: `Unsupported state "${value}".` };
      if (query.status && query.status !== value) return { ok: false, message: 'Conflicting is: state filters.' };
      query.status = value;
    } else if (token.startsWith('label:')) {
      const value = token.slice(6);
      if (!value) return { ok: false, message: 'label: needs a value.' };
      query.labels.push(value);
    } else if (token.startsWith('assignee:')) {
      const value = token.slice(9);
      if (!value) return { ok: false, message: 'assignee: needs a value.' };
      query.assignees.push(value);
    } else if (token.startsWith('priority:')) {
      const value = token.slice(9).toUpperCase() as IssuePriority;
      if (!priorities.includes(value)) return { ok: false, message: 'priority: must be P0, P1, P2 or P3.' };
      query.priorities.push(value);
    } else {
      query.text.push(token);
    }
  }
  return { ok: true, query };
}

const searchSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['repo'],
  properties: {
    repo: { type: 'string', description: 'Repository owner/name.' },
    q: { type: 'string', description: 'Query string.' },
    limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Page size.' },
  },
};

const createSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['repo', 'issue'],
  properties: {
    repo: { type: 'string', description: 'Repository.' },
    issue: {
      type: 'object',
      additionalProperties: false,
      required: ['title'],
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 200 },
        body: { type: 'string', maxLength: 5000 },
        labels: { type: 'array', maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 40 } },
        assignee: { type: 'string', description: 'Username.' },
        milestone: { type: 'string', description: 'Milestone title.' },
        priority: { type: 'string', enum: priorities, description: 'Priority.' },
      },
    },
  },
};

const updateSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['repo', 'number', 'changes'],
  properties: {
    repo: { type: 'string' },
    number: { type: 'integer', minimum: 1 },
    changes: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: ['open', 'closed'] },
        priority: { type: 'string', enum: priorities },
        labels: { type: 'array', maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 40 } },
        assignee: { type: 'string' },
        milestone: { type: 'string' },
        resolution: { type: 'string', enum: resolutions },
      },
    },
  },
};

const commentSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['repo', 'number', 'comment'],
  properties: {
    repo: { type: 'string' },
    number: { type: 'integer', minimum: 1 },
    comment: {
      type: 'object',
      additionalProperties: false,
      required: ['body'],
      properties: {
        body: { type: 'string', minLength: 1, maxLength: 5000 },
      },
    },
  },
};

function repoError(state: IssueState, repo: string): ToolExecResult | null {
  const message = requireRepo(state, repo);
  if (!message) return null;
  return { ok: false, error: { code: 'repo_not_found', message } };
}

export const issueTools: DomainTool[] = [
  {
    name: 'issues_search',
    description: 'Search issues in one repository using a query string.',
    outputDescription: 'A search envelope with items shaped like GitHub issues (labels and assignee are nested objects).',
    permissions: [{ scope: 'issues:read', write: false }],
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: searchSchema,
    execute(state, args) {
      const issues = asIssueState(state);
      const repo = String(args.repo);
      const badRepo = repoError(issues, repo);
      if (badRepo) return badRepo;
      const parsed = parseQuery(typeof args.q === 'string' ? args.q : '');
      if (!parsed.ok) return { ok: false, error: { code: 'invalid_query', message: parsed.message } };
      const { status, labels, assignees, priorities, text } = parsed.query;
      const limit = typeof args.limit === 'number' ? args.limit : 20;
      const matches = issues.issues
        .filter((entry) => entry.repo === repo)
        .filter((entry) => (status ? entry.status === status : true))
        .filter((entry) => labels.every((label) => entry.labels.includes(label)))
        .filter((entry) => assignees.every((assignee) => entry.assignee === assignee))
        .filter((entry) => priorities.every((priority) => entry.priority === priority))
        .filter((entry) => {
          if (text.length === 0) return true;
          const haystack = `${entry.title} ${entry.body} ${entry.labels.join(' ')}`.toLowerCase();
          return text.every((token) => haystack.includes(token.toLowerCase()));
        })
        .sort((a, b) => a.number - b.number);
      return {
        ok: true,
        content: {
          total_count: matches.length,
          incomplete_results: false,
          items: matches.slice(0, limit).map(wireIssue),
        },
      };
    },
  },
  {
    name: 'issues_create',
    description: 'Create an issue from a repository envelope with a nested issue object.',
    outputDescription: 'The created issue.',
    permissions: [{ scope: 'issues:write', write: true }],
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: createSchema,
    execute(state, args, ctx) {
      const issues = asIssueState(state);
      const repo = String(args.repo);
      const badRepo = repoError(issues, repo);
      if (badRepo) return badRepo;
      const input = args.issue as {
        title: string;
        body?: string;
        labels?: string[];
        assignee?: string;
        milestone?: string;
        priority?: IssuePriority;
      };
      const assigneeError = validateAssignment(issues, repo, input.assignee);
      if (assigneeError) return { ok: false, error: { code: 'invalid_assignee', message: assigneeError } };
      const milestoneError = validateMilestone(issues, repo, input.milestone);
      if (milestoneError) return { ok: false, error: { code: 'invalid_milestone', message: milestoneError } };
      const created: Issue = {
        repo,
        number: nextIssueNumber(issues),
        title: input.title,
        body: input.body ?? '',
        status: 'open',
        priority: input.priority ?? 'P2',
        labels: input.labels ? [...input.labels] : [],
        assignee: input.assignee ?? null,
        milestone: input.milestone ?? null,
        resolution: null,
        comments: [],
        created_at: ctx.now,
        updated_at: ctx.now,
      };
      issues.issues.push(created);
      return { ok: true, content: wireIssue(created) };
    },
  },
  {
    name: 'issues_update',
    description: 'Apply a nested changes object to one issue number.',
    outputDescription: 'The updated issue.',
    permissions: [{ scope: 'issues:write', write: true }],
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: updateSchema,
    execute(state, args) {
      const issues = asIssueState(state);
      const repo = String(args.repo);
      const badRepo = repoError(issues, repo);
      if (badRepo) return badRepo;
      const number = Number(args.number);
      const issue = issues.issues.find((entry) => entry.repo === repo && entry.number === number);
      if (!issue) return { ok: false, error: { code: 'issue_not_found', message: `No issue #${number} in ${repo}.` } };
      const changes = args.changes as {
        status?: IssueStatus;
        priority?: IssuePriority;
        labels?: string[];
        assignee?: string;
        milestone?: string;
        resolution?: Exclude<Resolution, null>;
      };
      if (Object.keys(changes).length === 0) {
        return { ok: false, error: { code: 'empty_update', message: 'changes must contain at least one field.' } };
      }
      const assigneeError = validateAssignment(issues, repo, changes.assignee);
      if (assigneeError) return { ok: false, error: { code: 'invalid_assignee', message: assigneeError } };
      const milestoneError = validateMilestone(issues, repo, changes.milestone);
      if (milestoneError) return { ok: false, error: { code: 'invalid_milestone', message: milestoneError } };
      if (changes.priority !== undefined) issue.priority = changes.priority;
      if (changes.labels !== undefined) issue.labels = [...changes.labels];
      if (changes.assignee !== undefined) issue.assignee = changes.assignee;
      if (changes.milestone !== undefined) issue.milestone = changes.milestone;
      if (changes.status !== undefined) {
        issue.status = changes.status;
        if (changes.status === 'open' && changes.resolution === undefined) issue.resolution = null;
      }
      if (changes.resolution !== undefined) issue.resolution = changes.resolution;
      issue.updated_at = issues.now;
      return { ok: true, content: wireIssue(issue) };
    },
  },
  {
    name: 'issues_comment',
    description: 'Append a comment envelope to one issue.',
    outputDescription: 'The created comment.',
    permissions: [{ scope: 'issues:write', write: true }],
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: commentSchema,
    execute(state, args, ctx) {
      const issues = asIssueState(state);
      const repo = String(args.repo);
      const badRepo = repoError(issues, repo);
      if (badRepo) return badRepo;
      const number = Number(args.number);
      const issue = issues.issues.find((entry) => entry.repo === repo && entry.number === number);
      if (!issue) return { ok: false, error: { code: 'issue_not_found', message: `No issue #${number} in ${repo}.` } };
      const comment = args.comment as { body: string };
      const created = { author: issues.actingUser, body: comment.body, created_at: ctx.now };
      issue.comments.push(created);
      issue.updated_at = ctx.now;
      return { ok: true, content: { ...created, number, repo } };
    },
  },
];

export const issueFieldDescriptions: Record<string, Record<string, string>> = {
  issues_search: {
    '': 'Search one connected repository. The query accepts at most one of is:open / is:closed, plus label:NAME, assignee:USER, priority:P0-P3 and free-text tokens. Example: "is:open label:security assignee:alice".',
    repo: 'Use "acme/rocket" or "acme/orbit".',
    q: 'Space-separated filters: is:open, is:closed, label:bug, assignee:alice, priority:P1, and free text.',
    limit: 'Maximum issues to return; defaults to 20.',
  },
  issues_create: {
    '': 'Create an issue. The repository id and a nested issue resource are required. Priority is optional and defaults to P2; assignee must be alice, bob, carol or dana; milestone must exist in that repository.',
    'issue.title': 'Issue title.',
    'issue.body': 'Issue description.',
    'issue.labels': 'Array of label strings.',
    'issue.assignee': 'Username, not an object.',
    'issue.milestone': 'Milestone title, e.g. v1.5 for acme/rocket or beta for acme/orbit.',
    'issue.priority': 'P0, P1, P2 or P3. Defaults to P2.',
  },
  issues_update: {
    '': 'Update one issue. Put every change inside the nested changes object. Set status to "closed" with resolution "fixed", "wontfix" or "duplicate" to close; setting status back to "open" clears the resolution.',
    repo: 'Use "acme/rocket" or "acme/orbit".',
    'changes.status': 'open or closed. Setting open clears resolution when resolution is omitted.',
    'changes.priority': 'P0-P3.',
    'changes.labels': 'Replaces the full label list when present.',
    'changes.assignee': 'Username; replaces the assignee.',
    'changes.milestone': 'Milestone title; replaces the milestone.',
    'changes.resolution': 'fixed, wontfix or duplicate. Only meaningful when closing.',
  },
  issues_comment: {
    '': 'Append a comment to one issue. The comment object only accepts a body; the acting user is recorded automatically.',
    repo: 'Use "acme/rocket" or "acme/orbit".',
    'comment.body': 'Exact comment text.',
  },
};