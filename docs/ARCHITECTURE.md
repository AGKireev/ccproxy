# CCProxy — Architecture

## Overview

CCProxy is a Bun-based HTTP proxy that sits between **Cursor IDE** and the **Anthropic API**. It authenticates via **Claude Code OAuth** (your Claude Code subscription), translates between OpenAI and Anthropic message formats, and injects **server-side compaction** to prevent sessions from breaking when the 200K OAuth context limit is reached.

```
Cursor IDE
  │
  │  OpenAI format (/v1/chat/completions)
  │  or Anthropic format (/v1/messages)
  ▼
┌─────────────────────────────────────────────┐
│              CCProxy (port 8082)            │
│                                             │
│  1. Parse & log request                     │
│  2. Convert OpenAI → Anthropic (if needed)  │
│  3. Inject compaction edit (Opus 4.6)       │
│  4. Append compaction beta header           │
│  5. Proxy via Claude Code OAuth             │
│     └── fallback to direct API key          │
│  6. Convert Anthropic → OpenAI (if needed)  │
│  7. Stream response back to Cursor          │
└─────────────────────────────────────────────┘
  │
  ▼
Anthropic API (api.anthropic.com)
  - Claude Code OAuth (subscription, free)
  - Direct API key (paid fallback)
```

## Module Map

```
ccproxy/
├── index.ts                      # Entrypoint — starts server, prints banner
├── package.json                  # Bun project config
├── .env                          # Local environment (gitignored)
├── .env.example                  # Documented env template
├── cloudflared-config.yml        # Cloudflare tunnel config (gitignored)
├── start-proxy.ps1               # Windows launcher (gitignored)
├── start-proxy.sh                # macOS/Linux launcher (gitignored)
│
├── src/
│   ├── server.ts                 # HTTP server, routing, CORS, IP whitelist
│   ├── config.ts                 # Configuration, constants, beta headers
│   ├── types.ts                  # TypeScript interfaces
│   ├── anthropic-client.ts       # Proxy engine — OAuth + API key fallback
│   ├── oauth.ts                  # OAuth token management, file locking
│   ├── openai-adapter.ts         # OpenAI↔Anthropic format conversion + compaction
│   ├── streaming.ts              # Anthropic SSE → OpenAI SSE transformation
│   ├── token-counter.ts          # Character-based token estimation
│   ├── openai-passthrough.ts     # Non-Claude model passthrough to OpenAI/OpenRouter
│   ├── tool-call-translator.ts   # XML tool call format normalization
│   ├── logger.ts                 # File-based verbose logger
│   │
│   ├── routes/
│   │   ├── openai.ts             # /v1/chat/completions handler
│   │   ├── anthropic.ts          # /v1/messages handler
│   │   └── models.ts             # /v1/models handler
│   │
│   └── test-context-strategy.ts  # Standalone test script (see TESTING.md)
│
└── docs/
    ├── ARCHITECTURE.md           # This file
    ├── COMPACTION.md             # Compaction deep-dive
    ├── TESTING.md                # Test results and methodology
    ├── CONFIGURATION.md          # All config options
    ├── CHANGELOG.md              # Change history
    ├── ISSUES.md                 # All issues encountered, root causes, fixes
    └── HYPOTHESIS.md             # Hypotheses tested, decisions made
```

## Request Flow — OpenAI Path (Cursor's Primary Path)

This is the path used by Cursor when configured with the proxy's base URL.

### 1. `server.ts` — `startServer()`

- Bun.serve() on port 8082 with 255s idle timeout
- CORS preflight handling
- IP whitelist check (CF-Connecting-IP for tunnel requests)
- Routes POST `/v1/chat/completions` → `handleOpenAIRequest()`

### 2. `routes/openai.ts` — `handleOpenAIRequest()`

- Parses the OpenAI-format request body
- Normalizes `input` field (OpenAI Responses API) to `messages` (Chat Completions)
- Checks if model should passthrough to OpenAI/OpenRouter (non-Claude models)
- Calls `openaiToAnthropic()` to convert the request
- Calls `normalizeModelName()` to extract `minorVersion`
- Calls `injectCompaction()` to add compaction edit (Opus 4.6+ only)
- Appends compaction beta header to `anthropic-beta` if needed
- Estimates token count via `countTokens()`
- Calls `proxyRequest()` to send to Anthropic API
- For streaming: wraps response in `createAnthropicToOpenAIStream()`
- For non-streaming: calls `handleNonStreamingResponse()`

### 3. `openai-adapter.ts` — `openaiToAnthropic()`

Key transformations:

