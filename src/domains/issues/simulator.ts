import type { ConditionId, SimulatedAction, SimulationContext, SimulationStep } from '../../core/types.js';

function findArgs(condition: ConditionId, params: Record<string, unknown>): { tool: string; args: Record<string, unknown> } {
  const repo = String(params.repo);
  const status = typeof params.status === 'string' ? params.status : undefined;
  const priority = typeof params.priority === 'string' ? params.priority : undefined;
  const label = typeof params.label === 'string' ? params.label : undefined;
  const assignee = typeof params.assignee === 'string' ? params.assignee : undefined;
  const text = typeof params.text === 'string' ? params.text : undefined;
  if (condition === 'adapted') {
    return {
      tool: 'search_issues',
      args: {
        repo,
        ...(status ? { status } : {}),
        ...(priority ? { priority } : {}),
        ...(label ? { label } : {}),
        ...(assignee ? { assignee } : {}),
        ...(text ? { text } : {}),
        limit: 50,
      },
    };
  }
  const query = [
    status ? `is:${status}` : '',
    priority ? `priority:${priority}` : '',
    label ? `label:${label}` : '',
    assignee ? `assignee:${assignee}` : '',
    text ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return { tool: 'issues_search', args: { repo, q: query, limit: 50 } };
}

function resultNumbers(ctx: SimulationContext): number[] {
  for (let index = ctx.toolCalls.length - 1; index >= 0; index -= 1) {
    const call = ctx.toolCalls[index]!;
    if (!call.result.ok) continue;
    if (call.tool !== 'issues_search' && call.tool !== 'search_issues') continue;
    const content = call.result.content as { items?: Array<{ number?: unknown }> } | undefined;
    const items = content?.items ?? [];
    return items.map((item) => Number(item.number)).filter((value) => Number.isFinite(value));
  }
  return [];
}

function createArgs(condition: ConditionId, params: Record<string, unknown>): { tool: string; args: Record<string, unknown> } {
  const repo = String(params.repo);
  const flat = {
    repo,
    title: String(params.title),
    ...(typeof params.body === 'string' ? { body: params.body } : {}),
    ...(Array.isArray(params.labels) ? { labels: params.labels } : {}),
    ...(typeof params.assignee === 'string' ? { assignee: params.assignee } : {}),
    ...(typeof params.milestone === 'string' ? { milestone: params.milestone } : {}),
    ...(typeof params.priority === 'string' ? { priority: params.priority } : {}),
  };
  if (condition === 'adapted') return { tool: 'create_issue', args: flat };
  return {
    tool: 'issues_create',
    args: {
      repo,
      issue: {
        title: flat.title,
        ...('body' in flat ? { body: flat.body } : {}),
        ...('labels' in flat ? { labels: flat.labels } : {}),
        ...('assignee' in flat ? { assignee: flat.assignee } : {}),
        ...('milestone' in flat ? { milestone: flat.milestone } : {}),
        ...('priority' in flat ? { priority: flat.priority } : {}),
      },
    },
  };
}

function updateArgs(condition: ConditionId, params: Record<string, unknown>): { tool: string; args: Record<string, unknown> } {
  const repo = String(params.repo);
  const number = Number(params.number);
  const changes = (params.changes ?? {}) as Record<string, unknown>;
  if (condition === 'adapted') return { tool: 'update_issue', args: { repo, number, ...changes } };
  return { tool: 'issues_update', args: { repo, number, changes } };
}

export function simulateIssue(step: SimulationStep, ctx: SimulationContext): SimulatedAction {
  const params = step.params ?? {};
  const condition = ctx.condition;
  switch (step.intent) {
    case 'find':
      return findArgs(condition, params);
    case 'create':
      return createArgs(condition, params);
    case 'update':
      return updateArgs(condition, params);
    case 'close': {
      const repo = String(params.repo);
      const number = Number(params.number);
      const resolution = String(params.resolution);
      if (condition === 'adapted') return { tool: 'close_issue', args: { repo, number, resolution } };
      return { tool: 'issues_update', args: { repo, number, changes: { status: 'closed', resolution } } };
    }
    case 'reopen': {
      const repo = String(params.repo);
      const number = Number(params.number);
      if (condition === 'adapted') return { tool: 'reopen_issue', args: { repo, number } };
      return { tool: 'issues_update', args: { repo, number, changes: { status: 'open' } } };
    }
    case 'comment': {
      const repo = String(params.repo);
      const number = Number(params.number);
      const body = String(params.body);
      if (condition === 'adapted') return { tool: 'comment_on_issue', args: { repo, number, body } };
      return { tool: 'issues_comment', args: { repo, number, comment: { body } } };
    }
    case 'answer_query': {
      const numbers = resultNumbers(ctx).sort((a, b) => a - b);
      return { answer: JSON.stringify({ issue_numbers: numbers }) };
    }
    case 'confirm':
      return { answer: 'Done.' };
    default:
      return { answer: `The scripted policy does not implement intent "${step.intent}".` };
  }
}