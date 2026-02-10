# CCProxy — Server-Side Compaction

## The Problem

Cursor IDE shows "97.2K / 872K" for Opus 4.6, reflecting the model's 872K native context window. However, Claude Code OAuth subscriptions hard-cap context at **200K tokens**. Cursor sees 672K of "headroom" and never triggers its built-in summarization. When the conversation actually hits 200K tokens, the Anthropic API returns a **400 error** and the session breaks irrecoverably.

```
Cursor's view:    97.2K / 872K  (thinks 775K headroom exists)
Reality (OAuth):  97.2K / 200K  (only 103K headroom remains)
                  → At 200K, API returns 400 → session dead
```

## The Solution: Anthropic Compaction API

Anthropic provides a **server-side compaction** feature (`compact-2026-01-12` beta) that automatically summarizes conversation context when it approaches a configurable token threshold. The proxy injects this compaction edit into every Opus 4.6 request.

### Why Server-Side Compaction?

We evaluated multiple strategies (see [TESTING.md](TESTING.md)):

| Strategy | Verdict | Notes |
|----------|---------|-------|
| **Server-side compaction** | ✅ **Chosen** | API handles summarization. Works with OAuth. |
| Proxy-side summarization (v1 approach) | ❌ Rejected | Complex, error-prone, requires separate API calls |
| Token inflation (trick Cursor) | ❌ Rejected | Hacky, unreliable, Cursor behavior unpredictable |
| Model name spoofing | ❌ Rejected | Would confuse Cursor's model capability detection |

## How It Works

### Per-Request Flow

```
1. Cursor sends request → proxy receives
2. Proxy calls injectCompaction():
   - Is model Opus 4.6+? (minorVersion >= 6)
   - Is compaction enabled? (COMPACTION_ENABLED != "false")
   - Already has compaction edit? (skip if Cursor sends it)
   → Appends compact_20260112 edit with trigger threshold
   → Appends "compact-2026-01-12" to anthropic-beta header
3. Request goes to Anthropic API via OAuth
4. API checks: are input tokens ≥ trigger threshold?
   YES → generates compaction summary, then continues response
   NO  → normal response, no compaction
5. Response streams back through proxy to Cursor
```

### Multi-Turn Lifecycle (Proxy Architecture Reality)

Because Cursor manages the message list and OpenAI format has no `compaction` block type,
**compaction blocks cannot be preserved** across requests. Every request over 150K tokens
triggers fresh compaction. The compaction summary is the API's internal mechanism — it is
**NOT forwarded to Cursor** (see "Production Bugs" below for why).

```
Turn 1-10: Context grows from 5K → 80K tokens
           No compaction triggered (< 150K threshold)

Turn 11:   Cursor sends 155K tokens → COMPACTION TRIGGERED
           API generates summary (~5K chars), reduces to ~3K input tokens
           API responds with: [compaction block] + [text block]
           Proxy strips compaction block, forwards ONLY text to Cursor
           Cursor stores text as assistant message

Turn 12:   Cursor sends: ALL original messages + new text + new user message
           Context ≈ 157K tokens (barely reduced — Cursor keeps full history)
           If > 150K → COMPACTION TRIGGERED AGAIN (from scratch)

Turn 13+:  Pattern repeats: Cursor always sends full history
           API re-compacts every request over 150K
           Each compaction costs ~3500 tokens but prevents 200K hard cap
```

**Key insight**: Unlike the intended compaction flow (where the client stores and replays
the compaction block), our proxy must re-compact on every qualifying request. This is
wasteful (~3500 tokens/compaction) but is the only way to prevent the 200K limit from
killing sessions, given that Cursor is the message manager.

### Why 150K Threshold?

- OAuth limit: 200K tokens
- Compaction itself consumes tokens (summary generation)
- Buffer needed for the response + thinking
- 150K gives ~50K of headroom for compaction overhead + response
- Configurable via `COMPACTION_TRIGGER_TOKENS` env var (minimum: 50K)

## Production Bugs Discovered & Fixed

### Bug 1: Compaction Summary Forwarded to Cursor (CRITICAL)

**Symptom**: After compaction triggered, Cursor displayed "Summary of Session..." walls of text instead of useful responses. Sessions degraded rapidly and eventually died.

**Root cause**: The `compaction_delta` handler in `streaming.ts` forwarded the compaction summary to Cursor as regular OpenAI text chunks via `safeEnqueue()`. The `anthropicToOpenai()` function in `openai-adapter.ts` also converted compaction blocks to text (`return block.content || ""`).

