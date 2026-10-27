# Anvil

A local-first tool-interface workbench for open models.

Anvil asks a narrow question: **does changing the tool interface help this model complete tasks?** It runs the same fixtures, tasks, model, guidance and budgets under three interfaces:

- **Original** — raw tools with their real names, nested schemas, executors and outputs.
- **Descriptions** — identical names and schemas, with improved tool and field documentation only.
- **Adapted** — versioned JSON adapters with flat fields and bounded mappings, each compiled into exactly one original call.

Every trial ends with independent assertions over the resulting fixture state, including preservation of unrelated records. A right-looking event plus an extra wrong write fails.

**Status: local build only.** No public deployment, no installed Alan plugin, no GitHub push and no universal compatibility claim. The live numbers below are a small pilot on synthetic fixtures, not a benchmark. See `docs/BUILD_STATUS.md` for exact run IDs and limitations.

![Anvil live comparison](docs/screenshots/08-live-results-1440.png)

## Quick start

Requirements: Node.js 20.11+ (tested on Node 24), npm. A local [Ollama](https://ollama.com) install is optional and is only needed for live model runs.

```powershell
npm ci
npm run build
npm start
```

Open <http://127.0.0.1:4317>. The server binds to `127.0.0.1` by default and serves the compiled dashboard and API together.

For development with Vite hot reload:

```powershell
npm run dev
# API on 127.0.0.1:4317, dashboard on 127.0.0.1:5173
```

No API key is required to explore a simulation.

Anvil also reads an optional `.env` from the checkout; `.env.example` documents the supported variables. The UI keeps a pasted key in server memory only. Putting `ANVIL_MODEL_API_KEY` in `.env` is an explicit on-disk opt-in and is your choice; `.env` is gitignored.

## First run

1. Choose **Calendar** or **Issue tracker** and a development or sealed-evaluation split.
2. **Explore a simulation** exercises the real interfaces, adapter compiler and independent validators with a deterministic scripted policy. It is labeled everywhere and excluded from live performance claims.
3. **Run with a model** opens a live experiment:
   - **Local Ollama** uses its OpenAI-compatible `/v1` endpoint, normally `http://127.0.0.1:11434/v1`.
   - **User-supplied OpenAI-compatible endpoint** accepts any compatible base URL and model id.
   - The API key is kept in server process memory only. It is never written to `.anvil/`, logs, run records or exports, and never placed in browser storage.
4. Inspect each attempt: model turns, proposed tool input, compiled original call, tool result, independent checks, exact state diff and persisted trial JSON.
5. Edit or import an adapter on **Interfaces**, validate it, preview a compiled call without executing it, then export a runnable bundle.

## What is actually measured

Each trial records:

- exact requested and provider-reported model ids, endpoint, provider response id
- interface hashes, adapter hash, task-set version, app version
- every model turn, token usage when reported, and provider-reported cost only when present
- every tool call: public input, compiled original input, validation, result and duration
- initial and final fixture state, state diff, and every independent check
- duration and underlying tool-call counts

Attempt statuses are distinct:

| Status | Meaning |
| --- | --- |
| `pass` | Every independent check passed. |
| `fail` | Checks ran and at least one failed. |
| `invalid` | No verdict was possible, e.g. budget exhaustion, max turns, empty final output. |
| `error` | Provider, runtime or validator error. |
| `canceled` | Operator canceled the run or trial. |

A missing result is never a win. Provider cost stays `unknown` unless the endpoint reports it. The runner estimates no fake cost.

### Experiment controls

- The same model, system guidance, user task, fixture reset, temperature and budgets in all conditions.
- Per-trial wall clock, turn, underlying tool-call and token limits; run-level token and tool-call caps.
- Underlying-call budget policy: **count every attempted call to a condition tool**, including schema-invalid and adapter compile failures. Unknown tool names never reach an executor and are logged but not counted.
- One public call maps to at most one original call. Adapter composition is deliberately unsupported.
- Cancellation aborts the current model request and persists a canceled attempt.
- An unfinished run becomes `interrupted` on the next server start; completed trials remain.
- Fixture tool outputs are untrusted data. Prompt-like text inside a fixture is returned as a tool message, never appended to system guidance, and flagged in trial notes.

## Two fixture domains

The domains are realistic local examples, not claims of Google Calendar or GitHub production compatibility.

**Calendar** (`calendar-2026.10.1`, 14 tasks: 7 dev, 7 eval)
- nested event resources, RFC 3339 timestamps, required time zone, attendee objects
- create, create with attendees, reschedule, cancel, update one field, query, conditional no-op, availability conflict
- independent checks include exact event fields, no extra writes, and byte-for-byte preservation of every other event

**Issue tracker** (`issues-2026.10.2`, 12 tasks: 6 dev, 6 eval)
- two repositories, nested create/update envelopes, query syntax, priorities, labels, milestones, resolutions and comments
- create, update fields, close, reopen, assign, comment, multi-filter queries, near-duplicate distractors
- one fixture body contains an embedded instruction-like injection; it is treated as data and the runner records that it did so

Splits are genuine: the evaluation split uses different constraints and includes families absent from development (for example calendar availability and issue reopen). Validators, answers and task simulation plans are server-side and are not sent to the model.

## Architecture

```text
src/core/          schemas, adapter compiler, executor bridge, model transport,
                   runner, metrics, persistence
src/domains/       calendar and issue fixtures, raw tools, validators, tasks,
                   adapters, scripted rehearsal policies
src/server/        Express API, SSE progress, model config, exports
src/mcp/           official-SDK workbench MCP server, adapters MCP server,
                   bundle export, smoke client
web/               React/Vite workbench
tests/             adapter, domain, runner, persistence, API, MCP and plugin tests
e2e/               Playwright browser flow
plugins/anvil/     Alan marketplace package (prepared, not deployed)
.cursor-plugin/    marketplace entry for this repository
docs/              build brief, research notes, status and screenshots
```

Persistence is plain JSON under `.anvil/` (ignored by git):

- `.anvil/runs/<runId>.json` — complete run with every trial
- `.anvil/adapters/<domain>.json` — an explicitly saved adapter
- writes are atomic temp-file renames; an `apiKey` field is refused at the storage boundary

## Bounded adapter specification

Adapters are `anvil.adapter/v1` JSON. A public tool declares a JSON Schema, one original target and explicit argument mappings. Supported operations:

- rename and select nested input paths
- write nested target paths
- constants and defaults
- enum value mapping
- local date-time to a declared UTC offset (`+05:30` for this calendar fixture)
- start plus duration to end, deterministic and declared
- email wrapping/unwrapping
- bounded issue-query assembly from explicit filter parts

Rejected by validation:

- unknown targets or tools, duplicate names, name collisions with original tools
- missing target-required fields, ambiguous mappings, unconsumed declared inputs
- unsafe keys (`__proto__`, `prototype`, `constructor`), `$ref`, union/conditional schema keywords
- unsupported transforms, malformed offsets, invalid dates
- more tools or mappings than the declared/inspectable limit

Every compiled call is validated against the original JSON Schema and then executed by the same original executor, validation and permissions. Logs contain both calls. There is no `eval`, generated JavaScript, shell execution, hidden fixture lookup, composition, output remapping or access to task validators.

```powershell
# Validate and preview without saving or executing
node dist/cli.js export --domain calendar --kind bundle --out .\calendar-bundle.json
```

The workbench API and Interfaces view expose the same validation and preview operations.

## MCP and exports

The MCP implementation uses the official `@modelcontextprotocol/sdk` and stdio. Protocol output never mixes with logging; diagnostics go to stderr.

```powershell
# Workbench MCP interface
node dist/cli.js workbench-mcp

# Adapted calendar executor against the disposable fixture
node dist/cli.js mcp --domain calendar --adapter default

# A saved or exported adapter
node dist/cli.js mcp --domain issues --adapter saved
node dist/cli.js mcp --domain calendar --adapter file --adapter-file .\anvil-adapter-calendar.json
```

Workbench MCP tools:

- `anvil_list_domains`
- `anvil_list_interfaces`
- `anvil_validate_adapter`
- `anvil_preview_mapping`
- `anvil_list_experiments`
- `anvil_get_experiment`
- `anvil_start_experiment` (bounded; live requires `allowLive: true` and explicit environment configuration)
- `anvil_export_adapter`

The adapter MCP server exposes the selected interface plus `anvil_adapter_info` and `anvil_fixture_state`. Every adapted call logs the public tool, proposed input, compiled original call, mapping notes, result and duration to stderr.

Exports from the UI/API:

- run evidence JSON (`anvil-evidence-<run>.json`)
- adapter bundle (`anvil-adapter-<domain>.json`)
- adapter spec only
- MCP config template

Bundles include provenance, interface hashes, declared limits, validation and an MCP command template. They contain no API key. A downloaded bundle is runnable with `--adapter-file`; this is verified in a separate MCP client process.

### Alan status

The repository includes `plugins/anvil/.cursor-plugin/plugin.json`, `plugins/anvil/mcp.json`, a skill and a marketplace entry. **It is not installed and not deployed.**

Alan's public contribution guide, checked 26 October 2026, accepts remote HTTPS MCP servers and states that Alan does not run stdio servers yet. `plugins/anvil/mcp.json` therefore contains `https://anvil-mcp.invalid/mcp` — a reserved, non-resolving placeholder. The Integration page labels this as not live. Local stdio is for local MCP clients and is not claimed as an Alan integration.

## CLI

```text
anvil serve [--port 4317] [--host 127.0.0.1] [--data-dir .anvil]
anvil workbench-mcp
anvil mcp --domain <calendar|issues> [--condition adapted|original|descriptions]
          [--adapter default|saved|file] [--adapter-file <bundle-or-spec.json>]
anvil export --domain <calendar|issues> [--source default|saved]
             [--kind bundle|spec|mcp-config] [--out <file>] [--run-id <id>]
anvil check-mcp
anvil --help
```

## Tests and verification

```powershell
npm test            # 89 unit/integration tests
npm run typecheck
npm run build
npm run e2e         # Playwright/Edge browser flow, 1440px and 390px
npm run smoke:api   # live HTTP API smoke
npm run smoke:mcp   # exported bundle consumed by a separate MCP client
npm run check:sim   # all 78 scripted rehearsal trials across both domains
```

The browser test exercises the first-run state, simulation, results, trial drill-down, condition switching, adapter validation errors, reset, mapping preview, download filename, real MCP handshake, keyboard access, model-panel error prevention and the 390px layout.

## Model and cost controls

- only a local Ollama model or a user-supplied OpenAI-compatible endpoint is used
- no silent fallback to a proprietary/frontier provider
- no scraping of Alan authentication or assumption of an undocumented inference API
- API key in memory only; never in browser storage, logs, `.anvil/`, exports or run config
- temperature, per-completion token cap, turns, wall clock, tool-call budget and total-token cap are recorded in the run
- provider-reported cost is preserved when present and stays `unknown` otherwise
- simulations are labeled `scripted-simulation`, excluded from live eligibility, and cannot be quoted as uplift

## Live pilot (26 synthetic tasks, one open model)

Local Ollama `qwen2.5:7b`, temperature 0, one trial per task per condition, 78 matched attempts across four full-split runs (plus a 3-attempt smoke run):

| Split | Original | Descriptions | Adapted |
| --- | --- | --- | --- |
| Calendar dev (7 tasks) | 5/7 | 3/7 | 3/7 |
| Calendar eval (7 tasks) | 4/7 | 3/7 | 5/7 |
| Issues dev (6 tasks) | 5/6 | 5/6 | 6/6 |
| Issues eval (6 tasks) | 3/6 (1 invalid) | 5/6 | 6/6 |
| **All 26** | **17/26** | **16/26** | **20/26** |
| Wilson 95% (descriptive only) | 46.2–80.6% | 42.5–77.6% | 57.9–89.0% |

These intervals overlap. This is not statistical evidence of superiority. It is a small, single-model pilot on synthetic local fixtures. The failures are real model/tool behavior: wrong event ids, over-limit page sizes, wrong delete targets, ignored availability constraints, malformed nested inputs and one budget-exhausted attempt. A real failing check is shown in `docs/screenshots/09-live-failure-1440.png`. See `docs/BUILD_STATUS.md` for per-run IDs and exact counts, and `docs/evidence/live-pilot-summary.json` for a compact derived record.

## Limitations

- Synthetic fixtures; no production Google Calendar/GitHub compatibility.
- One model, one trial per task, 26 tasks; no significance claim.
- Adapter outputs are unchanged; no output mapping or composition.
- No remote HTTPS proxy, public URL, deployment or installed Alan integration.
- Local stdio only; not all OAuth-backed Alan connectors can be proxied because Alan may hold credentials outside Anvil.
- The integration page and plugin verify protocol interoperability and file preparation, not Alan installation.
- The optional open-model adapter proposal action is not implemented; adapters are authored or edited explicitly and always validated.
- No provider seed is sent: temperature is fixed at 0, but trials are not seed-reproducible across providers.

## License

MIT. See `LICENSE`.