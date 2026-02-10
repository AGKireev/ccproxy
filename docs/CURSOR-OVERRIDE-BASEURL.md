# Cursor IDE — Override OpenAI Base URL: External Facts

> **Scope**: Facts sourced exclusively from external documentation, reverse engineering projects, official Cursor publications, and community-built proxy projects. No speculation, no CCProxy test results.

---

## Sources

| Source | URL | Type |
|--------|-----|------|
| TensorZero reverse engineering | https://tensorzero.com/blog/reverse-engineering-cursors-llm-client/ | Reverse engineering (June 2025) |
| Roman Imankulov "Under the Hood" | https://roman.pt/posts/cursor-under-the-hood/ | Reverse engineering (Feb 2025) |
| cursor-openrouter-proxy | https://github.com/pezzos/cursor-openrouter-proxy | Community proxy project |
| CursorCustomModels | https://github.com/rinadelph/CursorCustomModels | Community proxy project |
| LiteLLM Cursor integration | https://docs.litellm.ai/docs/tutorials/cursor_integration | Integration guide |
| Cursor Forum (multiple threads) | https://forum.cursor.com | Community reports |
| Cursor Settings Guide | https://www.cursor-ide.com/blog/cursor-custom-api-key-guide-2025 | Guide (2025) |

---

## 1. What Override OpenAI Base URL Does

The "Override OpenAI Base URL" option in Cursor Settings → Models allows replacing OpenAI's default API endpoint with a custom one. When enabled, Cursor sends `/v1/chat/completions` requests to the specified URL instead of OpenAI's servers.

The endpoint must be **OpenAI API-compatible**, supporting:
- `POST /v1/chat/completions` endpoint
- Standard OpenAI request/response JSON format
- Streaming responses (`text/event-stream` SSE)
- Tool/function calling

*Source: pezzos/cursor-openrouter-proxy, rinadelph/CursorCustomModels, cursor-ide.com guide*

---

## 2. Request Routing: Requests Go Through Cursor's Servers

Even with Override OpenAI Base URL enabled, chat requests do **not** go directly from the IDE to your endpoint. They are routed through Cursor's backend servers.

**Evidence**:
- TensorZero could not connect to a locally-running gateway: *"Cursor was initially unable to connect to TensorZero running locally. It turns out that Cursor first sends a request to its own servers, where additional processing happens before making the LLM call."*
- The TensorZero solution required exposing the gateway via Ngrok (public URL) because Cursor's servers needed to reach it.
- Forum reports confirm that even local model endpoints (e.g., Ollama on localhost) fail because Cursor's servers cannot reach `localhost`.

**Exception**: The initial CORS preflight (`OPTIONS` request) comes directly from the Electron app to verify the endpoint is reachable. All subsequent chat requests come from Cursor's backend.

*Source: TensorZero blog, Cursor forum thread "Problem reaching OpenAI error on a local model"*

---

## 3. What Cursor Sends (Override Base URL, Ask Mode)

Roman Imankulov captured the exact request structure by routing through ngrok to OpenAI:

### Three messages per request:

1. **System message** — Static system prompt (see CURSOR-INTERNALS.md)
2. **User message #1** — Custom instructions (`.cursorrules` + `.cursor/rules/` descriptions)
3. **User message #2** — User query wrapped in structured tags with context:
   - `<<current_file>>` — Active file path, line number, line content
   - `<<attached_files>>` — Full contents of explicitly attached files (`@file`)
   - `<<manually_added_selection>>` — User-selected code blocks
   - `<<linter_errors>>` — Active lint errors in open files
   - `<<user_query>>` — The user's actual typed query

*Source: Roman Imankulov "Under the Hood", TensorZero blog*

---

## 4. What Cursor Sends (Override Base URL, Agent Mode)

Agent mode requests include the same structure plus:

### Tool definitions

Cursor sends tool definitions alongside the messages. The following tools are provided:

`codebase_search`, `read_file`, `run_terminal_cmd`, `list_dir`, `grep_search`, `edit_file`, `file_search`, `delete_file`, `reapply`, `fetch_rules`, `diff_history`

See CURSOR-INTERNALS.md for full tool descriptions.

*Source: Roman Imankulov, Shrivu Shankar*

### Multi-turn conversation

In Agent mode, the conversation is multi-turn. Cursor:
1. Sends user query + tool definitions
2. Model responds with tool calls
3. Cursor executes tools locally, sends results back
4. Model responds with more tool calls or a final answer
5. Repeat until the model produces a user-facing response

Each turn sends the **full conversation history** accumulated so far.

