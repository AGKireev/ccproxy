# CCProxy — Changelog

## Context

CCProxy has gone through three conceptual phases:

- **v1**: Port 8082. Custom proxy-side summarization via `manageContext()`. Included analytics, budget system, context strategy modules. Complex and fragile.

- **v2 baseline**: Port 8083. Rewritten as a "transparent proxy" — Cursor handles its own context management, proxy just translates formats and routes through OAuth. Simpler, but hit the 200K limit problem.

- **v2 + compaction** (current): Port 8082. Same transparent proxy philosophy, but with server-side compaction injected for Opus 4.6. The API handles summarization, not the proxy. Best of both worlds.

---

## Changes from v2 Baseline → v2 + Compaction

### New Files

| File                           | Purpose                                                        |
| ------------------------------ | -------------------------------------------------------------- |
| `docs/ARCHITECTURE.md`         | System overview, request flow, module descriptions             |
| `docs/COMPACTION.md`           | Compaction strategy deep-dive, API mechanics, design decisions |
| `docs/TESTING.md`              | Test results, methodology, errors encountered                  |
| `docs/CONFIGURATION.md`        | All configuration options reference                            |
| `docs/CHANGELOG.md`            | This file                                                      |
| `src/test-context-strategy.ts` | Test script for compaction API validation                      |

### Deleted Files

| File             | Reason                                        |
| ---------------- | --------------------------------------------- |
| `REFACTORING.md` | Outdated v2 migration doc, no longer relevant |

### Modified Files

#### `src/types.ts`

Added compaction config fields to `ProxyConfig`:

```typescript
export interface ProxyConfig {
  // ... existing fields ...
  compactionEnabled: boolean // NEW
  compactionTriggerTokens: number // NEW
}
```

#### `src/config.ts`

1. **Added constant**: `ANTHROPIC_BETA_COMPACTION = "compact-2026-01-12"`
2. **Changed default port**: `"8083"` → `"8082"`
3. **Added config fields**:
   ```typescript
   compactionEnabled: process.env.COMPACTION_ENABLED !== "false",
   compactionTriggerTokens: Math.max(50000, parseInt(process.env.COMPACTION_TRIGGER_TOKENS || "150000", 10)),
   ```

#### `src/openai-adapter.ts`

1. **Added imports**: `getConfig`, `ANTHROPIC_BETA_COMPACTION` from `config.ts`

2. **New function `injectCompaction()`** (after `openaiToAnthropic()`):
   - Checks if model is Opus 4.6+ and compaction is enabled
   - Creates `context_management.edits` if not present
   - Skips if Cursor already sends compaction (future-proofing)
   - Appends `compact_20260112` edit with configurable trigger
   - Sorts edits to API-required order
   - Returns beta header string for the route handler to append

3. **Fixed `anthropicToOpenai()` content mapping**: Added compaction block handling:
   ```typescript
   if (block.type === "compaction") return block.content || ""
   ```

#### `src/routes/openai.ts`

Added between format conversion and proxy request:

```typescript
import { normalizeModelName, injectCompaction } from "../openai-adapter"

// After openaiToAnthropic():
const normalized = normalizeModelName(openaiBody.model)
const compactionResult = injectCompaction(
  anthropicBody,
  normalized.minorVersion,
)

// Append beta header if needed:
if (compactionResult.betaHeader) {
  const existing = headers["anthropic-beta"] || ""
  headers["anthropic-beta"] = existing
    ? `${existing},${compactionResult.betaHeader}`
    : compactionResult.betaHeader
}
```

#### `src/routes/anthropic.ts`

Same compaction injection pattern added:

```typescript
import { normalizeModelName, injectCompaction } from "../openai-adapter"

// After parsing body:
const normalized = normalizeModelName(body.model)
const compactionResult = injectCompaction(body, normalized.minorVersion)
// ... same beta header append logic
```

#### `src/streaming.ts`

1. **Added `compactionOccurred` flag** (line 58)

2. **Compaction block start handler** (streaming):

   ```typescript
   if (block?.type === "compaction") {
     compactionOccurred = true
     console.log(`   [Compaction] ⚡ Compaction block started...`)
     continue // Content arrives via compaction_delta
   }
   ```

