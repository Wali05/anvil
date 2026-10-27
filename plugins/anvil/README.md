# Anvil plugin package

Prepared for a future Alan custom-marketplace listing. **It is not deployed and not installed.**

Alan's public contribution guide (checked 26 October 2026) accepts remote HTTPS MCP servers, not local stdio. Anvil currently ships a local stdio MCP server only.

## Status

- `mcp.json` contains `https://anvil-mcp.invalid/mcp`. The `.invalid` TLD is reserved and non-resolving on purpose: there is no public Anvil deployment yet.
- Do not submit this package as a working connector until an HTTPS MCP endpoint exists and has been probed with `initialize`, `tools/list` and a real tool call.
- A file in this repository is not an installed Alan integration.

## Local development

The real MCP servers in this checkout are stdio:

```powershell
# Anvil workbench tools: list domains/interfaces, validate adapters, run bounded experiments
node dist/cli.js workbench-mcp

# A runnable adapted calendar executor
node dist/cli.js mcp --domain calendar --adapter default

# A runnable exported adapter bundle
node dist/cli.js mcp --domain issues --adapter file --adapter-file "<bundle.json>"
```

Local MCP clients can launch these commands directly. Alan desktop support for local stdio is not claimed.

## Files

- `.cursor-plugin/plugin.json` – plugin manifest
- `mcp.json` – remote HTTPS template with a deliberately non-resolving placeholder
- `skills/anvil-workbench/SKILL.md` – agent instructions for using the workbench honestly
- `../../.cursor-plugin/marketplace.json` – marketplace entry for this repository

## Before a public listing

1. Deploy an HTTPS MCP endpoint that exposes the workbench tools.
2. Replace the placeholder URL in `mcp.json`.
3. Verify authentication requirements and a real tool call, not just discovery.
4. Run the public repository validator.
5. Update `docs/BUILD_STATUS.md` and this file with the actual deployment evidence.