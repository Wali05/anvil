# Evaluation

How Anvil measures whether a tool-interface change helps a model, and what the recorded runs show. Every number here comes from a persisted run record. Nothing was hand-entered.

## Method

Each task runs under three conditions, with the same model, system prompt, user prompt, fixture reset, temperature and budgets:

| Condition | What the model sees |
| --- | --- |
| **Original** | The raw tools: real names, nested schemas, strict query syntax, terse errors. |
| **Descriptions** | The same tools and schemas with better tool and field documentation only. Schemas are checked to be identical once documentation is stripped. |
| **Adapted** | Tools generated from an `anvil.adapter` spec. Each call is compiled back into the original call and run by the same original executor. |

After each trial, independent server-side validators inspect the final fixture state and the answer:

- **intent:** the target record has exactly the requested fields
- **preservation:** unrelated records are unchanged, byte for byte, and there are no extra writes
- **contract:** query tasks must return the exact JSON answer (`{"issue_numbers": [7, 9, 12, 22]}`), so "the model said done" never passes
- **hygiene:** e.g. data that looks like an instruction inside a fixture record is treated as data

A trial is `pass`, `fail`, or `invalid` (no verdict: the turn, tool-call or token budget ran out, or the model sent an empty final message). `error` is a provider or harness failure. Only `pass` counts as a win; a missing result is never a win.

Budgets: 8 turns, 6 underlying tool calls and 180 s per trial by default, plus a run-level tool-call cap and a run-level token cap that stops the run before any further model request once spent. A v2 lookup tool reserves two calls before it runs.

Simulation runs use a deterministic scripted policy to exercise the engine. They are labelled everywhere and never counted as model evidence.

## Task splits

- **dev:** used to iterate on the adapters.
- **eval v1 ("seen"):** the first held-out set. Its failures were inspected on 27 Oct 2026, so it is no longer held out. Results are kept unedited.
- **eval v2 (sealed):** 15 new tasks (9 calendar, 6 issues), at least half from task families not in dev, with same-title, same-day and prefix-title distractors in fixtures no earlier task reads. Task files, fixtures and the frozen default adapters are hashed in [`evidence/eval-v2-manifest.json`](evidence/eval-v2-manifest.json); `npm run seal:check` verifies them and fails if anything changed.

## Eval v2 results

Three hosted open models through OpenAI-compatible endpoints, temperature 0, default budgets. Seal verified before and after the runs.

| Model | Attempts per task | Original | Descriptions | Adapted |
| --- | --- | --- | --- | --- |
| `openai/gpt-oss-20b` | 3 | 20/45 | 34/45 | **43/45** |
| `deepseek-v4.1-flash` | 3 | 43/45 | 45/45 | 45/45 |
| `deepseek-v4.1-flash` | 1 | 13/15 | 15/15 | 15/15 |
| `nvidia/nemotron-3-ultra` | 1 | 15/15 | 15/15 | 15/15 |

**gpt-oss-20b in detail** (3 attempts):

- By domain: calendar 7/27 → 19/27 → **27/27**; issues 13/18 → 15/18 → 16/18.
- Outcome mix: original 20 pass / 4 fail / 21 invalid (mostly the 8-turn limit), descriptions 34 / 0 / 11, adapted 43 / 0 / 2. Most original-condition losses are the model burning its turns fighting the raw schema.
- Wilson 95% (descriptive only): original 30.9–58.8%, descriptions 61.3–85.8%, adapted 85.2–98.8%.
- Paired by task, 10 of 15 tasks improve from original to adapted and none drops below original; the other 5 are 3/3 everywhere. Examples: `cal-e2-cancel-disambiguate` 0/3 → 3/3, `cal-e2-move-across-days` 0/3 → 3/3, `cal-e2-update-prefix-distractor` 0/3 → 3/3, `cal-e2-cancel-if-present` 0/3 → 3/3 (descriptions 1/3), `iss-e2-query-closed` 1/3 → 3/3.

**One regression against descriptions:** on `iss-e2-query-priority-label`, gpt-oss-20b scored 0/3 original, 2/3 descriptions and 1/3 adapted. Both adapted misses came from the model emitting a corrupted tool name (`search_issues<|channel|>commentary`) from turn 2 and looping to the turn limit. The mapping was not wrong, but it is a loss all the same.

**DeepSeek's** only losses are `iss-e2-comment-closed` and `iss-e2-query-closed` in the original condition (2/3 each; tool budget exhausted, one after an "Unsupported state" error). **Nemotron** is at ceiling and does not separate the conditions.

### A typical failure

`openai/gpt-oss-20b`, task `iss-e2-query-priority-label`, original tools, the same in 3 of 3 attempts:

1. Task: list the open P2 bugs in `acme/orbit`.
2. The model calls `issues_search` with `limit: 100`, which is rejected: the maximum is 50, and the description does not say so.
3. It retries with `q: "status:open priority:P2 label:bug"`, a query dialect the tool does not support, and gets 0 results.
4. It answers `{"issue_numbers": []}`. The correct answer is `[7, 9, 12, 22]`.