3. **Compaction delta handler** (streaming):

   ```typescript
   if (event.delta?.type === "compaction_delta") {
     compactionOccurred = true
     // Forward content as OpenAI text chunk
     safeEnqueue(createOpenAIStreamChunk(streamId, openaiModel, content))
   }
   ```

4. **Compaction status in usage report** (streaming):

   ```typescript
   if (compactionOccurred) {
     console.log(`   [Compaction] ✓ Context was compacted in this response.`)
   }
   ```

5. **Non-streaming compaction logging**:
   ```typescript
   if (anthropicResponse.content?.some((b: any) => b.type === "compaction")) {
     console.log(
       `   [Compaction] ⚡ Compaction occurred in non-streaming response`,
     )
   }
   ```

#### `index.ts`

1. **Updated banner text**:

   ```
   ║  Smart proxy with server-side compaction for Opus 4.6.        ║
   ```

2. **Added compaction status at startup**:
   ```typescript
   if (config.compactionEnabled) {
     console.log(
       `✓ Server-side compaction enabled (trigger: ${config.compactionTriggerTokens} tokens, Opus 4.6+ only)`,
     )
   }
   ```

#### Config Files

| File                     | Change                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `.env`                   | `PORT=8083` → `PORT=8082`                                                                                           |
| `.env.example`           | Port 8082, added `COMPACTION_ENABLED` and `COMPACTION_TRIGGER_TOKENS` docs, removed `CLAUDE_CODE_EXTRA_INSTRUCTION` |
| `cloudflared-config.yml` | `localhost:8083` → `localhost:8082`                                                                                 |
| `start-proxy.ps1`        | Quick tunnel fallback `localhost:8083` → `localhost:8082`                                                           |
| `start-proxy.sh`         | `PORT="${PORT:-8083}"` → `PORT="${PORT:-8082}"`                                                                     |

---

## What Was NOT Changed

These modules were left untouched because they work correctly as-is:

| Module                    | Reason                                                                       |
| ------------------------- | ---------------------------------------------------------------------------- |
| `anthropic-client.ts`     | Beta headers flow through `mergeBetaHeaders()` naturally. No changes needed. |
| `oauth.ts`                | Token management is independent of compaction.                               |
| `token-counter.ts`        | Character-based estimation still used for console logging.                   |
| `openai-passthrough.ts`   | Non-Claude models bypass compaction entirely.                                |
| `tool-call-translator.ts` | XML tool call translation unaffected by compaction.                          |
| `logger.ts`               | Logging infrastructure unchanged.                                            |
| `routes/models.ts`        | Model list unchanged.                                                        |
| `server.ts`               | Routing, CORS, IP whitelist unchanged.                                       |

---

## What Was Removed vs v1

These v1 features were intentionally NOT present in v2:

| Feature                       | v1                                     | v2                               | Reason                               |
| ----------------------------- | -------------------------------------- | -------------------------------- | ------------------------------------ |
| `manageContext()`             | ✅ Complex proxy-side summarization    | ❌ Removed                       | Server-side compaction replaces this |
| Analytics endpoints           | ✅ `/analytics`, `/analytics/requests` | ❌ Removed                       | Unnecessary complexity               |
| Budget system                 | ✅ `/budget` endpoint                  | ❌ Removed                       | Not needed with subscription         |
| SQLite database               | ✅ Analytics storage                   | ❌ Removed                       | No analytics = no database           |
| `CONTEXT_STRATEGY`            | ✅ `summarize`/`trim`/`none`           | ❌ Removed                       | Single strategy: API compaction      |
| `CONTEXT_MAX_TOKENS`          | ✅ Configurable                        | ❌ → `COMPACTION_TRIGGER_TOKENS` | Simpler, API-native                  |
| `CONTEXT_SUMMARIZATION_MODEL` | ✅ Configurable                        | ❌ Removed                       | API uses the request model           |

---

## Key Learnings Documented

1. **Cursor context display is unreliable**: Shows model's native window (872K for Opus 4.6) but OAuth caps at 200K. Cursor never triggers its built-in summarization because it doesn't know about the OAuth cap.

