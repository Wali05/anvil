import type { AdapterSpec } from '../../core/types.js';
import { makeAdapterSpec } from '../../core/adapter.js';

export const issueAdapter: AdapterSpec = makeAdapterSpec({
  domain: 'issues',
  version: '1.0.0',
  description:
    'Issue tracker adapter: flat issue fields, structured filters compiled into the original query language, and explicit close/reopen tools.',
  tools: [
    {
      name: 'search_issues',
      description:
        'Search a repository with structured filters instead of a query language. Returns the original search envelope; issue numbers are in items[].number.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['repo'],
        properties: {
          repo: { type: 'string', enum: ['acme/rocket', 'acme/orbit'], description: 'Repository.' },
          status: { type: 'string', enum: ['open', 'closed'], description: 'Issue state filter.' },
          priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'], description: 'Priority filter.' },
          label: { type: 'string', maxLength: 40, description: 'Exact label filter.' },
          assignee: { type: 'string', maxLength: 40, description: 'Exact assignee username filter.' },
          text: { type: 'string', maxLength: 200, description: 'Free-text filter matched against title, body and labels.' },
          limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum issues to return.' },
        },
      },
      target: 'issues_search',
      arguments: [
        { to: 'repo', from: 'repo', required: true },
        {
          to: 'q',
          transform: {
            kind: 'issueQuery',
            parts: [
              { input: 'status', prefix: 'is:', valueMap: { open: 'open', closed: 'closed' } },
              { input: 'priority', prefix: 'priority:' },
              { input: 'label', prefix: 'label:' },
              { input: 'assignee', prefix: 'assignee:' },
              { input: 'text' },
            ],
          },
          required: true,
        },
        { to: 'limit', from: 'limit' },
      ],
      notes: 'No output remapping: the original search envelope is returned unchanged.',
    },
    {
      name: 'create_issue',
      description:
        'Create an issue with flat fields. The adapter nests them into the original issue resource and supplies the acting repository.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['repo', 'title'],
        properties: {
          repo: { type: 'string', enum: ['acme/rocket', 'acme/orbit'], description: 'Repository.' },
          title: { type: 'string', minLength: 1, maxLength: 200 },
          body: { type: 'string', maxLength: 5000 },
          labels: { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 40 } },
          assignee: { type: 'string', enum: ['alice', 'bob', 'carol', 'dana'] },
          milestone: { type: 'string', maxLength: 40 },
          priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
        },
      },
      target: 'issues_create',
      arguments: [
        { to: 'repo', from: 'repo', required: true },
        { to: 'issue.title', from: 'title', required: true },
        { to: 'issue.body', from: 'body' },
        { to: 'issue.labels', from: 'labels' },
        { to: 'issue.assignee', from: 'assignee' },
        { to: 'issue.milestone', from: 'milestone' },
        { to: 'issue.priority', from: 'priority' },
      ],
    },
    {
      name: 'update_issue',
      description:
        'Update flat issue fields by number. The adapter nests them into the original changes object; omitted fields stay untouched.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['repo', 'number'],
        properties: {
          repo: { type: 'string', enum: ['acme/rocket', 'acme/orbit'] },
          number: { type: 'integer', minimum: 1 },
          priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
          labels: { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 40 } },
          assignee: { type: 'string', enum: ['alice', 'bob', 'carol', 'dana'] },
          milestone: { type: 'string', maxLength: 40 },
        },
      },
      target: 'issues_update',
      arguments: [
        { to: 'repo', from: 'repo', required: true },
        { to: 'number', from: 'number', required: true },
        { to: 'changes.priority', from: 'priority' },
        { to: 'changes.labels', from: 'labels' },
        { to: 'changes.assignee', from: 'assignee' },
        { to: 'changes.milestone', from: 'milestone' },
      ],
    },
    {
      name: 'comment_on_issue',
      description: 'Add a comment with a plain body string. The adapter nests the comment envelope.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['repo', 'number', 'body'],
        properties: {
          repo: { type: 'string', enum: ['acme/rocket', 'acme/orbit'] },
          number: { type: 'integer', minimum: 1 },
          body: { type: 'string', minLength: 1, maxLength: 5000 },
        },
      },
      target: 'issues_comment',
      arguments: [
        { to: 'repo', from: 'repo', required: true },
        { to: 'number', from: 'number', required: true },
        { to: 'comment.body', from: 'body', required: true },
      ],
    },
    {
      name: 'close_issue',
      description: 'Close an issue with an explicit resolution. Maps to a single original update call.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['repo', 'number', 'resolution'],
        properties: {
          repo: { type: 'string', enum: ['acme/rocket', 'acme/orbit'] },
          number: { type: 'integer', minimum: 1 },
          resolution: { type: 'string', enum: ['fixed', 'wontfix', 'duplicate'] },
        },
      },
      target: 'issues_update',
      arguments: [
        { to: 'repo', from: 'repo', required: true },
        { to: 'number', from: 'number', required: true },
        { to: 'changes.status', const: 'closed' },
        { to: 'changes.resolution', from: 'resolution', required: true },
      ],
    },
    {
      name: 'reopen_issue',
      description: 'Reopen an issue. The original executor clears the resolution when status becomes open.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['repo', 'number'],
        properties: {
          repo: { type: 'string', enum: ['acme/rocket', 'acme/orbit'] },
          number: { type: 'integer', minimum: 1 },
        },
      },
      target: 'issues_update',
      arguments: [
        { to: 'repo', from: 'repo', required: true },
        { to: 'number', from: 'number', required: true },
        { to: 'changes.status', const: 'open' },
      ],
    },
  ],
});