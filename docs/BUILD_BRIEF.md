# Anvil — build brief

## Product

Build a useful, open-source tool-interface workbench for people using Alan and open models. Anvil asks: does changing a tool interface actually help this model complete tasks? It compares the original tools, descriptions-only improvements, and executable adapters, using independent checks of the resulting state. It exports the adapter that was tested.

This is an implementation brief, not evidence of performance. Do not display invented model scores, costs, traces, quotes, user counts, or benchmark improvements. We can ship a valuable diagnostic even if the adapted interface does not win.

Working directory: `C:\Users\user\Desktop\Anvil`. Build here. Windows / PowerShell. Git, Node, npm, Python are installed. Keep all work local until the user approves publication. Do not push, deploy, post, or change global model/settings defaults.

## Constraints

- Product inference must support open models. Never silently fall back to a proprietary/frontier provider.
- Do not read private credential stores, scrape Alan authentication, or assume an undocumented Alan inference API. Use a user-supplied OpenAI-compatible endpoint/key, public tools through supported Alan connections, or an installed local Ollama model if one is available.
- No real calendar or issue writes in default experiments. The benchmark uses deterministic, explicitly labeled local fixtures.
- Two domains: calendar and issue tracker. These are realistic example connectors, not a claim of Google Calendar/GitHub production API compatibility.
- A saved run is a replay. A scripted demonstration is a simulation. Neither may be labeled a live model benchmark.
- No universal compatibility claims; list supported adapters and transformations precisely.

## The first deliverable

A working local end-to-end application, not a landing-page mockup: configure an open model, select a domain and task split, run the three conditions, inspect every model/tool turn and the final state checks, compare outcomes, inspect the adapter, export it, and invoke its MCP tools in a separate client. Runs persist across server restarts. Failed/canceled/invalid attempts remain visible.

Build a robust vertical slice first, then complete the second domain and export/integration. Keep `docs/BUILD_STATUS.md` current with commands, verification, remaining work, and honest limitations. Read this brief, make a short plan, then implement; do not stop after planning or scaffolding.

## Core architecture

Use a modest local-first TypeScript application: Node service, React/Vite dashboard, a reusable core package, and the official MCP SDK for server/client interoperability. Use maintained dependencies and a lockfile. Prefer a small explicit module structure over a large monorepo framework. Bind locally by default. A separate production build should serve the compiled dashboard and API together. Provide a cross-platform CLI, an MIT license, .gitignore, .env.example without secrets, and a clean README.

Suggested boundaries (choose a sensible exact layout):

- `src/core/`: schemas, adapter interpreter, tool execution, model transport, experiment runner, metrics, persistence.
- `src/domains/`: raw schemas, tool implementation, resettable fixture state, tasks and independent outcome validators.
- `src/server/`: HTTP API, SSE run updates, model configuration, safe exports.
- `src/mcp/`: standard MCP server exposing selected raw or adapted tools and an Anvil workbench MCP interface.
- `web/`: accessible dashboard and its styles.
- `tests/`: meaningful boundary, integration, evaluator, runner and MCP tests.
- `plugins/anvil/` and `.cursor-plugin/`: Alan marketplace package after validating the public format.
- `data/` or `.anvil/`: ignored local runs/config; no API keys persisted by default.

## Executable adapters, not arbitrary code generation

Define a small versioned JSON adapter specification. An adapter has a public tool name/description/JSON Schema, a referenced original tool, and explicit field mapping rules. Support useful bounded operations such as rename, select a JSON path, nest/unwrap, enum mapping, and explicit constant/default values. A deterministic timestamp-plus-duration transform is acceptable if rigorously tested and declared. Reject unsupported operations, invalid references, invalid schemas, unsafe object keys, ambiguous required inputs, and duplicate names. No `eval`, arbitrary JS, shell execution, hidden credentials, or access to task answers.

Every adapted call must compile to a valid original call and run through exactly the same original executor, validation and permissions. Log both calls. Do not quietly repair a user's target, infer hidden IDs from fixtures, or do extra work for the adapted condition. If composition is supported, count every underlying call against the same budget; otherwise explicitly support one-to-one mappings only. Make the limits inspectable in the UI/export.

The descriptions-only condition changes names? NO: preserve original tool names, parameter schema, outputs, executor and permissions. Change tool and field descriptions only. Test schema equivalence after stripping description fields.

For a useful user-owned-tool path, accept an original tool catalog plus an adapter JSON in the workbench, validate/preview mappings, and export a runnable MCP adapter. Include at least one actual MCP upstream/client path (stdio for local development is fine) with a user-owned sample server. Do not pretend every OAuth-backed Alan plugin can be proxied: Alan may hold credentials outside Anvil. A remote proxy should support explicitly configured endpoints/headers via environment variables, never hard-coded keys.

An optional open-model proposal action can produce an adapter from tool definitions and development failures. Treat proposals as untrusted data, compile/validate before use, and require review. Do not send held-out tasks, answers or validators to the proposal model. This action is desirable after the measured runner works; do not replace executable adapters with generic chatbot text.

## Honest experiments

Conditions: `original`, `descriptions`, `adapted`. Same model, system guidance, user task, fixture, temperature, max model turns, max tokens per completion and total underlying tool-call budget. Tool interface differences are the experimental variable. Reset state before every trial. Persist config, timestamps, exact model ID, interface/source hashes, task-set version, task ID/family/split, trial seed where supported, tool transcripts, raw invocation mapping, latency, tokens, provider-reported cost if available, initial/final state and checker details.