2. **Compaction works with OAuth**: Confirmed via testing. This was not obvious — many beta features are tier-gated.

3. **`compact_20260112` has NO `keep` field**: Unlike `clear_tool_uses_20250919`. We learned this from API validation errors.

4. **Edit ordering matters**: `clear_thinking → clear_tool_uses → compact`. The API rejects out-of-order edits.

5. **Compaction blocks must be STRIPPED, not forwarded**: Originally we forwarded compaction content as text — this caused infinite context growth. Compaction blocks are now stripped entirely (`return null` in `anthropicToOpenai()`). The API re-compacts from scratch on every qualifying request.

6. **Adaptive thinking is Opus 4.6+ only**: Claude 4.5 requires explicit `budget_tokens`. `{ type: "adaptive" }` on 4.5 causes an API error.

7. **`interleaved-thinking-2025-05-14`** is deprecated on Opus 4.6 (auto-enabled) but still needed for 4.5.

8. **1M context (`context-1m-2025-08-07`)** requires API Usage Tier 4 — NOT available on OAuth subscriptions. Cursor sends this header by default — it must be stripped.

9. **Custom compaction instructions are required**: The default summarization prompt doesn't preserve the user's latest question, causing empty responses after compaction. Custom `instructions` parameter is now injected to preserve the latest user message verbatim.

10. **Cursor sends beta headers incompatible with OAuth**: The proxy must filter these via `BLOCKED_BETAS` to prevent 400 errors.

11. **Every request over 150K re-compacts from scratch**: Compaction blocks can't survive OpenAI format conversion. Cursor never preserves them. This is wasteful (~3500 tokens/compaction) but prevents session death at the 200K cap.

12. **`thinking: { type: "disabled" }` is invalid**: Anthropic API doesn't accept it. Omit the `thinking` field entirely to disable thinking.

13. **Cursor manages tool_calls in Anthropic format**: Even though Cursor uses the OpenAI `/v1/chat/completions` endpoint, it sends tool_use/tool_result blocks in flat Anthropic format (not OpenAI nested format).

---

## Post-Compaction Bug Fixes

These fixes were made after deploying compaction and observing production behavior with real Cursor sessions.

### Fix 1: Beta Header Filtering (config.ts)

**Problem**: Cursor sends `context-1m-2025-08-07` in its beta headers. This feature requires API Usage Tier 4, not available on OAuth. API returned 400: `"The long context beta is not yet available for this subscription."`

**Changes**:

- `config.ts`: Added `BLOCKED_BETAS` set containing `context-1m-2025-08-07`
- `config.ts`: Updated `mergeBetaHeaders()` to filter blocked headers before merging
- `config.ts`: Removed `ENABLE_1M_CONTEXT` env var and associated logic from `BETA_HEADERS_LIST`

### Fix 2: Stop Forwarding Compaction Summaries (streaming.ts, openai-adapter.ts)

**Problem**: Compaction summaries (~6K chars of "Summary of Session...") were forwarded to Cursor as regular text content. Cursor accumulated these as assistant messages, causing the payload to grow infinitely: 168K → 170K → 175K → ... → 194K. API `input_tokens` was always ~102 (compaction working) but the HTTP payload from Cursor only grew. Sessions eventually died at 200K.

**Changes**:

- `streaming.ts`: Removed `safeEnqueue()` from `compaction_delta` handler — now logs only: `"Compaction delta: N chars (not forwarded to client)"`
- `openai-adapter.ts`: Changed `anthropicToOpenai()` compaction handling from `return block.content || ""` to `return null`, added `.filter()` to strip nulls

### Fix 3: Custom Compaction Instructions (openai-adapter.ts)

**Problem**: After Fix 2, compaction worked but the model produced empty responses. Production logs showed: compaction block → thinking block (390 tokens) → NO text block. The default Anthropic summarization prompt doesn't preserve the user's latest question — after compaction reduces 174K → 3K tokens, the model had nothing specific to respond to.

**Changes**:

- `openai-adapter.ts`: Added custom `instructions` field to the `compact_20260112` edit in `injectCompaction()`
- Instructions tell the summarizer to reproduce the user's latest message verbatim and preserve key technical context