**What happened**:
1. API compacted conversation (174K → 102 input tokens internally)
2. Proxy forwarded ~6K char compaction summary ("Summary of Session...") as regular text to Cursor
3. Cursor stored this as a normal assistant message
4. Next request: Cursor sent ALL original messages + the 6K summary blob
5. API compacted again → proxy forwarded another 6K summary → Cursor stored it again
6. Payload only ever grew: messages 61→63→...→131, tokens 168K→170K→...→194K
7. Model produced mostly summary text with tiny actual responses (155 output tokens)
8. Eventually payload exceeded 200K before API could process → session death

**Evidence from production logs**:
```
Messages Count: 61    tokens: ~168K  → compaction → "Summary of Session..."
Messages Count: 63    tokens: ~170K  → compaction → "Summary of Session..."
Messages Count: 67    tokens: ~175K  → compaction → "Summary of Session..."
...
Messages Count: 131   tokens: ~194K  → approaching 200K hard cap
```

**Fix**: Stop forwarding compaction content to Cursor entirely:
- `streaming.ts`: Removed `safeEnqueue()` from `compaction_delta` handler — log only
- `openai-adapter.ts`: Changed `anthropicToOpenai()` to return `null` for compaction blocks (then filter nulls)

**Lesson**: The compaction summary is the API's internal mechanism. In a proxy architecture where the client (Cursor) manages messages, forwarding compaction content causes it to accumulate as regular text, inflating the payload infinitely.

### Bug 2: Empty Response After Compaction

**Symptom**: After fixing Bug 1 (not forwarding summaries), Cursor displayed "It looks like your message came through empty."

**Root cause**: The default compaction prompt summarizes the ENTIRE conversation including the latest user message. After compaction reduces 174K → 3K tokens, the summary doesn't preserve the user's actual question clearly enough. The model only sees a vague summary and has nothing specific to respond to.

**Evidence from production logs**:
```
input_tokens: 3171        ← API compacted 174K to 3K
output_tokens: 390         ← ALL thinking, ZERO text
Stream: compaction block → thinking block (390 tokens) → message_stop
        NO text content_block_start — model produced no text
```

**Fix**: Custom `instructions` parameter on the compaction edit that tells the summarizer to preserve the user's latest message verbatim:
```typescript
instructions: `Write a detailed summary of this conversation...
1. The user's LATEST message/question/request — reproduce it verbatim or near-verbatim.
2. Key context: what project/codebase is being discussed...
3. Any active task or pending work...
4. Important technical details, error messages, or code snippets...`
```

**Lesson**: In a proxy architecture, the model must respond in the SAME request where compaction occurs (the compaction block is never preserved for future requests). If the summary doesn't preserve the user's question, the model has nothing to respond to.

### Bug 3: `context-1m-2025-08-07` Beta Header Causes 400

**Symptom**: API returned 400: `"The long context beta is not yet available for this subscription."`

**Root cause**: Cursor sends `context-1m-2025-08-07` in its `anthropic-beta` header. This feature requires API Usage Tier 4, which is NOT available on Claude Code OAuth subscriptions. The proxy's `mergeBetaHeaders()` was blindly passing all Cursor headers through.

**Fix**: Added `BLOCKED_BETAS` set in `config.ts` that filters out headers incompatible with OAuth:
```typescript
const BLOCKED_BETAS = new Set([
  "context-1m-2025-08-07",  // Requires API Usage Tier 4, not available on OAuth
]);
```

**Lesson**: Cursor sends beta headers for features that may not be available on all authentication tiers. The proxy must filter these.

---

## Proxy Architecture Limitation

The compaction API is designed for clients that **control their own message list**:

```
Intended flow (direct API client):
1. Client sends messages → API compacts → returns [compaction_block, text_block]
2. Client stores response: messages.push({ role: "assistant", content: [compaction_block, text_block] })
3. Next request: client sends messages WITH compaction block
4. API sees compaction block → drops everything before it → uses summary as context
5. Context stays small: only summary + new messages
```

Our proxy cannot do this because **Cursor is the message manager**:

```
Actual flow (proxy architecture):
1. Cursor sends messages → proxy forwards → API compacts → returns [compaction_block, text_block]
2. Proxy strips compaction block, forwards ONLY text to Cursor (OpenAI format has no compaction type)
3. Cursor stores text as assistant message
4. Next request: Cursor sends ALL original messages (no compaction block among them)
5. API sees full history again → if > 150K → re-compacts from scratch
6. Context from Cursor's perspective never shrinks
```

