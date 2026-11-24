import { readFile } from 'node:fs/promises';
import { AnvilError } from '../core/errors.js';
import { isPlainObject } from '../core/util.js';

/**
 * `anvil.tasks/v1`: tasks for `anvil eval` against any MCP server.
 *
 * Checks name the upstream's ORIGINAL tools and arguments. That makes one task
 * file fair to every condition: when the model calls an adapted tool, the check
 * sees the original call the adapter compiled it into.
 */
export interface EvalTasksFile {
  schema: 'anvil.tasks/v1';
  /** Context every task shares (ids, time zone, workspace), shown identically in every condition. */
  system?: string;
  tasks: EvalTask[];
}

export interface EvalTask {
  id: string;
  prompt: string;
  /** Free-form tag for per-family reporting. */
  family?: string;
  checks: EvalCheck[];
}

export type EvalCheck =
  /** The upstream tool was called successfully with arguments that contain `args` (deep subset). */
  | { kind: 'called'; tool: string; args?: unknown; times?: number; label?: string }
  /** No call to the upstream tool (optionally: with these arguments) reached the upstream. */
  | { kind: 'not_called'; tool: string; args?: unknown; label?: string }
  /**
   * After the trial, Anvil calls an upstream tool itself (bypassing the model and the adapter)
   * and compares the value at `path`: deep `equals`, deep-subset `contains`, or array `count`.
   */
  | { kind: 'state'; call: { tool: string; args?: Record<string, unknown> }; path?: string; equals?: unknown; contains?: unknown; count?: number; label?: string }
  /**
   * The model's final message. `contains` / `notContains` are case-insensitive substrings; `json` is a
   * deep-subset match against a JSON object in the answer (arrays compare as sets when `unordered`).
   */
  | { kind: 'answer'; contains?: string | string[]; notContains?: string | string[]; json?: Record<string, unknown>; unordered?: boolean; regex?: string; label?: string }
  /** At most this many upstream calls in total: catches flailing that still ends well. */
  | { kind: 'max_calls'; max: number; label?: string };

const CHECK_KINDS = new Set(['called', 'not_called', 'state', 'answer', 'max_calls']);

function fail(message: string): never {
  throw new AnvilError('tasks_invalid', message);
}

export function parseTasksFile(raw: unknown, where = 'tasks file'): EvalTasksFile {
  if (!isPlainObject(raw)) fail(`${where} must be a JSON object.`);
  if (raw.schema !== undefined && raw.schema !== 'anvil.tasks/v1') fail(`${where}: schema must be "anvil.tasks/v1".`);
  if (raw.system !== undefined && typeof raw.system !== 'string') fail(`${where}: system must be a string.`);
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) fail(`${where}: tasks must be a non-empty array.`);
  const seen = new Set<string>();
  const tasks = raw.tasks.map((task, index): EvalTask => {
    const at = `${where}: tasks[${index}]`;
    if (!isPlainObject(task)) fail(`${at} must be an object.`);
    if (typeof task.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,80}$/.test(task.id)) fail(`${at}.id must be 1-80 characters of letters, digits, _ . : -`);
    if (seen.has(task.id)) fail(`${at}.id "${task.id}" is duplicated.`);
    seen.add(task.id);
    if (typeof task.prompt !== 'string' || task.prompt.trim().length < 8) fail(`${at}.prompt must describe the task.`);
    if (task.family !== undefined && typeof task.family !== 'string') fail(`${at}.family must be a string.`);
    if (!Array.isArray(task.checks) || task.checks.length === 0) fail(`${at}.checks must be a non-empty array: a task without a check can't fail.`);
    task.checks.forEach((check, checkIndex) => {
      const c = `${at}.checks[${checkIndex}]`;
      if (!isPlainObject(check) || typeof check.kind !== 'string' || !CHECK_KINDS.has(check.kind)) fail(`${c}.kind must be one of ${[...CHECK_KINDS].join(', ')}.`);
      if ((check.kind === 'called' || check.kind === 'not_called') && typeof check.tool !== 'string') fail(`${c}.tool must name an upstream tool.`);
      if (check.kind === 'called' && check.times !== undefined && (!Number.isInteger(check.times) || (check.times as number) < 0)) fail(`${c}.times must be a non-negative integer.`);
      if (check.kind === 'state') {
        if (!isPlainObject(check.call) || typeof check.call.tool !== 'string') fail(`${c}.call.tool must name an upstream tool.`);
        if (check.call.args !== undefined && !isPlainObject(check.call.args)) fail(`${c}.call.args must be an object.`);
        if (check.equals === undefined && check.contains === undefined && check.count === undefined) fail(`${c} needs equals, contains or count.`);
        if (check.count !== undefined && (!Number.isInteger(check.count) || (check.count as number) < 0)) fail(`${c}.count must be a non-negative integer.`);
        if (check.path !== undefined && typeof check.path !== 'string') fail(`${c}.path must be a dot path.`);
      }
      if (check.kind === 'answer') {
        if (check.contains === undefined && check.notContains === undefined && check.json === undefined && check.regex === undefined) fail(`${c} needs contains, notContains, json or regex.`);
        if (check.json !== undefined && !isPlainObject(check.json)) fail(`${c}.json must be an object.`);
        if (check.regex !== undefined) {
          try {
            new RegExp(check.regex as string);
          } catch {
            fail(`${c}.regex is not a valid regular expression.`);
          }
        }
      }
      if (check.kind === 'max_calls' && (!Number.isInteger(check.max) || (check.max as number) < 1)) fail(`${c}.max must be a positive integer.`);
    });
    return task as unknown as EvalTask;
  });
  return { schema: 'anvil.tasks/v1', ...(typeof raw.system === 'string' ? { system: raw.system } : {}), tasks };
}

export async function loadTasksFile(path: string): Promise<EvalTasksFile> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new AnvilError('tasks_unreadable', `Could not read ${path}: ${(error as Error).message}`);
  }
  return parseTasksFile(parsed, path);
}

/** Upstream tools the checks refer to; validated against the live catalog before any model call. */
export function toolsReferenced(file: EvalTasksFile): Set<string> {
  const names = new Set<string>();
  for (const task of file.tasks) {
    for (const check of task.checks) {
      if (check.kind === 'called' || check.kind === 'not_called') names.add(check.tool);
      if (check.kind === 'state') names.add(check.call.tool);
    }
  }
  return names;
}
