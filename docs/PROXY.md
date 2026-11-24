# Init, inspect, scaffold, proxy and report

These commands put Anvil in front of an MCP server you already use. The model talks to Anvil; Anvil talks to the real server. To measure whether it helped, see [TASKS.md](TASKS.md) (`anvil eval`).

**Fastest start:** `anvil init -- <server command>` runs inspect and scaffold, states limits the schema hides, and writes `anvil/anvil.proxy.json`, `anvil/adapter.json`, `anvil/inspect.txt` and a starter `anvil/tasks.json`. It saves the upstream exactly as you typed it (so `${VAR}` stays a reference), refuses to overwrite without `--force`, and prints the next steps, including the line to add the proxy to your client.

```text
MCP client ──stdio/HTTP──▶ anvil proxy ──stdio/HTTP──▶ your MCP server
 (Claude, Cursor, …)        adapter + filter + log       (GitHub, filesystem, your own, …)
```

In every command the upstream server is given one of three ways:

| Form | Example |
| --- | --- |
| A command (stdio), after `--` | `-- npx -y @modelcontextprotocol/server-filesystem ~/Documents` |
| A URL (Streamable HTTP, falls back to SSE) | `--url https://api.githubcopilot.com/mcp/ --header 'Authorization: Bearer ${GITHUB_TOKEN}'` |
| A config file | `--config anvil.proxy.json` |
| The built-in demo | `--sample`: an awkward in-memory ticket desk and the adapter that fixes it |

`inspect` and `scaffold` also take `--tools-file tools.json` (a saved `tools/list` result) or `--domain calendar|issues` (the built-in fixtures), so they work offline and in CI.

With npx there is nothing to install: `npx -y -p github:Wali05/anvil anvil <command> …`. In a checkout: `node dist/cli.js <command> …`.

## `anvil inspect`

Lints a tool catalog for patterns that make models fail, worst tool first, with a fix for each finding.

```bash
anvil inspect -- npx -y @modelcontextprotocol/server-filesystem ~/Documents
anvil inspect --url https://example.com/mcp --json > report.json
anvil inspect --tools-file tools.json --fail-on warn        # non-zero exit for CI
```

| Rule | Severity | What it catches |
| --- | --- | --- |
| `name-not-portable` | error | Tool name outside `^[a-zA-Z0-9_-]{1,64}$`, which several model APIs require. |
| `top-level-union` | error | `anyOf` / `oneOf` / `allOf` at the root of the input schema. |
| `input-not-object` | error | Root input type is not `object`. |
| `duplicate-names` | error | Two tools differ only by case. |
| `hidden-maximum` | warn | A limit/page-size parameter has a `maximum` the description doesn't mention. Models ask for more and get a validation error. |
| `query-dialect` | warn | A free-text `q` / `query` / `filter` / `jql` parameter. Models invent syntax and then trust an empty result. |
| `opaque-id-required` | warn | A write needs an id (`*_id`, `id`, `uuid`). Models without it guess. |
| `nested-input` | warn / info | Objects two or more levels deep (`event.start.dateTime`). |
| `datetime-format-unstated` | warn | A date/time field with no format, pattern or example. |
| `params-undocumented` | warn | More than half the parameters have no description. |
| `param-union` / `param-untyped` | warn | A parameter that accepts several shapes, or has no type. |
| `description-missing` | warn | No (or a very short) tool description. |
| `too-many-tools` / `many-tools` | warn / info | More than 40 / 20 tools. Selection accuracy drops and every tool costs tokens on every turn. |
| `catalog-tokens` | warn | The catalog is over ~15k tokens. |
| `enum-unstated`, `array-of-objects`, `schema-refs`, `many-params`, `many-required`, `description-long`, `annotations-missing` | info | Smaller hazards. Shown with `--verbose`. |

The score is 100 minus 30 per error, 12 per warning and 3 per note, per tool; the catalog score is the average minus catalog-level findings. It is a triage aid, not a benchmark. To measure whether a change helps, use the workbench.

## `anvil scaffold`

Writes a starter `anvil.adapter/v1`: each selected tool becomes an adapted tool of the same name (snake_case) whose inputs are the leaf fields of its nested schema, mapped back to their original paths.

