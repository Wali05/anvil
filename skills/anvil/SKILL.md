---
name: anvil
description: Diagnose, fix and measure MCP tool interfaces that models call badly. Use when an agent keeps misusing an MCP server's tools (wrong argument shapes, guessed ids, invented query syntax, ignored limits, oversized results), when someone wants to lint an MCP server's tool catalog, put a simplified adapter, a filtered read-only view or output trimming in front of an MCP server, measure with their own model whether an interface change helps, or summarize which tools fail in a call log.
---

# Anvil

Anvil sits between an MCP client and an MCP server. It lints a server's tools, generates a starter adapter, serves adapted / filtered / re-described / output-trimmed tools as a proxy, measures original vs adapted with a real model (`anvil eval`), and summarizes the proxy's call log.

Run it with `npx -y -p github:Wali05/anvil anvil <command>` (or `node dist/cli.js <command>` in a checkout). The upstream server is given as `--url <https://…/mcp>`, as `-- <command> [args…]` (everything after `--`), with `--config <anvil.proxy.json>`, or `--sample` for the built-in demo desk.

**Fastest start:** `anvil init -- <server command>` writes `anvil/anvil.proxy.json`, `anvil/adapter.json`, `anvil/inspect.txt` and a starter `anvil/tasks.json`, and prints next steps.

## Diagnose

1. `anvil inspect -- <server command>` lists findings per tool, worst first. Rules worth acting on:
   - `hidden-maximum`: a limit parameter has a maximum the description does not state. Models ask for more and fail.
   - `query-dialect`: a free-text `q` / `query` / `filter` parameter. Models invent syntax and trust the empty result.
   - `opaque-id-required`: a write needs an id the model rarely has. It guesses.
   - `nested-input`: objects two or more levels deep. Small models misplace fields.
   - `datetime-format-unstated`, `enum-unstated`, `params-undocumented`, `too-many-tools`, `name-not-portable`, `top-level-union`.
2. `anvil inspect --json` for machine-readable output; `--fail-on warn` for CI.
3. If a proxy log exists: `anvil report calls.jsonl` groups failures by tool, by stage (`input`, `adapter`, `lookup`, `upstream`) and by error shape, with a suggestion per tool.

## Fix

- **Only descriptions or the tool set are the problem**: a proxy config with `tools.overrides.<tool>.description`, `tools.include`, `tools.exclude` (`*` globs). No adapter needed.
- **Argument shapes are the problem**: `anvil scaffold --out adapter.json -- <server command>` writes a validated `anvil.adapter/v1` that flattens nested inputs into top-level fields (same tool name, snake_case). Then edit it:
  - `valueMap` for friendly enum values, `default` / `const` for values the model should not have to choose
  - `isoDateTime`, `dayStart`, `dayEnd`, `durationEnd` for local time → RFC 3339 with a declared offset
  - `wrapEmail` for `[{email}]` arrays, `issueQuery` parts to build a query string from structured filters
  - `anvil.adapter/v2` `lookup` to replace a required id with a name: one read-only search call (the upstream must annotate it `readOnlyHint: true`), exactly one exact match, else nothing is written and the candidates are returned
- **Results are too big**: an output shape on the adapted tool (`output`) or a passthrough override (`tools.overrides.<tool>.output`): `pick` paths like `items[].title`, `maxItems`, `maxChars`. The model is told what was cut.
- Serve it: `anvil proxy --adapter adapter.json --log-file calls.jsonl -- <server command>`. Check the exposed catalog first with `--dry-run`.

## Measure

1. Write tasks (`anvil.tasks/v1`, see docs/TASKS.md). Checks name the upstream's ORIGINAL tools: `called` / `not_called` (graded on the compiled original call), `state` (Anvil reads the upstream itself afterwards), `answer` (substring / regex / JSON subset), `max_calls`.
2. `anvil eval --config anvil/anvil.proxy.json --tasks anvil/tasks.json --check` must show every task failing on an untouched server; fix any that pass with no action.
3. `anvil eval … --model <id> [--base-url <url>] --attempts 3`. The key goes only in `ANVIL_MODEL_API_KEY`. Stdio upstreams restart per trial; HTTP upstreams don't, so keep those tasks read-only.
4. Report the per-condition counts and the per-task pairs, not just the headline. Name tasks where adapted lost (▼); a few tasks with one attempt is a smoke test, not a result.

## Rules

- Never put a secret in a config file or a command line that gets logged. Use `${VAR}` in `headers`, `env`, `args` and `url`; the value is read from the environment.
- An adapter maps inputs; outputs come back as the upstream sent them unless an output shape trims them (it can keep fields, cap lists and cap length, never rename or restructure). One public call makes at most one lookup call plus one target call. There is no eval, code generation or shell.
- Adapted tools replace the originals they call (unless `--keep-targets`); hiding a tool is not a security boundary for the upstream itself, only for what the model is offered.
- `--http <port>` binds 127.0.0.1. A public host needs `ANVIL_HTTP_TOKEN` (bearer auth); never disable that.
- When reporting workbench results, quote numerators and denominators, say which model and split, and never present a **simulation** run (scripted policy) as model evidence. `invalid` and `error` trials are neither wins nor losses.
