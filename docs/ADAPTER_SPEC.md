# Adapter spec (`anvil.adapter/v1`, `anvil.adapter/v2`)

An adapter is plain, validated JSON that describes a friendlier set of tools on top of an existing one. Each public tool declares its own input schema and how each input maps onto **one** original tool call. There is no generated code, `eval` or shell, so an adapter can be reviewed like a config file.

The same adapter runs in three places: the workbench (measured against the fixtures), the fixture MCP server (`anvil mcp --adapter-file`), and the proxy in front of a real server (`anvil proxy --adapter`).

## Top level

```json
{
  "schema": "anvil.adapter/v2",
  "domain": "calendar",
  "version": "2.0.0",
  "description": "Flat calendar tools with local times and lookups by title.",
  "limits": { "oneToOne": false, "maxTools": 12, "maxUnderlyingCallsPerInvocation": 2 },
  "tools": [ … ]
}
```

| Field | Rule |
| --- | --- |
| `schema` | `anvil.adapter/v1`, or `anvil.adapter/v2` when any tool declares a `lookup`. |
| `domain` | A lowercase id (`^[a-z][a-z0-9_-]{1,31}$`). For a proxy it is just a label. |
| `version` | Any non-empty string up to 40 characters. |
| `limits.oneToOne` | `true` when no tool has a lookup, else `false`. |
| `limits.maxUnderlyingCallsPerInvocation` | `1` without lookups, `2` with (one lookup + one target call). |
| `limits.maxTools` | 1–64, and at least the number of tools. |

## A tool

```json
{
  "name": "schedule_event",
  "description": "Create one event at a local time with a duration in minutes.",
  "inputSchema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["title", "start", "duration_minutes"],
    "properties": {
      "title": { "type": "string", "minLength": 1 },
      "start": { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$", "description": "Local time, e.g. 2026-11-03T15:30." },
      "duration_minutes": { "type": "integer", "minimum": 1, "maximum": 1440 },
      "attendees": { "type": "array", "items": { "type": "string", "format": "email" } }
    }
  },
  "target": "calendar_create_event",
  "arguments": [
    { "to": "calendar_id", "const": "primary" },
    { "to": "event.summary", "from": "title", "required": true },
    { "to": "event.start.dateTime", "from": "start", "transform": { "kind": "isoDateTime", "assumeOffset": "+05:30" }, "required": true },
    { "to": "event.start.timeZone", "const": "Asia/Kolkata" },
    { "to": "event.end.dateTime", "from": "duration_minutes", "transform": { "kind": "durationEnd", "startField": "start", "durationField": "duration_minutes", "assumeOffset": "+05:30" }, "required": true },
    { "to": "event.end.timeZone", "const": "Asia/Kolkata" },
    { "to": "event.attendees", "from": "attendees", "transform": { "kind": "wrapEmail" } }
  ]
}
```

| Field | Rule |
| --- | --- |
| `name` | `^[a-z][a-z0-9_]{1,63}$`. Must not equal another original tool's name. In proxy mode it may equal its **own** target's name, replacing that tool. |
| `description` | At least 8 characters. This is what the model reads; write it for the model. |
| `inputSchema` | An object schema with `additionalProperties: false`, at most 30 properties, nesting up to 5 levels, and no `$ref`, `anyOf`, `oneOf`, `allOf`, `not`, `if/then/else` or `patternProperties`. Every declared input must be mapped. |
| `target` | The original tool's exact name. |
| `arguments` | 1–40 mappings, below. |
| `lookup` | Optional (v2), below. |
| `notes` | Optional free text for humans. |

## Mappings

Each mapping writes one path of the original tool's input.

| Field | Meaning |
| --- | --- |
| `to` | Dot path into the original input, e.g. `event.start.dateTime`. Intermediate objects are created. Two mappings may not write the same path or a parent/child of each other. |
| `from` | Dot path into the adapted input. Exactly one of `from` or `const` (except `issueQuery`, which builds its value from parts). |
| `const` | A fixed JSON value (not `null`). |
| `default` | Used when `from` is absent. |
| `required` | Fail the call if `from` is absent. Required when the target field is required and the input is optional. |
| `valueMap` | Translate a string input, e.g. `{ "high": "P1" }`. A value not in the map is an error, never passed through. |
| `transform` | One of the transforms below, applied after `valueMap`. |