*Source: Shrivu Shankar "How Cursor Works" (diagram and explanation)*

---

## 5. Feature Availability with Custom API Keys

Custom API keys (including Override Base URL) have significant feature restrictions.

### Features that work:
- CMD+K / CTRL+K (inline edit)
- AI Chat (Ask mode)
- Agent mode (with Cursor Pro subscription active)

### Features that do NOT work with custom API keys alone:
- Tab Completion (Cursor Tab) — requires Cursor's proprietary model
- Apply from Chat — requires Cursor's proprietary apply model
- Composer — requires Cursor's proprietary models

### With active Cursor Pro subscription + custom API key:
- All features work
- Custom API key is used for chat/agent, Cursor's models for Tab/Apply/Composer

### Without Cursor Pro subscription (custom key only):
- Only CMD+K and AI Chat work
- Composer, Apply Code, Cursor Tab are unavailable

*Source: Cursor forum threads "API Keys work on which models/actions?", "BYOK Bring your Own Key", "Please clarify the Custom API Keys dialog"*

---

## 6. API Key Handling

- API keys are sent to Cursor's server with each request
- Cursor states they are **not permanently stored**
- Keys are routed through Cursor's backend "for prompt optimization"
- Even with "privacy mode" enabled, keys transit Cursor's infrastructure

*Source: cursor-ide.com guide ("Your API key is sent with each request but not permanently stored"), TensorZero blog ("your credentials must be forwarded to Cursor's servers"), Cursor forum "local mode is misleading"*

---

## 7. Known Issues with Override Base URL

### Cannot use Cursor Pro models simultaneously

Enabling Override OpenAI Base URL may prevent access to Cursor Pro's built-in models (Claude, Gemini via Cursor). Users report having to choose between custom endpoint and built-in models.

*Source: Cursor forum "Cannot use any models if OpenAI base URL overridden"*

### Requests fail for some providers

Pointing Override Base URL to OpenRouter directly causes failures. Community proxy projects exist specifically to work around this (cursor-openrouter-proxy, CursorCustomModels).

*Source: Cursor forum "Override OpenAI Base URL breaks requests when pointing to OpenRouter"*

### "Verify" button works but chat does not

The "Verify API Key" button in settings connects directly from the Electron app to your endpoint (and works). However, actual chat requests fail because they route through Cursor's servers, which may not be able to reach the same endpoint.

*Source: Cursor forum "Problem reaching OpenAI error on a local model"*

---

## 8. Community Proxy Projects

Several open-source projects exist to bridge Cursor's Override Base URL to various LLM providers:

| Project | Language | Providers | Notes |
|---------|----------|-----------|-------|
| [pezzos/cursor-openrouter-proxy](https://github.com/pezzos/cursor-openrouter-proxy) | Docker | OpenRouter | Translates Cursor → OpenRouter; user selects GPT-4o in Cursor but routes to any model |
| [rinadelph/CursorCustomModels](https://github.com/rinadelph/CursorCustomModels) | Node.js | Claude, Gemini, Groq, Ollama, DeepSeek, Mistral | Multi-provider support |
| [LiteLLM](https://docs.litellm.ai/docs/tutorials/cursor_integration) | Python | 100+ providers | General-purpose LLM proxy with Cursor integration guide |
| [TensorZero](https://github.com/tensorzero/tensorzero/tree/main/examples/integrations/cursor) | Rust | Any OpenAI-compatible | Observability + experimentation platform with Cursor example |

### Common proxy architecture pattern:

```
Cursor IDE → Cursor Servers → Ngrok/Cloudflare Tunnel → Your Proxy → LLM Provider
```

All community projects confirm the need for a publicly accessible endpoint (not localhost).

*Source: Respective GitHub repositories*

---

## 9. TensorZero Experiment Results

TensorZero successfully ran an A/B test across four models through Cursor for "days of heavy software engineering":

- **Models tested**: Claude 4.0 Sonnet, GPT-4.1, o4 Mini, Gemini 2.5 Pro (even random split)
- **Result**: "It feels as good as Cursor ever has"
- **Stability**: "Stable and there has been no noticeable additional latency"

They confirmed that Cursor's full experience (Ask, Agent, Cmd+K) works through an external proxy, while Tab completions continue using Cursor's proprietary model.

*Source: TensorZero blog*

---

## 10. OpenAI Responses API Format (`input` field)

Some Cursor versions send requests using the OpenAI **Responses API** format (using an `input` field) rather than the Chat Completions API format (using `messages`). Proxy implementations must handle both formats.

*Source: Cursor GitHub issues #1289, community proxy implementations*