```bash
anvil scaffold --out adapter.json -- <server command>            # every tool with nested object inputs
anvil scaffold --tools create_event,update_event --out adapter.json -- <server command>
```

- Field names are the shortest unique snake_case suffix of the path (`event.start.dateTime` → `start_date_time`).
- A field is required only if it and every parent object are required.
- A numeric `maximum` the description doesn't state is added to the description.
- Tools whose required fields can't be expressed (non-identifier keys, unions) are skipped with a note. Optional fields that can't be expressed are left out, also with a note.
- The result is validated against the upstream schemas before it is written.

The scaffold is a starting point. The adapter features that help most are the ones a human adds: enum `valueMap`s, `default`s for values the model shouldn't pick, local-time → RFC 3339 transforms, and a `lookup` that replaces a required id with a name. See [ADAPTER_SPEC.md](ADAPTER_SPEC.md).

## `anvil proxy`

Serves the upstream's tools, adapted, filtered, re-described and output-shaped, over stdio (default) or HTTP.

```bash
anvil proxy --adapter adapter.json --log-file calls.jsonl -- <server command>
anvil proxy --config anvil.proxy.json
anvil proxy --config anvil.proxy.json --dry-run        # print the exposed catalog and exit
anvil proxy --config anvil.proxy.json --http 8808      # http://127.0.0.1:8808/mcp
anvil proxy --sample                                    # the demo desk, adapted
```

What the client sees:

1. **Adapted tools** from the adapter. Each is validated at start-up against the live upstream schemas; the proxy refuses to start if the adapter doesn't fit. Adapted tools inherit their target's `readOnlyHint` / `destructiveHint` annotations.
2. **Passthrough tools**: every other upstream tool, unchanged, except that
   - an adapted tool's target is hidden, so the model isn't offered both the hard and the easy version of one call (`--keep-targets` to keep it),
   - `--include` / `--exclude` (comma-separated, repeatable, `*` globs) filter them; exclude wins,
   - `tools.overrides` can give one a clearer name, a description, or an output shape,
   - `--passthrough none` exposes adapted tools only.
3. Optionally `anvil_proxy_info` (`--info-tool` or `tools.infoTool`): the adapter, and which tools are exposed and hidden. Off by default, since every tool costs prompt tokens.

Calls to adapted tools run: validate the arguments → optional read-only lookup (exactly one match, else nothing is written and the candidates are returned) → compile → validate against the original schema → one upstream call. The upstream's result (`content`, `structuredContent`, `isError`) is returned as is, unless an output shape applies. Passthrough calls are forwarded as is.

### Output shaping

Real APIs return far more than a model needs. A GitHub issue has around 200 fields, and every extra field is paid for again on every later turn and gives the model more to misread. An output shape trims a successful result before the model sees it:

```json
"output": { "pick": ["total_count", "items[].number", "items[].title", "items[].state", "items[].labels[].name"], "maxItems": 20, "maxChars": 8000 }
```

- `pick` keeps only these dot paths. `key[]` maps over an array, and a leading `[]` maps over a result that is itself an array. Absent paths are skipped, never invented.
- `maxItems` caps every array.
- `maxChars` caps the text.

Put it on an adapted tool (`output` in the adapter) or on any passed-through tool (`tools.overrides.<tool>.output`). Whenever something is cut, the model gets a second text block saying so ("items: showing 20 of 134 items… narrow the request to see the rest"), so it never mistakes a truncated list for a complete one. Errors are never shaped. A shaped passthrough tool stops advertising the upstream's `outputSchema`, because the trimmed result no longer matches it. `anvil report` shows tokens per result and suggests a shape for tools that return a lot.

### Config file (`anvil.proxy/v1`)

```json
{
  "schema": "anvil.proxy/v1",
  "name": "github-via-anvil",
  "upstream": {
    "url": "https://api.githubcopilot.com/mcp/",
    "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" }
  },
  "adapter": "./github.adapter.json",
  "tools": {
    "passthrough": "all",
    "include": ["*issue*", "get_me"],
    "exclude": ["delete_*"],
    "keepTargets": false,
    "overrides": {
      "search_issues": { "description": "Search issues and pull requests. Say which repository in the query." }
    }
  },
  "log": { "file": "./calls.jsonl", "includeArguments": false }
}
```

