import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CompletionRequest, CompletionResponse, ModelTransport } from '../src/core/model.js';
import { matchesSubset, evaluateTraceCheck } from '../src/eval/checks.js';
import { parseTasksFile, loadTasksFile } from '../src/eval/tasks.js';
import { conditionConfigs, lintTasks, modelToolNames, runEval } from '../src/eval/runner.js';
import { formatEvalRun } from '../src/eval/format.js';
import { loadAdapterFile, resolveProxyConfig, type ResolvedProxyConfig } from '../src/proxy/config.js';
import { startProxyRuntime } from '../src/proxy/server.js';
import { sampleAdapterPath, sampleTasksPath, sampleUpstreamSpec } from '../src/proxy/sample.js';

const tsxAvailable = existsSync(resolve('node_modules/tsx'));

async function sampleConfig(withAdapter = true): Promise<ResolvedProxyConfig> {
  const config = await resolveProxyConfig({ upstream: { command: 'placeholder' } }, '.', {});
  config.upstream = sampleUpstreamSpec();
  if (withAdapter) config.adapter = await loadAdapterFile(sampleAdapterPath());
  return config;
}

function reply(partial: Partial<CompletionResponse>): CompletionResponse {
  return { content: '', toolCalls: [], finishReason: 'stop', usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, providerReportedCostUsd: null }, reportedModel: 'scripted', responseId: null, warnings: [], ...partial };
}

const call = (name: string, args: unknown): CompletionResponse =>
  reply({ toolCalls: [{ id: `c_${name}`, name, argumentsRaw: JSON.stringify(args) }], finishReason: 'tool_calls' });

/**
 * A scripted "model": competent with the adapted tools; with the raw tools it lists
 * correctly but guesses the ticket id when cancelling (the failure adapters exist for).
 */
class ScriptedModel implements ModelTransport {
  readonly kind = 'openai-compatible' as const;
  readonly requests: CompletionRequest[] = [];
  async listModels() {
    return ['scripted'];
  }
  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push({ ...request, messages: [...request.messages] });
    const adapted = request.tools.some((tool) => tool.name === 'cancel_ticket');
    const task = request.messages.find((message) => message.role === 'user')!.content ?? '';
    const turn = request.messages.filter((message) => message.role === 'assistant').length;
    if (task.includes('Unique billing glitch')) {
      if (turn === 0) return adapted ? call('cancel_ticket', { workspace: 'acme', title: 'Unique billing glitch' }) : call('desk_cancel_ticket', { workspace: 'acme', ticket_id: 'T-1001' });
      return reply({ content: 'Canceled.' });
    }
    if (task.includes('How many open tickets')) {
      if (turn === 0) return adapted ? call('list_tickets', { workspace: 'acme', status: 'open' }) : call('desk_list_tickets', { query: { workspace: 'acme', status: 'O' } });
      const last = request.messages[request.messages.length - 1]!.content ?? '';
      const count = (JSON.parse(last) as { items: unknown[] }).items.length;
      return reply({ content: `{"open": ${count}}` });
    }
    return reply({ content: 'I cannot help.' });
  }
}

