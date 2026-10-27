# Anvil plugin package

Prepared for an Alan custom-marketplace listing. **It is not deployed and not installed.**

Alan desktop supports custom stdio MCP connectors, so the package points at Anvil's local stdio adapter server, launched with npx. There is no hosted HTTPS endpoint.

## Status

- `mcp.json` runs `npx -y -p github:Wali05/anvil anvil-mcp --domain calendar` (stdio). Use `--domain issues` for the issue tracker. The `github:` spec only resolves once the repository is public.
- Earlier drafts used a non-resolving `anvil-mcp.invalid` placeholder URL; that is gone.
- To add it by hand in Alan desktop: Command `npx`, args `-y -p github:Wali05/anvil anvil-mcp --domain calendar`. On Windows: Command `cmd`, args `/c npx -y -p github:Wali05/anvil anvil-mcp --domain calendar`.
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

Local MCP clients, including Alan desktop custom connectors, can launch these commands directly.

## Files

- `.cursor-plugin/plugin.json` – plugin manifest
- `mcp.json` – stdio launch config (npx)
- `skills/anvil-workbench/SKILL.md` – agent instructions for using the workbench honestly
- `../../.cursor-plugin/marketplace.json` – marketplace entry for this repository

## Before a public listing

1. Make the repository public so `github:Wali05/anvil` resolves.
2. Add the connector in Alan desktop and verify `tools/list` and a real tool call, not just discovery.
3. Check whether the marketplace listing accepts stdio or still needs a hosted HTTPS endpoint.
4. Run the public repository validator.
5. Update `docs/BUILD_STATUS.md` and this file with the actual deployment evidence.