Important: no random success generator or hard-coded success percentage. A scripted executor may exercise the engine offline but the result must be marked `simulation` throughout, excluded from model performance summaries. Empty real evidence is a valid first-run state.

- At least 20 thoughtfully designed tasks across two domains, with genuine held-out families, not only entity-name paraphrases. E.g. calendar create/reschedule/cancel/query, and issue create/update/query/close with realistic constraints and distracting records.
- Make a development split for adapter iteration and a distinct sealed evaluation split. Don't expose task solutions/state validators to model inputs. Explain residual limitations of synthetic local tasks and a small sample.
- Independent executable state assertions check the intended change AND preservation of unrelated records. Queries need an explicit verifiable output contract. Creating the wrong event plus the right event must fail when an extra write violates the task.
- Pass/fail/invalid/error/canceled must be different. Provider errors, no tool support, malformed model output, budget exhaustion, retries and tool validation errors are surfaced; never count a missing result as a win or silently omit it.
- Prompt injection inside tool outputs/fixtures must not become runner/system instructions.
- Parse multiple tool calls correctly. Count underlying tool calls, including invalid attempts if budget policy says so; apply consistently. No infinite loops. Use timeouts, cancellation and per-run/token/cost caps. Estimate cost separately from observed provider cost; unknown is unknown.
- Persist each completed trial promptly. When a process dies, an incomplete run becomes interrupted rather than hanging forever.
- Report numerator/denominator and paired differences on the same tasks. Show uncertainty where mathematically justified and don't claim statistical superiority on a tiny pilot. Never compare a development run against held-out results as though equivalent.

The smallest live test is one task in each condition. The useful pilot is 20+ matched tasks. Run only against an actually available open-model endpoint. If credentials/inference are unavailable, complete everything testable offline and clearly identify the exact missing live step. Never fabricate evidence to fill the dashboard.

## Dashboard and interaction design

Make this feel like a carefully designed tool laboratory: warm off-white canvas, near-black text, restrained orange/copper accent, precise monospace labels, thin rules, strong typography, crisp custom SVG anvil mark. Avoid a generic gradient SaaS landing page and decorative fake charts. The main screen is the workbench.

Desktop: compact navigation rail, project/domain header, model/status control and prominent `Run experiment`; a clear three-condition comparison; task/result list; selected task's trace with model calls, adapter mapping, raw tool input and independent assertions. Provide tabs/views for Experiments, Tool interfaces, and Integration. A model/setup panel should make the first run understandable without reading source code.

Required interactions:

1. Start at an honest empty state with a short workflow. Offer `Explore a simulation` distinctly from `Run with a model`.
2. Configure endpoint/model locally; API key is sent only to the configured server/provider, kept in memory unless explicitly opted into storage. Never include keys in logs/exports. The UI must not place keys in localStorage.
3. Pick domain, split, tasks/trials and bounded budget; see expected call count before starting. Show running progress and Stop.
4. Drill into a failed or successful attempt; inspect both the proposed tool input and the actual original call, state diff and independent checks. Allow condition switching on the same task.
5. Inspect exact original/descriptions/adapted tool schemas; edit/import and validate a bounded adapter spec; surface errors next to the input.
6. Export a runnable adapter bundle/config + evidence JSON with explicit provenance. Downloads need correct MIME/name and must work in the browser.
7. Integration page: clear Alan/MCP setup, real health status, no fake Connected label. Provide a copyable command for local stdio clients and remote HTTPS marketplace instructions with deployment placeholder clearly identified.

Keyboard usable, semantic buttons/inputs, clear focus, no hover-only actions, readable at 390px and 1440px, reasonable loading/error/empty states and contrast. Avoid tiny text and a giant hero taking space away from the actual data. Prefer real tables and useful diagrams over ornamental cards.

## Alan integration

Public source checked: https://github.com/tryalan-ai/plugins/blob/main/CONTRIBUTING.md . It uses `.cursor-plugin/marketplace.json`, `plugins/anvil/.cursor-plugin/plugin.json`, optional `skills/<skill>/SKILL.md`, and `mcp.json`. Public contribution docs currently say HTTPS remote MCP only. The installed UI may also offer custom local Command connectors; verify before claiming.

Provide a genuine Anvil MCP interface Alan can use to list supported domains/interfaces, validate an adapter and examine/run bounded experiments. Keep expensive runs and external writes explicit. MCP protocol messages on stdout must not mix with logging. Prefer official SDK transports over a hand-rolled incomplete protocol.

Package the plugin and skill so a future public HTTPS deployment can be added to Alan's custom marketplace. No public URL exists yet: leave installation/deployment status honest. Independently test a real MCP client listing and invoking tools against the packaged server. Actual Alan installation requires its supported transport and UI confirmation; a file alone is not an installed integration.

## Definition of done for the local build

- `npm install`/`npm ci`, tests, type checking and production build succeed.
- One documented command starts a usable app with persisted experiments.
- Real original/descriptions/adapted execution on both fixture domains; independent failure detection and invariants tested.
- Adapter validation and mapping work; exported artifact is executable in a separate process.
- MCP client smoke test succeeds; no claim that file existence equals Alan installation.
- Browser flow actually exercised: initial view, simulation, results drill-down, mapping edit/validation, export, error state and narrow layout. No fake evidence, dead controls, build errors or broken overflow.
- Live-model evidence present if a sanctioned open-model endpoint is available; otherwise explicitly pending without pretending simulation proves uplift.
- README covers setup, what the product does, its limits, architecture, test commands, model/provider config, cost controls and Alan integration.
- Keep an exact status/handoff file. No GitHub push, deployment, or social posting in this local implementation pass.