describe('eval checks', () => {
  it('matches deep subsets, ordered and unordered', () => {
    expect(matchesSubset({ a: 1, b: { c: 2, d: 3 } }, { b: { c: 2 } })).toBe(true);
    expect(matchesSubset({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(matchesSubset({ a: [1, 2] }, { a: [2, 1] }, true)).toBe(true);
    expect(matchesSubset({ a: [1, 1] }, { a: [1, 2] }, true)).toBe(false);
    expect(matchesSubset('x', 'y')).toBe(false);
  });

  it('grades calls by the original call the adapter compiled, and answers by JSON', () => {
    const calls = [
      { tool: 'desk_list_tickets', input: { query: { workspace: 'acme' } }, ok: true, role: 'lookup' as const },
      { tool: 'desk_cancel_ticket', input: { workspace: 'acme', ticket_id: 'T-1003' }, ok: true, role: 'target' as const },
    ];
    expect(evaluateTraceCheck({ kind: 'called', tool: 'desk_cancel_ticket', args: { ticket_id: 'T-1003' }, times: 1 }, 0, calls, '')!.ok).toBe(true);
    // A lookup is a read, not a call of the target tool.
    expect(evaluateTraceCheck({ kind: 'not_called', tool: 'desk_list_tickets' }, 0, calls, '')!.ok).toBe(true);
    expect(evaluateTraceCheck({ kind: 'max_calls', max: 1 }, 0, calls, '')!.ok).toBe(false);
    const answer = 'Here you go:\n```json\n{"titles": ["B", "A"], "extra": 1}\n```';
    expect(evaluateTraceCheck({ kind: 'answer', json: { titles: ['A', 'B'] }, unordered: true }, 0, [], answer)!.ok).toBe(true);
    expect(evaluateTraceCheck({ kind: 'answer', json: { titles: ['A', 'B'] } }, 0, [], answer)!.ok).toBe(false);
    expect(evaluateTraceCheck({ kind: 'answer', contains: 'here', notContains: 'error' }, 0, [], answer)!.ok).toBe(true);
  });

  it('rejects task files that cannot be graded', () => {
    expect(() => parseTasksFile({ tasks: [] })).toThrow(/non-empty/);
    expect(() => parseTasksFile({ tasks: [{ id: 'a', prompt: 'do the thing please', checks: [] }] })).toThrow(/can't fail/);
    expect(() => parseTasksFile({ tasks: [{ id: 'a', prompt: 'do the thing please', checks: [{ kind: 'state', call: { tool: 't' } }] }] })).toThrow(/equals, contains or count/);
    expect(() => parseTasksFile({ tasks: [{ id: 'a', prompt: 'do the thing please', checks: [{ kind: 'vibes' }] }] })).toThrow(/kind/);
  });

  it('gives model APIs portable tool names', () => {
    const names = [...modelToolNames([{ name: 'get-me' }, { name: 'repo/list' }, { name: 'repo_list' }] as never).keys()];
    expect(names).toEqual(['get-me', 'repo_list', 'repo_list_2']);
  });
});

describe('anvil eval against the sample upstream', () => {
  it('compares the same capabilities: the original condition exposes the raw targets and lookup tools', async () => {
    if (!tsxAvailable) return;
    const base = await sampleConfig();
    const runtime = await startProxyRuntime(base, { quiet: true, onUpstreamStderr: () => undefined });
    try {
      const configs = conditionConfigs(base, runtime);
      expect(configs.original?.adapter).toBeNull();
      expect(configs.original?.tools.include.sort()).toEqual(['desk_cancel_ticket', 'desk_list_tickets', 'desk_open_ticket']);
      expect(configs.descriptions).toBeUndefined();
      expect(configs.adapted?.adapter?.domain).toBe('sample-desk');
    } finally {
      await runtime.close();
    }
  }, 40_000);

  it('runs both conditions on fresh upstreams and grades them independently', async () => {
    if (!tsxAvailable) return;
    const model = new ScriptedModel();
    const tasks = await loadTasksFile(sampleTasksPath());
    const run = await runEval({
      base: await sampleConfig(),
      tasks,
      taskIds: ['cancel-by-title', 'count-open'],
      model: { provider: 'openai-compatible', baseUrl: 'http://scripted.invalid/v1', model: 'scripted', temperature: 0, maxTokensPerCompletion: 500 },
      transport: model,
    });
    expect(run.conditions).toEqual(['original', 'adapted']);
    expect(run.summary.byCondition.adapted).toMatchObject({ attempts: 2, pass: 2 });
    expect(run.summary.byCondition.original).toMatchObject({ attempts: 2, pass: 1, fail: 1 });

    const guessed = run.trials.find((trial) => trial.taskId === 'cancel-by-title' && trial.condition === 'original')!;
    expect(guessed.status).toBe('fail');
    const failed = guessed.checks.filter((check) => !check.ok).map((check) => check.detail).join(' ');
    expect(failed).toContain('T-1001');

    const adapted = run.trials.find((trial) => trial.taskId === 'cancel-by-title' && trial.condition === 'adapted')!;
    expect(adapted.status).toBe('pass');
    expect(adapted.calls[0]!.upstreamCalls.map((entry) => `${entry.role}:${entry.tool}`)).toEqual(['lookup:desk_list_tickets', 'target:desk_cancel_ticket']);

    // A fresh upstream per trial: the original trial's wrong cancel did not leak into the adapted one.
    expect(run.reset).toBe('restart');
    expect(run.summary.paired.find((row) => row.taskId === 'cancel-by-title')!.pass).toEqual({ original: 0, adapted: 1 });
    expect(run.trials.every((trial) => trial.usage.totalTokens! > 0)).toBe(true);
    expect(JSON.stringify(run)).not.toContain('apiKey');

    const text = formatEvalRun(run);
    expect(text).toContain('passed');
    expect(text).toMatch(/cancel-by-title\s+0\/1\s+1\/1\s+▲/);
    // Both conditions saw identical system and user prompts.
    const prompts = new Set(model.requests.filter((request) => request.messages.length === 2).map((request) => JSON.stringify(request.messages)));
    expect(prompts.size).toBe(2);
  }, 60_000);

  it('marks a model that never stops as invalid, not as a pass or a fail', async () => {
    if (!tsxAvailable) return;
    const looping: ModelTransport = {
      kind: 'openai-compatible',
      listModels: async () => [],
      complete: async () => call('list_tickets', { workspace: 'acme' }),
    };
    const run = await runEval({
      base: await sampleConfig(),
      tasks: await loadTasksFile(sampleTasksPath()),
      taskIds: ['count-open'],
      conditions: ['adapted'],
      budget: { maxTurns: 3 },
      model: { provider: 'openai-compatible', baseUrl: 'http://scripted.invalid/v1', model: 'scripted', temperature: 0, maxTokensPerCompletion: 500 },
      transport: looping,
    });
    expect(run.trials[0]).toMatchObject({ status: 'invalid' });
    expect(run.trials[0]!.reason).toContain('3 turns');
  }, 40_000);

  it('refuses checks that name tools the upstream does not have, before calling any model', async () => {
    if (!tsxAvailable) return;
    const model = new ScriptedModel();
    await expect(
      runEval({
        base: await sampleConfig(),
        tasks: parseTasksFile({ tasks: [{ id: 'x', prompt: 'cancel the ticket please', checks: [{ kind: 'called', tool: 'cancel_ticket' }] }] }),
        model: { provider: 'openai-compatible', baseUrl: 'http://scripted.invalid/v1', model: 'scripted', temperature: 0, maxTokensPerCompletion: 500 },
        transport: model,
      }),
    ).rejects.toThrow(/original tool names/);
    expect(model.requests).toHaveLength(0);
  }, 40_000);

  it('lints the shipped sample tasks: every one fails on an untouched desk', async () => {
    if (!tsxAvailable) return;
    const results = await lintTasks(await sampleConfig(false), await loadTasksFile(sampleTasksPath()));
    expect(results).toHaveLength(6);
    expect(results.every((result) => !result.passesUntouched && result.brokenStateChecks.length === 0)).toBe(true);
    const trivial = await lintTasks(await sampleConfig(false), parseTasksFile({ tasks: [{ id: 'trivial', prompt: 'do nothing at all', checks: [{ kind: 'not_called', tool: 'desk_cancel_ticket' }] }] }));
    expect(trivial[0]!.passesUntouched).toBe(true);
  }, 60_000);
});