Nothing was written, so a state-only check would call this fine; the answer-contract check fails it. `anvil inspect --domain issues` flags both causes (`hidden-maximum` on `limit`, `query-dialect` on `q`) without running a model.

### Runs

Raw run JSON is in [`evidence/runs/`](evidence/runs/) and in the [replay](https://anvil-two-opal.vercel.app).

| Run | Model | Domain | Attempts per task |
| --- | --- | --- | --- |
| `run_20261027081656_ab95fdb2` | deepseek flash | calendar | 1 |
| `run_20261027081656_0905b9bc` | deepseek flash | issues | 1 |
| `run_20261027082332_97568a63` | deepseek flash | calendar | 3 |
| `run_20261027082332_a2f545fa` | deepseek flash | issues | 3 |
| `run_20261027081656_d48b7039` | nemotron-3-ultra | calendar | 1 |
| `run_20261027081656_ec60a4a0` | nemotron-3-ultra | issues | 1 |
| `run_20261027082332_5a5306c4` | gpt-oss-20b | calendar | 1 |
| `run_20261027082332_3a0fc5e8` | gpt-oss-20b | issues | 1 |
| `run_20261027082848_b6d79f11` | gpt-oss-20b | issues | 2 |
| `run_20261027082848_172a5188` | gpt-oss-20b | calendar (3 tasks) | 2 |
| `run_20261027082848_2b997537` | gpt-oss-20b | calendar (3 tasks) | 2 |
| `run_20261027082848_e709e75d` | gpt-oss-20b | calendar (3 tasks) | 2 |

## Eval v1 pilot (local `qwen2.5:7b`)

Local Ollama, temperature 0, one trial per task per condition, earlier task sets (`calendar-2026.10.1`, `issues-2026.10.2`) and the v1 adapters (no lookup).

| Run | Domain / split | Attempts | Original | Descriptions | Adapted |
| --- | --- | --- | --- | --- | --- |
| `run_20261026122406_1e5da12f` | calendar / dev (single-task smoke) | 3 | 1/1 | 1/1 | 1/1 |
| `run_20261026122448_dc46693b` | calendar / dev | 21 | 5/7 | 3/7 | 3/7 |
| `run_20261026124211_7c55fba9` | issues / dev | 18 | 5/6 | 5/6 | 6/6 |
| `run_20261026124307_8a6d3f1e` | calendar / eval v1 | 21 | 4/7 | 3/7 | 5/7 |
| `run_20261026124521_e966783c` | issues / eval v1 | 18 | 3/6 (1 invalid) | 5/6 | 6/6 |

Across the four full-split runs: original 17/26, descriptions 16/26, adapted 20/26. The Wilson intervals overlap (46–81%, 43–78%, 58–89%); this pilot does not establish a difference. A compact derived record is in [`evidence/live-pilot-summary.json`](evidence/live-pilot-summary.json).

Failure modes observed in the pilot, which shaped the v2 adapter and the `anvil inspect` rules:

- wrong or invented event ids, including literal placeholders like `existing_event_id` → v2 lookup, `opaque-id-required`
- page sizes over the undocumented maximum of 50 → `hidden-maximum`
- deleting or updating the wrong event among same-title distractors → exact-match lookup that refuses on ambiguity
- wrong reschedule end times → `keepDurationEnd`
- writing when the correct action was no write (conditional tasks)
- nested issue payload mistakes, including an unrequested milestone → `nested-input`
- repeated invalid enum values until the call budget ran out → `enum-unstated`

One run (`run_20261026122645_9154ab19`, task set `issues-2026.10.1`) was retired because a task prompt accidentally contained a wrong example answer. The prompt was fixed and the task set version bumped. No trial or score was edited.

## Caveats

- **Synthetic fixtures.** Both domains are local, resettable fixtures, not Google Calendar or GitHub. They are realistic in shape, not in scale.
- **Small n.** 15 tasks with 1–3 attempts in eval v2. Wilson intervals are descriptive, not a significance test. Treat this as a pilot, not a benchmark.
- **Ceiling.** The two strong models are at or near 100% in every condition, so they cannot show an uplift. The uplift shows up on the smaller model.
- **Task bias.** Most eval v2 tasks target an existing record by title and day, which is exactly what the v2 lookup addresses. Report per family, not just totals.
- **Seeds.** Temperature is 0 but no provider seed is sent, so trials are not bit-reproducible across providers.
- **English only.** All prompts are English.

## Reproduce

```bash
npm ci
npm run seal:check
npm run live -- calendar eval2 all 3     # domain, split, tasks (or all), attempts per task
```

Configure the model with `ANVIL_MODEL_PROVIDER`, `ANVIL_MODEL_BASE_URL`, `ANVIL_MODEL` and, for hosted endpoints, `ANVIL_MODEL_API_KEY` (read from the environment only, never written to run records). See the README for all variables.