- System messages → `system` field (string or ContentBlock array)
- Model name normalization: `claude-4.6-opus-high` → `claude-opus-4-6`
- Extended thinking: Opus 4.6 gets `{ type: "adaptive" }`, older gets `{ type: "enabled", budget_tokens: N }`
- Tool format normalization: OpenAI nested → Anthropic flat
- Context management passthrough from Cursor
- Message deduplication (removes duplicate text blocks in user messages)
- Message alternation enforcement (Anthropic requires user/assistant alternation)

### 4. `openai-adapter.ts` — `injectCompaction()`

- Only activates for Opus 4.6+ models (`minorVersion >= 6`)
- Only if `compactionEnabled` is true (default)
- Checks if Cursor already sends compaction (future-proofing)
- Appends `compact_20260112` edit with configurable trigger threshold
- Sorts edits to API-required order: `clear_thinking → clear_tool_uses → compact`
- Returns the beta header string to append

### 5. `anthropic-client.ts` — `proxyRequest()`

Two-tier request strategy:

1. **Claude Code OAuth** (primary): `makeClaudeCodeRequestWithOAuth()`
   - Gets valid OAuth token (auto-refreshes if expired)
   - Prepends required Claude Code system prompt
   - Merges beta headers (Cursor's + Claude Code required + compaction)
   - Handles 429 (rate limit with caching), 401 (expired), 403 (denied), 400 (errors)
2. **Direct API key** (fallback): `makeDirectApiRequest()`
   - Uses user-provided API key or configured `ANTHROPIC_API_KEY`
   - No system prompt modification
   - Direct beta header passthrough

### 6. `streaming.ts` — `createAnthropicToOpenAIStream()`

Transforms Anthropic SSE events to OpenAI SSE format:

- `message_start` → OpenAI stream start chunk (role: assistant)
- `content_block_start` (text) → handled via deltas
- `content_block_start` (compaction) → flag set, log emitted
- `content_block_start` (thinking) → skipped (not forwarded)
- `content_block_start` (tool_use) → OpenAI tool call chunk
- `content_block_delta` (text_delta) → OpenAI content chunk
- `content_block_delta` (compaction_delta) → logged only, NOT forwarded to client
- `content_block_delta` (thinking_delta) → logged only (verbose)
- `content_block_delta` (input_json_delta) → OpenAI tool call args chunk
- `message_delta` → captures output_tokens
- `message_stop` → finish_reason + usage chunk + [DONE]

Additional features:

- Keepalive SSE comments every 25s (prevents Cloudflare tunnel idle timeout)
- XML tool call buffering and translation
- Compaction occurrence tracking and logging

### 7. `config.ts` — `mergeBetaHeaders()`

Uses a `Set` to merge:

- Claude Code required: `claude-code-20250219`, `oauth-2025-04-20`
- Cursor's headers: `context-management-2025-06-27`, `fine-grained-tool-streaming-*`, etc.
- Compaction header: `compact-2026-01-12` (appended by route handler)
- Fallback: `interleaved-thinking-2025-05-14` (only if Cursor doesn't send beta headers)

**Beta Header Filtering**: The `BLOCKED_BETAS` set strips headers that are incompatible with OAuth before merging. Currently blocks:

- `context-1m-2025-08-07` — Requires API Usage Tier 4, not available on OAuth. Cursor sends this by default. Without filtering, the API returns 400: `"The long context beta is not yet available for this subscription."`

## Request Flow — Anthropic Path

Used by clients that speak Anthropic's native Messages API directly.

1. `routes/anthropic.ts` — `handleAnthropicRequest()`
2. Parses request body as `AnthropicRequest`
3. Same compaction injection as OpenAI path
4. No format conversion needed
5. Proxies directly via `proxyRequest()`
6. Response returned as-is (with CORS headers)

## Authentication

### OAuth Flow (`oauth.ts`)

1. Credentials loaded from `~/.claude/.credentials.json` (or macOS Keychain)
2. Token validity checked with 5-minute buffer
3. If expired: refresh via `platform.claude.com/v1/oauth/token`
4. File locking prevents races with Claude CLI or other proxy instances
5. In-process mutex prevents concurrent refresh from parallel HTTP requests
6. Refreshed tokens are saved back to the credentials file

### API Key Fallback

- User-provided key (from request `Authorization: Bearer sk-ant-...` header) takes priority
- Falls back to configured `ANTHROPIC_API_KEY` from .env
- No Claude Code system prompt or OAuth headers applied

## Non-Claude Model Passthrough

When `OPENAI_API_KEY` is set and a non-Claude model is requested:

- `shouldPassthroughToOpenAI()` checks if model name lacks "claude"
- Request is forwarded as-is to OpenAI/OpenRouter via `proxyOpenAIRequest()`
- Supports custom `OPENAI_BASE_URL` for OpenRouter or other providers

## Logging

Two tiers:

- **Console logging**: Always active. Request details, model info, token counts, compaction events, errors.
- **Verbose file logging**: When `VERBOSE_LOGGING=true`. Full message bodies, system prompts, tool call details → `api.log` (gitignored, cleared on server start).

## Cursor IDE Behavioral Discoveries

These observations come from production logs and debugging real Cursor sessions through the proxy. Understanding these is critical for proxy development.

### Context Display vs Reality

Cursor shows "97.2K / 872K" for Opus 4.6 in its UI:

- **872K** = the model's native context window
- **200K** = the actual OAuth hard cap (Cursor doesn't know about this)
- Cursor NEVER triggers its built-in summarization because it thinks it has ~672K headroom
- This is the fundamental reason the proxy needs server-side compaction

### Beta Headers Cursor Sends

Observed beta headers from Cursor (via `anthropic-beta` request header):

```
context-management-2025-06-27        # Context editing (clear_tool_uses, clear_thinking)
fine-grained-tool-streaming-2025-07-14  # Granular tool call streaming
interleaved-thinking-2025-05-14      # Thinking blocks (deprecated on Opus 4.6)
effort-2025-11-24                    # Effort control
max-effort-2026-01-24                # Max effort variant
adaptive-thinking-2026-01-28         # Adaptive thinking for Opus 4.6
context-1m-2025-08-07                # ⚠️ BLOCKED — requires Tier 4, not on OAuth
```

### Context Management Cursor Sends

Cursor sends `context_management` in the request body with edits like:

- `clear_tool_uses_20250919` — clears tool use/result blocks from history
- `clear_thinking_20251015` — clears thinking blocks from history

The proxy passes these through AND appends compaction. Edit ordering is enforced: `clear_thinking → clear_tool_uses → compact`.

### Message Management

- Cursor stores ALL assistant responses as messages and sends them back on the next request
- If the proxy forwards junk (e.g., compaction summaries), Cursor accumulates it as regular text
- Cursor manages tool_calls in **Anthropic format** (flat `tool_use`/`tool_result` blocks) even though it uses the OpenAI `/v1/chat/completions` endpoint
- Cursor normalizes `input` field (OpenAI Responses API) to `messages` format in some cases

### Model Name Format

Cursor sends model names in its own format with thinking budget suffixes:

```
claude-4.6-opus-high                 → claude-opus-4-6 (thinking: adaptive)
claude-4.6-opus-max-thinking         → claude-opus-4-6 (thinking: adaptive)
claude-4.5-opus-high                 → claude-opus-4-5 (thinking: budget 50000)
claude-4.5-sonnet-high               → claude-sonnet-4-5 (thinking: budget 50000)
claude-4.5-haiku                     → claude-haiku-4-5 (no thinking)
```

The `-thinking` suffix is stripped. The reasoning budget (`high`, `medium`, `low`, `max`) is extracted and used to configure the `thinking` parameter. See [CONFIGURATION.md](CONFIGURATION.md) for the full mapping.

## Model-Specific Limitations

### Claude Opus 4.6

- **Context window**: 872K native, 200K on OAuth
- **Output**: 128K tokens max
- **Thinking**: Adaptive (`{ type: "adaptive" }`) — Claude decides thinking depth
- **Compaction**: Supported via `compact_20260112`
- **Interleaved thinking**: Auto-enabled (the `interleaved-thinking-2025-05-14` beta is deprecated but harmless)
- **1M context**: NOT available on OAuth (requires API Usage Tier 4)

### Claude Opus 4.5 / Sonnet 4.5 / Haiku 4.5

- **Context window**: 200K native (matches OAuth cap — no mismatch problem)
- **Output**: 64K tokens max (Opus/Sonnet), 16K (Haiku)
- **Thinking**: Explicit budget (`{ type: "enabled", budget_tokens: N }`) — `type: "adaptive"` NOT supported
- **Compaction**: NOT supported (API rejects `compact_20260112`)
- **Interleaved thinking**: Requires `interleaved-thinking-2025-05-14` beta header
- **`thinking: { type: "disabled" }`**: INVALID. Omit the `thinking` field entirely to disable.

### Key Differences Summary

| Feature                       | Opus 4.6                  | 4.5 Models       |
| ----------------------------- | ------------------------- | ---------------- |
| Context window                | 872K (200K on OAuth)      | 200K             |
| Max output                    | 128K                      | 64K / 16K        |
| Thinking                      | Adaptive                  | Explicit budget  |
| Compaction                    | ✅ Supported              | ❌ Not supported |
| Interleaved thinking header   | Deprecated (auto-enabled) | Required         |
| min `max_tokens` for thinking | 128000                    | 64000            |
