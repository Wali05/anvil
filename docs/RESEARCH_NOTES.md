# Research and evidence boundaries

## Confirmed inputs

- Openfire asks for an open-source tool for people using Alan and open models. Submission requires a public repository, working link, and X demo: https://luma.com/2k6cxr0n . User supplied the event instructions.
- The relevant Alan product is https://tryalan.ai . The public plugin repository is https://github.com/tryalan-ai/plugins . Its README and CONTRIBUTING were retrieved through GitHub on 2026-10-26.
- The public plugin format supports custom marketplaces, a `.cursor-plugin` manifest, `mcp.json`, and optional skills. The contribution guide describes remote HTTPS MCP for marketplace listings, but Alan desktop also supports custom stdio MCP connectors (Command `npx`, args `-y <package>`; on Windows Command `cmd`, args `/c npx -y <package>`), so Anvil's local stdio server can be added directly.

## Prior art and differentiation

Tool description/prompt optimization already exists. Prior research found toolfit, DSPy/GEPA, and Karenina nearby; this project must not claim to invent tool optimization. The proposed focus is a transparent three-condition experiment with actual tool execution, independently checked end state, and an exported typed adapter that invokes the original capabilities. The usefulness and performance improvement remain hypotheses until measured on matched held-out tasks.

## Local build evidence

On 2026-10-26 the local build produced:

- 89 passing automated tests and a passing Playwright browser flow.
- 78 passing scripted simulation trials, explicitly labeled as rehearsals and excluded from live claims.
- A 26-task live pilot with one local open model (Ollama `qwen2.5:7b`, temperature 0, one trial per task): original 17/26, descriptions 16/26, adapted 20/26 across both domains and splits. The Wilson intervals overlap; this is not evidence of superiority.
- A verified MCP stdio handshake and exported-adapter execution in separate processes.

Exact run IDs, per-split counts and limitations are recorded in `docs/BUILD_STATUS.md`.

## Current truth

There is no measured or statistically established Anvil uplift, no public deployment, no public repository, no installed Anvil Alan plugin and no real-user adoption yet. The local pilot is a small synthetic diagnostic, not a benchmark result. Update this record only when corresponding evidence exists. A fixture benchmark, offline simulation, passing local tests, live model run, MCP client integration, Alan invocation and public deployment are separate milestones.