| Field | Meaning |
| --- | --- |
| `upstream.command`, `args`, `env`, `cwd` | A stdio server. `cwd` is relative to the config file. |
| `upstream.url`, `headers`, `transport` | An HTTP server. `transport` is `auto` (default: Streamable HTTP, then SSE), `streamable-http` or `sse`. |
| `adapter` | An adapter object, or a path to an adapter spec or exported bundle, relative to the config file. |
| `tools.*` | As described above, plus `infoTool` (boolean). `overrides.<tool>` takes `name`, `description` and `output`. |
| `log.file` | Append one JSON line per call (relative to the config file). Lines also go to stderr. |
| `log.includeArguments` | Also log the model's arguments and the compiled original input. Off by default because arguments can contain personal data. |

Command-line flags override the file: `--adapter`, `--name`, `--passthrough`, `--include`, `--exclude`, `--keep-targets`, `--log-file`, `--log-args`.

**Secrets.** Write `${VAR}` (or `${VAR:-default}`) in `url`, `headers`, `command`, `args` and `env`; the value is read from the environment at start-up. A referenced variable that isn't set is an error, not an empty string. Header values are never logged. On the command line, single-quote the value (`--header 'Authorization: Bearer ${GITHUB_TOKEN}'`) so Anvil expands it rather than your shell, and the token never appears in the process list.

### HTTP serving

`--http <port>` serves Streamable HTTP at `/mcp` (`--path` to change) in stateless mode, plus `GET /healthz`. It binds `127.0.0.1` with DNS-rebinding protection. Binding another `--host` requires `ANVIL_HTTP_TOKEN`; clients must then send `Authorization: Bearer <token>`.

### Adding the proxy to a client

The proxy is just a stdio MCP server, so it goes wherever a server command goes. Claude Code:

```bash
claude mcp add files -- npx -y -p github:Wali05/anvil anvil proxy --config /abs/path/anvil.proxy.json
```

Claude Desktop, Cursor, Windsurf (`mcpServers`) or VS Code (`servers`, with `"type": "stdio"`):

```json
{
  "mcpServers": {
    "files": {
      "command": "npx",
      "args": ["-y", "-p", "github:Wali05/anvil", "anvil", "proxy", "--config", "/abs/path/anvil.proxy.json"]
    }
  }
}
```

Use absolute paths: clients start servers from their own working directory. Clients also pass a reduced environment to servers, so put variables the upstream needs in `upstream.env` (as `${VAR}` references if they're secrets, and set them in the client's `env` block).

## `anvil report`

Summarizes a proxy log: per tool, how many calls failed, at which stage, and the most common error shapes (ids, numbers, quoted values and paths collapsed so the same mistake groups together).

```bash
anvil report calls.jsonl
anvil report calls.jsonl --json
```

Stages: `input` (the arguments broke the public schema, or the tool doesn't exist / is hidden), `adapter` (couldn't compile), `lookup` (zero or several matches), `upstream` (the server returned an error). Each tool with a failure rate of 25% or more over at least 3 calls gets a suggestion, and so does each tool whose median result is over ~2,000 tokens.

Each log line records the public tool, its kind and target, the outcome and stage, the lookup (`tool`, `matchedId`, `matchCount`), the original call that reached the upstream (`originalCall`, or `null` when nothing did), result sizes before and after shaping, and timing. Arguments and the compiled input are added only with `--log-args` / `log.includeArguments`.

## `anvil-mcp-proxy`

The earlier stdio entry point is kept for its flags, and runs on the same engine:

```bash
anvil-mcp-proxy --sample
anvil-mcp-proxy --upstream-command node --upstream-arg ./my-server.js --adapter-file adapter.json
```

It exposes adapted tools only, adds `anvil_proxy_info`, and logs arguments and the compiled call to stderr. Everything else in this guide needs `anvil proxy`.

## Limits

- Outputs can be trimmed (pick, cap, truncate) but not renamed or restructured.
- One adapted call makes at most one lookup call and one target call. No general composition.
- Paths in mappings must be identifiers (`a.b_c`); upstream fields with other characters can't be mapped (they still pass through).
- Lookups only call tools the upstream annotates `readOnlyHint: true`.
- Resources and prompts of the upstream are not proxied, only tools.
- Hiding a tool limits what the model is offered; it is not a security boundary for the upstream server itself.