Validation checks that every `to` exists in the original schema, every required original field is produced, every declared input is consumed, and that a sample call compiles into an input the original schema accepts. At run time every compiled call is validated against the original schema again before it is sent.

### Transforms

| `kind` | Input → output |
| --- | --- |
| `identity` | Unchanged. |
| `isoDateTime` | Local `YYYY-MM-DDTHH:MM[:SS]` → RFC 3339 with the declared `assumeOffset`, e.g. `+05:30`. |
| `dayStart` / `dayEnd` | Local `YYYY-MM-DD` → start of that day / start of the next day (an exclusive bound), with offset. |
| `durationEnd` | `startField` + `durationField` minutes → end date-time, with offset. Map it to a `dateTime` field. |
| `keepDurationEnd` | v2 lookup tools only: a new local start + the matched record's own duration (`itemEnd` − `itemStart`) → new end. |
| `wrapEmail` / `unwrapEmail` | `["a@x.com"]` ↔ `[{ "email": "a@x.com" }]`, with email validation. |
| `issueQuery` | Assemble a query string from structured inputs: `parts` of `{ "literal": "is:issue" }` or `{ "input": "priority", "prefix": "priority:", "valueMap": { … } }`. Absent inputs are skipped; an empty result is an error. |

`issueQuery` is how a free-text `q` parameter becomes structured filters the model can't get wrong:

```json
{
  "to": "q",
  "transform": {
    "kind": "issueQuery",
    "parts": [
      { "input": "status", "prefix": "is:", "valueMap": { "open": "open", "closed": "closed" } },
      { "input": "priority", "prefix": "priority:" },
      { "input": "label", "prefix": "label:" },
      { "input": "text" }
    ]
  },
  "required": true
}
```

## Lookups (v2)

A lookup replaces "give me the record's id" with "name the record". The adapter makes **one** read-only call, filters the results by exact equality, and binds the matched id into the target call.

```json
"lookup": {
  "tool": "calendar_list_events",
  "arguments": [
    { "to": "calendar_id", "const": "primary" },
    { "to": "time_min", "from": "date", "transform": { "kind": "dayStart", "assumeOffset": "+05:30" }, "required": true },
    { "to": "time_max", "from": "date", "transform": { "kind": "dayEnd", "assumeOffset": "+05:30" }, "required": true },
    { "to": "max_results", "const": 50 }
  ],
  "resultsPath": "items",
  "match": [
    { "field": "summary", "from": "title", "compare": "exact" },
    { "field": "start.dateTime", "from": "start_time", "compare": "localTime" }
  ],
  "idField": "id",
  "bindTo": "event_id",
  "display": ["id", "summary", "start.dateTime", "end.dateTime", "location"]
}
```

| Field | Rule |
| --- | --- |
| `tool` | An original tool that is read-only: `readOnlyHint: true` and no write permission (fixtures), or annotated `readOnlyHint: true` by the upstream server (proxy). Must differ from `target`. |
| `arguments` | Mappings into the lookup tool's input, same rules as above. |
| `resultsPath` | Dot path to the array in the lookup result. In proxy mode the result is `structuredContent`, or the text content parsed as JSON. |
| `match` | 1–4 rules. `exact` compares trimmed, case-insensitive values. `localTime` compares an `HH:MM` input with the `HH:MM` written in an ISO date-time. A rule on an absent optional input is skipped; at least one rule must use a required input. |
| `idField` | Dot path to the id in the matched item (must be a non-empty string). |
| `bindTo` | The target input path that receives the id. It must be a string field and no mapping may write it. |
| `display` | 1–6 item fields shown to the model when zero or several items match. |

Exactly one match is required. With zero or several, the call stops, **nothing is written**, and the model gets the candidates so it can retry with a more specific input. Both calls count against budgets and are logged.

## What adapters cannot do

- Map outputs. The original result is returned unchanged.
- Call more than one lookup plus one target per public call, or compose calls.
- Use fuzzy matching, hidden ids, validators or task answers.
- Map fields whose names aren't identifiers (`a-b`, `$x`). Those can still pass through unadapted in the proxy.

## Validate and preview

- Workbench: **Interfaces** tab, paste or edit an adapter, see issues and compile previews live.
- Proxy: `anvil proxy --adapter adapter.json --dry-run -- <server command>` validates against the live upstream schemas and prints the exposed catalog.
- Workbench MCP: `anvil_validate_adapter` and `anvil_preview_mapping`.