**Consequences**:
- Every request over 150K tokens re-compacts from scratch (~3500 tokens per compaction)
- The API's `input_tokens` in the response reflects the POST-compaction count (e.g., 3171)
- But the actual HTTP payload from Cursor stays at the pre-compaction size (e.g., 174K)
- Compaction prevents the 200K hard cap from killing sessions but doesn't reduce Cursor's payload
- This is a fundamental limitation of the proxy-between-incompatible-formats architecture

**Why this is still worth it**: Without compaction, sessions die at 200K tokens. With compaction, every request over 150K costs ~3500 extra tokens but the session survives indefinitely. The alternative (v1's proxy-side `manageContext()`) was complex, fragile, and slower.

---

## Anthropic Compaction API Details

### Request Format

```json
{
  "model": "claude-opus-4-6",
  "messages": [...],
  "max_tokens": 128000,
  "context_management": {
    "edits": [
      {
        "type": "compact_20260112",
        "trigger": {
          "type": "input_tokens",
          "value": 150000
        }
      }
    ]
  }
}
```

Required beta header: `compact-2026-01-12`

### Edit Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `type` | string | Required | Must be `"compact_20260112"` |
| `trigger` | object | 150K tokens | When to trigger. `{ type: "input_tokens", value: N }`. Minimum: 50K. |
| `pause_after_compaction` | boolean | `false` | Pause after summary (for manual message manipulation) |
| `instructions` | string | null | Custom summarization prompt (replaces default entirely) |

**Important**: There is NO `keep` field on `compact_20260112`. Only the four fields above are accepted. (We learned this the hard way during testing — see [TESTING.md](TESTING.md).)

### Edit Ordering

The API requires edits in this order within `context_management.edits`:
1. `clear_thinking_20251015` (Cursor may send this)
2. `clear_tool_uses_20250919` (Cursor may send this)
3. `compact_20260112` (proxy injects this)

Our `injectCompaction()` function sorts edits after insertion to enforce this.

### Response Format (Non-Streaming)

When compaction triggers:
```json
{
  "content": [
    {
      "type": "compaction",
      "content": "Summary of the conversation: The user requested help building..."
    },
    {
      "type": "text",
      "text": "Based on our conversation so far..."
    }
  ]
}
```

### Response Format (Streaming)

```
event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"compaction"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"compaction_delta","content":"Summary of..."}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Based on..."}}
...
```

Key: Compaction deltas arrive as a **single delta with the complete summary** (no intermediate streaming).

### Usage Reporting

When compaction triggers, the API reports usage with an `iterations` array:
```json
{
  "usage": {
    "input_tokens": 45000,
    "output_tokens": 1234,
    "iterations": [
      { "type": "compaction", "input_tokens": 180000, "output_tokens": 3500 },
      { "type": "message", "input_tokens": 23000, "output_tokens": 1000 }
    ]
  }
}
```

Top-level `input_tokens`/`output_tokens` exclude compaction iteration usage. To get total billed tokens, sum across all iterations.

## Design Decisions

### Decision 1: Compaction Block Handling — Strip, Don't Forward

**Issue**: The Anthropic docs say clients should pass `compaction` blocks back to the API on subsequent requests. When the API sees a `compaction` block, it drops all content before it.

**Our situation**: We convert responses to OpenAI format for Cursor. OpenAI format has no `compaction` content block type.

**Original approach (WRONG)**: Forward compaction summary as plain text to Cursor. This caused the compaction summary to accumulate as regular assistant messages, inflating Cursor's payload infinitely (see "Bug 1" above).

**Current approach (CORRECT)**: Strip compaction blocks entirely — do NOT forward to Cursor:
- Streaming: `compaction_delta` is logged but not enqueued to the stream
- Non-streaming: `anthropicToOpenai()` returns `null` for compaction blocks, then filters nulls

**Impact**: The API cannot reuse a previous compaction block (Cursor never stores it). Every request over 150K triggers fresh compaction. This costs ~3500 tokens per compaction but prevents the 200K hard cap from killing sessions.

**Why stripping is correct**:
1. Forwarding as text causes infinite context growth (proven in production — Bug 1)
2. OpenAI format cannot represent `type: "compaction"` blocks
3. Even if forwarded as text, it arrives back as a regular `text` block — API can't identify it
4. Re-compacting from scratch is acceptable (session survives vs. session dies)

### Decision 2: Opus 4.6+ Only

Compaction currently only supports `claude-opus-4-6`. The check uses `minorVersion >= 6` from the model name parser. If Anthropic adds compaction to other models, they'll automatically get it once they have version 4.6+.

For non-Opus models (Sonnet, Haiku) or older versions (4.5), no compaction is injected. These models typically don't hit the 200K limit because Cursor uses them for shorter tasks.

### Decision 3: Future-Proofing for Cursor

If Cursor ever starts sending its own `compact_20260112` edit, our code detects this and skips injection:
```typescript
if (edits.some(e => e.type === "compact_20260112")) {
  return { injected: false, betaHeader: ANTHROPIC_BETA_COMPACTION };
}
```
We still return the beta header so the compaction feature is active, but we don't duplicate the edit.

### Decision 4: Custom Summarization Instructions (Required)

**Original approach (WRONG)**: We initially used the default summarization prompt. However, the default prompt produces a general summary that doesn't preserve the user's latest question. In our proxy architecture, the model must respond in the SAME request where compaction occurs — if the summary doesn't include the user's question, the model produces an empty response (see "Bug 2" above).

**Current approach**: We provide custom `instructions` that tell the summarizer to reproduce the user's latest message verbatim:

```typescript
instructions: `Write a detailed summary of this conversation that will replace the full history. You MUST include:
1. The user's LATEST message/question/request — reproduce it verbatim or near-verbatim. This is critical because the model must respond to it after compaction.
2. Key context: what project/codebase is being discussed, what files were modified, what decisions were made.
3. Any active task or pending work the user is waiting on.
4. Important technical details, error messages, or code snippets that are needed to continue.
Wrap your summary in a <summary></summary> block.`
```

**Why this is critical**: Anthropic's default prompt says *"write a summary of the transcript"* — great for clients that can replay the compaction block on subsequent requests. But in our proxy, the model must respond to the user's question using only the compaction summary as context. If the summary says "the user asked about various topics" instead of preserving the actual question, the model has nothing to respond to.

### Decision 5: No `pause_after_compaction`

We don't use `pause_after_compaction: true` because:
1. It would require the proxy to detect `stop_reason: "compaction"` and make a second API call
2. It adds latency, complexity, and another round trip
3. The default (no pause) generates the compaction summary and continues the response in one shot
4. We don't need to manipulate messages between compaction and response
5. In our proxy architecture, the compaction block is stripped anyway — pausing would just add cost with no benefit

**Note**: `pause_after_compaction` is useful for direct API clients that want to inject preserved messages after compaction. Since we can't preserve compaction blocks in OpenAI format, this feature has no value for us.

## What If Compaction Isn't Enough?

If a single turn has > 200K input tokens (e.g., massive codebase in the system prompt), compaction won't help because the API receives > 200K tokens before it can compact. In this case:

1. The API returns a 400 error
2. The user needs to start a new session or reduce the input
3. This is an inherent OAuth limitation — the 200K cap is absolute

For conversations that *grow* past 200K over many turns, compaction handles it perfectly.

## Supported Models

| Model | Compaction | Reason |
|-------|-----------|--------|
| `claude-opus-4-6` / `claude-4.6-opus-*` | ✅ Yes | Supported by API |
| `claude-opus-4-5` / `claude-4.5-opus-*` | ❌ No | Not supported by API |
| `claude-sonnet-4-5` / `claude-4.5-sonnet-*` | ❌ No | Not supported by API |
| `claude-haiku-4-5` / `claude-4.5-haiku` | ❌ No | Not supported by API |
| Non-Claude models | ❌ N/A | Passthrough to OpenAI/OpenRouter |

## Code Locations

| Concern | File | Function/Section |
|---------|------|-----------------|
| Compaction injection + custom instructions | `src/openai-adapter.ts` | `injectCompaction()` |
| Beta header constant | `src/config.ts` | `ANTHROPIC_BETA_COMPACTION` |
| Blocked beta headers | `src/config.ts` | `BLOCKED_BETAS` set |
| Beta header merge + filter | `src/config.ts` | `mergeBetaHeaders()` |
| Config fields | `src/types.ts` | `ProxyConfig.compactionEnabled/Tokens` |
| Config loading | `src/config.ts` | `getConfig()` |
| OpenAI route wiring | `src/routes/openai.ts` | After `openaiToAnthropic()` |
| Anthropic route wiring | `src/routes/anthropic.ts` | After body parsing |
| Streaming: compaction_delta (log only) | `src/streaming.ts` | `compaction_delta` handler |
| Streaming: compaction block_start | `src/streaming.ts` | `content_block_start` handler |
| Non-streaming: skip compaction blocks | `src/openai-adapter.ts` | `anthropicToOpenai()` — returns null |
| Non-streaming: compaction logging | `src/streaming.ts` | `handleNonStreamingResponse()` |
| Startup status | `index.ts` | Banner section |
