# Measure it on your own server: `anvil eval`

An adapter is a hypothesis: "this interface makes my model better at my tasks". `anvil eval` tests it. It runs the same tasks through the raw interface and the adapted one, with the same model, prompt and budgets, and grades each trial by what actually happened on the server, not by what the model said it did.

```bash
# Validate a task file without a model: every task should FAIL on an untouched server
anvil eval --config anvil/anvil.proxy.json --tasks anvil/tasks.json --check

# Measure
anvil eval --config anvil/anvil.proxy.json --tasks anvil/tasks.json --model qwen2.5:7b                 # local Ollama
anvil eval --config anvil/anvil.proxy.json --tasks anvil/tasks.json \
  --model openai/gpt-oss-20b --base-url https://openrouter.ai/api/v1 --attempts 3                     # key in ANVIL_MODEL_API_KEY

# Or try it on the built-in demo server first
anvil eval --sample --model qwen2.5:7b
```

The server is named the same way as for `anvil proxy` (`--config`, `--url`, `-- <command>`, `--sample`). Without `--model`, the `ANVIL_MODEL`, `ANVIL_MODEL_BASE_URL` and `ANVIL_MODEL_PROVIDER` variables are used; the key is only ever read from `ANVIL_MODEL_API_KEY` and never written to the run record.

## What gets compared

| Condition | The model sees | Included when |
| --- | --- | --- |
| `original` | Every upstream tool the adapted condition can reach (passed-through tools, adapted targets, lookup tools), unchanged. Same capabilities, raw interface. | always |
| `descriptions` | `original` plus only the config's description overrides. Isolates "just document it better". | the config has `tools.overrides.<tool>.description` |
| `adapted` | The proxy config as written: adapter, overrides, output shapes, filters. | always |

Pick a subset with `--conditions original,adapted`. Trials are interleaved (task → attempt → condition), so a provider slowdown hits every condition alike.

**A fresh server per trial.** For a stdio upstream, each trial starts its own server process, so one trial's writes can't leak into the next. That makes write tasks safe on any server that keeps state in memory or in a scratch location you pass on its command line. For an HTTP upstream there is nothing to restart (`--reset none`): use read-only tasks, or point it at a disposable environment.

**Budgets.** 8 turns, 12 tool calls and 180 s per trial by default (`--max-turns`, `--max-calls`, `--trial-timeout`). A trial that runs out is `invalid`, a model or server failure is `error`. Neither counts as a pass or a fail.

## Task file (`anvil.tasks/v1`)

```json
{
  "schema": "anvil.tasks/v1",
  "system": "Workspace slug: acme. Ticket priorities run from P1 (most urgent) to P3.",
  "tasks": [
    {
      "id": "cancel-by-title",
      "family": "cancel",
      "prompt": "Cancel the ticket titled \"Unique billing glitch\" in the acme workspace.",
      "checks": [
        { "kind": "called", "tool": "desk_cancel_ticket", "args": { "ticket_id": "T-1003" }, "times": 1 },
        {
          "kind": "state",
          "call": { "tool": "desk_list_tickets", "args": { "query": { "workspace": "acme", "status": "O" } } },
          "path": "items",
          "count": 2
        }
      ]
    }
  ]
}
```

- `system` is context every task shares, shown identically in every condition.
- `prompt` is the whole instruction. Don't put answers or hints about the checks in it. If you want a JSON reply, say so in the prompt.
- `family` groups tasks in your own analysis.

**Checks name the upstream's original tools and arguments.** That's what makes one file fair to every condition: when the model calls the adapted `cancel_ticket(title)`, the check sees the `desk_cancel_ticket(ticket_id: "T-1003")` the adapter compiled it into, exactly as if the model had called the original itself.

| Check | Passes when |
| --- | --- |
| `{"kind": "called", "tool": T, "args"?: {...}, "times"?: n}` | A successful call to `T` whose arguments contain `args` (deep subset) reached the upstream at least once, or exactly `times` times. Adapter lookups are reads and never count as calls of the target. |
| `{"kind": "not_called", "tool": T, "args"?: {...}}` | No such call reached the upstream (successful or not). |
| `{"kind": "state", "call": {"tool": T, "args": {...}}, "path"?: "items", "equals" \| "contains" \| "count": ...}` | After the trial, Anvil calls `T` itself (bypassing the model and the adapter) and the value at `path` deep-equals, deep-contains or has `count` items. `contains` with one object against a list means "some item matches". |
| `{"kind": "answer", "contains"?, "notContains"?, "regex"?, "json"?: {...}, "unordered"?: true}` | The final message contains / doesn't contain the strings (case-insensitive), matches the regex, and/or holds a JSON object that deep-contains `json` (arrays as sets with `unordered`). |
| `{"kind": "max_calls", "max": n}` | At most `n` upstream calls in total (lookups included). Catches flailing that ends well. |

Every check takes an optional `label`. Prefer state checks for writes and answer checks for questions; add `not_called` for the things that must not happen. A task that only checks the answer can be passed by a lucky guess.

**Write tasks that fail when nothing is done.** `--check` grades every task against an untouched server with an empty answer and flags tasks that pass anyway (they can't tell conditions apart) and state checks whose read call fails.

## Reading the result

```text
                      original      adapted
passed                2/4           4/4
pass rate             50%           100%
failed checks         2             0
no verdict            0             0
upstream calls        4             6
tokens                2,560         2,560

Per task (passes)
  cancel-by-title     0/2           2/2             ▲
  count-open          2/2           2/2

Why trials did not pass
  cancel-by-title · original #1: fail — 1 of 3 check(s) failed.
      ✖ desk_cancel_ticket called with {"ticket_id":"T-1003"} exactly 1×: 0 matching successful call(s) of 1;
        inputs were {"workspace":"acme","ticket_id":"T-1001"}.
```

▲ and ▼ mark tasks where the last condition beat or lost to the first. The full record (every turn, tool call, compiled upstream call and check) is saved to `.anvil/evals/<id>.json`, or `--out`.

Be honest with yourself about sample size: a handful of tasks with one attempt each is a smoke test. Wilson intervals appear once a condition has 5+ attempts. Add tasks before adding attempts, and keep a held-out set you don't tune the adapter against. The repository's own [evaluation](EVALUATION.md) shows what that discipline looks like.

## The demo server

`--sample` uses a deliberately awkward in-memory ticket desk: nested `query` and `ticket` envelopes, `O`/`C` status codes, priority levels `"1"`–`"3"`, cancel by opaque id only. [`examples/adapters/sample-desk.adapter.json`](../examples/adapters/sample-desk.adapter.json) fixes it, and [`examples/sample-desk.tasks.json`](../examples/sample-desk.tasks.json) has six tasks. One task, cancelling one of two same-titled tickets by priority, is something that adapter can't express: its `cancel_ticket` looks up by title only and refuses when two tickets match. Expect the adapted condition to lose that one. That's the point of measuring.
