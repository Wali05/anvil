# Local open-model test route

Verified 2026-10-26 from the local Ollama HTTP API (no credential extraction):

- Base URL: `http://localhost:11434/v1`
- Model: `qwen2.5:7b` (installed; Q4_K_M, reported 7.6B parameters)
- Other installed base models include `qwen3:8b`, `llama3.1:8b`, and `llama3.2:3b`.
- A `/v1/chat/completions` probe with temperature 0, max_tokens 128 and a `record_probe(value)` tool returned the correct structured tool call `record_probe({"value":"anvil-ready"})`.
- Provider-reported usage on that probe: 158 prompt tokens and 22 completion tokens.
- This proves the local transport and simple tool selection work. It is not an Anvil benchmark and proves no adaptation benefit.

Use the base `qwen2.5:7b` model for the first genuine three-condition smoke run. It does not require a real API key locally; if the client library requires a nonempty value, Ollama documents an ignored placeholder such as `ollama`.

Official compatibility docs: https://docs.ollama.com/api/openai-compatibility . Use a bounded timeout and visible cancellation. Keep local provider/model configuration explicit and do not overwrite the user's Alan defaults.

