# Anvil build status and handoff

Last updated: 2026-10-26 (local build pass)

## 27 Oct 2026 update (pass 2)

Changes in this pass:

- **Bug fix:** concurrent saves of one run could race on the temp-file rename and drop a write (`Store.writeJson` now serializes writes per path and uses unique temp names). The runner cancel test exposed it.
- **anvil.adapter/v2:** an adapted tool may declare one *read-only* lookup: exactly one original search call, exact (trimmed, case-insensitive) equality filters, optional `localTime` HH:MM filter, then exactly one target call with the matched id bound in. Zero or several matches return the candidates to the model and write nothing. Both calls are logged and counted; the runner reserves 2 before calling. v1 adapters are unchanged and still valid.
- **Calendar adapter 2.0.0** (v2): `update_event`, `move_event` (keeps the matched event's own duration) and `cancel_event` take title + date (+ optional start_time) instead of a model-supplied id. Motivated by the dev-split failures (guessed `evt_1001` on cancel/update, wrong reschedule ends). The issue adapter is unchanged.
- **Eval v1 is now "seen":** its failures were inspected on 27 Oct, so the old `eval` split is labelled "eval v1 (seen)" everywhere. Its results are kept, unedited.
- **Sealed eval v2:** 15 new tasks (9 calendar, 6 issues), split `eval2`, ≥ half from families not in dev, with same-title/same-day and prefix-title distractors (new December fixtures that no earlier task reads). `docs/evidence/eval-v2-manifest.json` records hashes of the task files, fixtures and frozen adapters; `npm run seal:check` verifies them. **No model has been run on eval v2 yet.** Known bias: most eval v2 tasks target an existing record by title and day, which is what the v2 lookup addresses; report per family.
- **Recorded replay site:** `npm run build:static` → `dist-static/`, a read-only dashboard over the committed runs in `docs/evidence/runs/` (raw run JSON, now committed). Adapter validation and previews run in the page; nothing can call a model. `vercel.json` builds it. Not deployed.
- MCP adapter server logs the lookup step and shows candidates on ambiguity; adapted tools inherit the target's permissions/destructive hints.

Verification in this pass (Linux workspace, Node 22): typecheck pass; **106/106 tests** (15 new lookup tests + runner budget test + eval v2 shape test); production build pass; `check:sim` all rehearsals pass including eval v2 (27 calendar + 18 issue trials, all conditions); `seal:check` intact; `smoke:mcp` pass including lookup cancel (2 calls) and ambiguous refusal (1 call, no write); Playwright 2/2 with bundled Chromium; replay site checked at 1440 px and 390 px with no console errors or horizontal overflow. `smoke:api` passes except "local Ollama model listing", which needs Ollama (not present in that workspace).

Still to do: live qwen2.5:7b runs on dev (sanity check of v2) and then eval v2 once per condition; deployment of the replay site; README.

## Current state

The local end-to-end application is implemented and verified: two fixture domains, three interface conditions, independent state checks, executable adapters, persistence, dashboard, exports, and official-SDK MCP servers. It is **not deployed, not pushed, and not installed in Alan**. There is no public URL.

Live evidence exists from a local open model (`qwen2.5:7b` via Ollama). It is a small pilot on synthetic fixtures, not a benchmark and not a claim of uplift. Scripted simulations are labeled and excluded from live summaries.

## Experiment environment

- Live experiment model: local Ollama `qwen2.5:7b`; the provider response reported the same model id. Endpoint `http://127.0.0.1:11434/v1`. Temperature 0.
- No proprietary/frontier model was invoked for experiments. No credentials were read from a credential store, and no API key is persisted.
- Platform: Windows, PowerShell; Node v24.21.0; npm 10.8.2. The project is plain Node/TypeScript and is not tied to PowerShell.

## Implemented

- **Core**: versioned `anvil.adapter/v1` schema, bounded mapping compiler, Ajv validation, condition interfaces, model transport, experiment runner, metrics, atomic JSON persistence.
- **Calendar domain**: 14 tasks (7 dev, 7 eval), resettable fixture, four raw tools, independent validators, default adapter, scripted rehearsal policy.
- **Issue tracker domain**: 12 tasks (6 dev, 6 eval), two repositories, nested raw envelopes, query dialect, injection-containing fixture, independent validators, default adapter, scripted policy.
- **Runner**: live OpenAI-compatible loop, multiple tool calls per turn, malformed-output surfacing, system-prompt isolation, budgets, wall clock, cancellation, prompt-injection notes, persisted partial state, interrupted-run recovery.
- **Server**: local HTTP API, SSE progress, in-memory model setup, adapter validation/preview/save/reset, evidence and adapter downloads, real MCP health check, compiled dashboard serving.
- **Dashboard**: workbench, honest empty state, simulation vs live separation, three-condition comparison, paired same-task counts, task matrix, trace/checks/diff/raw trial views, condition switching, adapter import/edit/save/reset, schema inspector, mapping preview, experiments list, integration page, 390px layout.
- **MCP**: workbench server (8 tools), adapted adapter executor, exported-bundle execution via `--adapter-file`, stderr-only call logging, fixture utilities.
- **Packaging**: MIT license, lockfile, `.env.example`, `.gitignore`, CLI, plugin manifest, marketplace entry, skill, template `mcp.json` with a reserved `.invalid` URL.

## Commands

```powershell
npm ci
npm run typecheck
npm test
npm run build
npm start                  # http://127.0.0.1:4317
npm run dev                # API + Vite
npm run e2e                # Playwright with installed Edge
npm run check:sim
npm run smoke:api
npm run smoke:mcp
node dist/cli.js check-mcp
```

Optional live configuration is explicit: run the local Ollama server yourself, then configure the model in the UI (or set `ANVIL_MODEL_*` for an MCP server). Do not start or restart a long-running Ollama process from an automated shell that waits for it.

## Verification results

| Check | Result |
| --- | --- |
| `npm ci` | Installed 272 packages; `package-lock.json` present. |
| `npm run typecheck` | Pass. |
| `npm run build` | Pass: Vite dashboard + esbuild server/CLI/MCP bundles. |
| `npm test` | **89/89 tests pass** in 6 files. |
| `npm run check:sim` | **78/78 scripted trials pass** across both domains and both splits. |
| `npm run smoke:api` | 26/26 checks pass: serve, run, persist, exports, adapter validation, unsafe-key rejection, key non-persistence, MCP health. |
| `npm run smoke:mcp` | Pass: exported bundle consumed by a separate MCP process; original calls logged; created event visible through the exported query tool. |
| `npm run e2e` | **2/2 Playwright flows pass** at 1440px and 390px, including simulation, drill-down, adapter error, export, MCP handshake, keyboard access, narrow layout. |
| `node dist/cli.js check-mcp` | Handshake success; server `anvil-workbench` 0.1.0; 8 tools. |
| Live pilot | 78 matched attempts across four full-split runs, plus one 3-attempt smoke run. See below. |
| Deploy/push | Not performed, by instruction. |

### Test coverage highlights

- Adapter validation rejects duplicate/colliding names, unknown targets, missing required target fields, unconsumed inputs, unsafe keys (including nested in constants/defaults), `$ref`/union keywords, unsupported transforms, invalid dates and over-limit tool counts.
- Descriptions condition schema equivalence is checked after stripping documentation fields.
- Adapted and original calls are proven to produce identical fixture state; adapted compile errors do not silently repair or touch state.
- Validators catch the right event plus an extra write, wrong delete targets, unrelated-event changes, wrong times, partial query answers, wrong milestones and changed unrelated issues.
- Runner tests cover simulation labeling, both domains, per-trial and run budgets, cancellation, provider error, malformed arguments, multiple tool calls in one turn, identical system/user guidance across conditions, max turns, empty output, prompt-injection isolation, key non-persistence and interrupted-run recovery.
- MCP tests start real stdio servers through the official SDK client, execute adapted calls, and read the logged original calls.
- Browser tests assert no page-level horizontal overflow at 390px.

## Live evidence (open model, local Ollama)

All counts below come from persisted runs in `.anvil/runs/`. Nothing was hand-entered into the app. Temperature 0; one trial per task per condition. A compact derived record is committed at `docs/evidence/live-pilot-summary.json`; full run JSON remains local in `.anvil/runs/`.

| Run | Domain / split | Task set | Attempts | Original | Descriptions | Adapted |
| --- | --- | --- | --- | --- | --- | --- |
| `run_20261026122406_1e5da12f` | calendar / dev (single task smoke) | calendar-2026.10.1 | 3 | 1/1 | 1/1 | 1/1 |
| `run_20261026122448_dc46693b` | calendar / dev | calendar-2026.10.1 | 21 | 5/7 | 3/7 | 3/7 |
| `run_20261026124211_7c55fba9` | issues / dev | issues-2026.10.2 | 18 | 5/6 | 5/6 | 6/6 |
| `run_20261026124307_8a6d3f1e` | calendar / eval | calendar-2026.10.1 | 21 | 4/7 | 3/7 | 5/7 |
| `run_20261026124521_e966783c` | issues / eval | issues-2026.10.2 | 18 | 3/6 (1 invalid) | 5/6 | 6/6 |

Aggregate over the four full-split runs (26 tasks per condition; descriptive only):

| Condition | Pass | Fail | Invalid | Pass / attempts | Decisive pass | Wilson 95% |
| --- | --- | --- | --- | --- | --- | --- |
| Original | 17 | 8 | 1 | 65.4% | 17/25 = 68.0% | 46.2–80.6% |
| Descriptions | 16 | 10 | 0 | 61.5% | 16/26 = 61.5% | 42.5–77.6% |
| Adapted | 20 | 6 | 0 | 76.9% | 20/26 = 76.9% | 57.9–89.0% |

Underlying tool calls: original 50, descriptions 42, adapted 41. Provider-reported tokens: original 91,648, descriptions 108,503, adapted 79,386. Provider-reported cost: unknown; Ollama did not report cost, so no cost was invented.

**Interpretation guard:** the intervals overlap; n = 26 synthetic tasks, one model, one trial each. The pilot does not establish statistical superiority or a general uplift. Development and evaluation results are reported separately; they are not a held-out benchmark claim.

Observed failure modes (real model behavior, not mutated results):

- wrong/nonexistent event ids, including fabricated ids like `existing_event_id`
- over-limit page sizes (`>50`) rejected by schema validation
- deleting the wrong event on reschedule/cancel tasks
- wrong target changed when updating location
- conditional and availability tasks where the model wrote when the correct action was no write
- nested issue payload mistakes, including adding an unrequested milestone
- repeated invalid `resolution` values until the original underlying-call budget was exhausted (correctly marked `invalid`, not a pass or fail)

### Superseded evidence

`run_20261026122645_9154ab19` was produced under task set `issues-2026.10.1`. Its `iss-dev-query-label` prompt accidentally contained a wrong example answer. The prompt was fixed, the issue task set was bumped to `issues-2026.10.2`, and the run was moved to `.anvil/retired/` with an explanatory note. It is excluded from the table above. No trial or score was edited.

## Browser evidence

Screenshots are in `docs/screenshots/`. The first seven were produced by the Playwright flow against a cleared local data directory and show the dashboard with a **labeled scripted simulation**. The last three show the persisted live pilot from `run_20261026122448_dc46693b`, a genuine failed assertion, and the paired same-task comparison:

- `01-first-run-1440.png` — honest empty state and workflow
- `02-results-1440.png` — three-condition comparison and task matrix
- `03-trial-detail-1440.png` — state diff for an adapted simulated call
- `04-interfaces-1440.png` — mapping preview, limits and schemas
- `05-integration-1440.png` — real MCP handshake success and honest Alan status
- `06-narrow-workbench-390.png` — 390px workbench
- `07-narrow-interfaces-390.png` — 390px adapter interface

## Integration evidence

- Workbench MCP: official SDK, stdio, 8 tools, handshake and tool invocation verified by a real client.
- Adapter MCP: calendar and issue adapted tools executed in separate processes; close/query behavior verified; original call fields verified from stderr logs.
- Exported bundle: `anvil.adapter-bundle/v1`, adapter hash matched the executor, `schedule_event` compiled to `calendar_create_event`, duration mapping produced the expected end time, and `find_events` reflected the created event.
- Alan: plugin manifest/marketplace/skill present. `mcp.json` uses `https://anvil-mcp.invalid/mcp` because no public HTTPS deployment exists. **File presence is not installation.**

## Storage and security

- `.anvil/runs/<id>.json` contains every trial, including failures, invalids, errors and cancellations.
- `.anvil/adapters/<domain>.json` contains only explicitly saved specs.
- Run records and exports contain no `apiKey`; storage refuses to write a record containing that field.
- Model API key is held in server memory only; the UI never writes it to localStorage.
- Adapter execution cannot call `eval`, shell, network, validators or hidden fixture lookups.
- MCP diagnostics go to stderr; protocol messages stay on stdout.
- Server binds to `127.0.0.1` by default; no CORS wildcard.

## Known limitations / remaining work

1. **Larger evidence:** more tasks, multiple trials, a second open model and a proper paired analysis. The current 26-task pilot is a sanity check.
2. **Output mapping:** adapters currently map inputs only; original outputs are returned unchanged.
3. **Real connectors:** both domains are disposable local fixtures, not Google Calendar/GitHub clients.
4. **Remote HTTPS MCP:** no deployment; the plugin template URL is intentionally non-resolving. Alan installation is unverified and not claimed.
5. **Optional adapter proposal:** not implemented. Adapters are explicit, validated JSON.
6. **Cost:** provider cost is unknown for Ollama. A paid OpenAI-compatible endpoint may report cost; the field remains null if it does not.
7. **Statistical claims:** none. Wilson intervals are descriptive, not a significance test.
8. **Simulation:** covers engine/mapping behavior only; never counted as live performance.
9. **Task quality:** synthetic fixtures may be easier or harder than real work, and the prompts are English-only.
10. **Seeds:** no provider seed is sent. Temperature is 0, but trials are not seed-reproducible across providers.

## Handoff checklist

1. `npm ci && npm test && npm run build`
2. `npm start`, open `http://127.0.0.1:4317`
3. Explore the labeled simulation, then configure a local open model for a live run.
4. `npm run e2e` to re-exercise the browser flow (requires installed Edge).
5. `npm run smoke:mcp` to re-verify exported adapter execution in a separate process.
6. Read `README.md`, `docs/RESEARCH_NOTES.md` and this file before publishing anything.

No GitHub push, deployment, marketplace submission or social posting was performed.