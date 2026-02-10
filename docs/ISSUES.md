# CCProxy — Issues Log

Tracks all issues encountered during development and production testing, including root causes, symptoms, and fixes applied.

---

## Critical Production Bugs

### Issue #1: Compaction Summary Forwarded to Cursor → Infinite Context Growth

**Status**: ✅ FIXED
**Severity**: Critical — sessions degraded and eventually died
**Discovered**: Production testing, February 2026
**Files changed**: `src/streaming.ts`, `src/openai-adapter.ts`

**Symptom**: After compaction triggered, Cursor displayed "Summary of Session..." walls of text instead of useful responses. Conversation payload grew continuously until the 200K hard cap was hit and the session broke.

**Root cause**: The `compaction_delta` handler in `streaming.ts` forwarded the compaction summary to Cursor as regular OpenAI text chunks via `safeEnqueue()`. Additionally, `anthropicToOpenai()` in `openai-adapter.ts` converted compaction blocks to text (`return block.content || ""`). Cursor stored these summaries as normal assistant messages and sent them back on every subsequent request.

**What happened step-by-step**:
1. API received 174K tokens → compaction triggered → produced ~6K char summary
2. Proxy forwarded summary as regular text content to Cursor
3. Cursor stored it as a normal assistant message
4. Next request: Cursor sent ALL original messages + the 6K summary blob
5. API compacted again → proxy forwarded another 6K summary → Cursor stored it again
6. Payload only ever grew: messages 61→63→67→...→131, tokens 168K→170K→175K→...→194K
7. API's internal `input_tokens` was always ~102 (compaction was working), but the HTTP payload from Cursor only grew
8. Model produced mostly summary text with tiny actual responses (~155 output tokens of real content)
9. Eventually payload exceeded 200K → session death

**Production log evidence**:
```
Messages Count: 61    tokens: ~168K  → compaction → "Summary of Session..."
Messages Count: 63    tokens: ~170K  → compaction → "Summary of Session..."
Messages Count: 67    tokens: ~175K  → compaction → "Summary of Session..."
...
Messages Count: 131   tokens: ~194K  → approaching 200K hard cap
```

**Fix applied**:
- `streaming.ts`: Removed `safeEnqueue()` from `compaction_delta` handler — now logs the delta length but does NOT forward to client
- `openai-adapter.ts`: Changed `anthropicToOpenai()` to return `null` for compaction blocks instead of `block.content || ""`, then added `.filter()` to strip nulls

**Key lesson**: The compaction summary is the API's internal mechanism. In a proxy architecture where the client (Cursor) manages messages, forwarding compaction content causes it to accumulate as regular text, inflating the payload infinitely.

---

### Issue #2: Empty Response After Compaction → "Message came through empty"

**Status**: ✅ FIXED
**Severity**: Critical — model produced no usable output after compaction
**Discovered**: Production testing, immediately after fixing Issue #1
**Files changed**: `src/openai-adapter.ts`

**Symptom**: After fixing Issue #1 (not forwarding summaries), Cursor displayed: *"It looks like your message came through empty."* The model produced thinking tokens but zero text tokens.

**Root cause**: The default Anthropic compaction prompt summarizes the ENTIRE conversation including the latest user message into a general narrative. After compaction reduces 174K → 3K tokens, the summary says something like "the user discussed various technical topics" — it doesn't preserve the actual question. The model sees only this vague summary and has nothing specific to respond to. It thinks deeply (390 tokens of internal reasoning) but ultimately produces no text output.

**Production log evidence**:
```
input_tokens: 3171        ← API compacted 174K to 3K
output_tokens: 390         ← ALL thinking tokens, ZERO text tokens
Stream sequence: compaction block → thinking block (390 tokens) → message_stop
                 NO text content_block_start — model produced absolutely no text
```

**Why this is worse in proxy architecture**: In a normal client that preserves compaction blocks, the model responds to the user's question on the NEXT request (which includes the compaction block + new messages). In our proxy, the model must respond in the SAME request where compaction occurs — if the summary doesn't include the user's question clearly, the model has nothing to respond to.

**Fix applied**: Added custom `instructions` parameter to the `compact_20260112` edit in `injectCompaction()`:
```typescript
instructions: `Write a detailed summary of this conversation that will replace the full history. You MUST include:
1. The user's LATEST message/question/request — reproduce it verbatim or near-verbatim.
2. Key context: what project/codebase is being discussed, what files were modified, what decisions were made.
3. Any active task or pending work the user is waiting on.
4. Important technical details, error messages, or code snippets that are needed to continue.
Wrap your summary in a <summary></summary> block.`
```

**Key lesson**: Custom compaction instructions are REQUIRED in proxy architecture. The default prompt is designed for clients that replay compaction blocks on subsequent requests — not for proxies where the model must respond in the same request using only the summary.

---

### Issue #3: `context-1m-2025-08-07` Beta Header Causes 400 Error

**Status**: ✅ FIXED
**Severity**: High — all requests through proxy would fail
**Discovered**: Production testing, February 2026
**Files changed**: `src/config.ts`

**Symptom**: API returned HTTP 400:
```json
{"error": {"type": "invalid_request_error", "message": "The long context beta is not yet available for this subscription."}}
```

**Root cause**: Cursor sends `context-1m-2025-08-07` in its `anthropic-beta` request header. This beta feature enables 1M token context windows but requires **API Usage Tier 4**, which is NOT available on Claude Code OAuth subscriptions. The proxy's `mergeBetaHeaders()` function was blindly passing all Cursor headers through to the Anthropic API.

**Fix applied**: Added `BLOCKED_BETAS` set in `config.ts` that filters out headers incompatible with OAuth before merging:
```typescript
const BLOCKED_BETAS = new Set([
  "context-1m-2025-08-07",  // Requires API Usage Tier 4, not available on OAuth
]);
```
The `mergeBetaHeaders()` function now strips any header present in `BLOCKED_BETAS` before constructing the final header string.

**Key lesson**: Cursor sends beta headers for features that may not be available on all authentication tiers. The proxy must actively filter incompatible headers.

---

## Architectural Issues

### Issue #4: Compaction Blocks Cannot Survive OpenAI Format Conversion

**Status**: ⚠️ KNOWN LIMITATION (no fix possible)
**Severity**: Medium — causes re-compaction overhead on every qualifying request
**Discovered**: Architecture analysis, February 2026

**The problem**: The Anthropic compaction API is designed for clients that manage their own message list. The intended flow is:

1. Client sends messages → API compacts → returns `[compaction_block, text_block]`
2. Client stores response including compaction block in its message history
3. Next request: client sends messages WITH the compaction block
4. API sees compaction block → drops everything before it → uses summary as context
5. Context stays small

In our proxy architecture, **Cursor is the message manager**:

1. API returns `[compaction_block, text_block]`
2. Proxy must convert to OpenAI format — but OpenAI format has NO `compaction` block type
3. Compaction block is stripped; only text is forwarded to Cursor
4. Cursor stores text as a normal assistant message
5. Next request: Cursor sends ALL original messages (no compaction block)
6. API sees full history again → re-compacts from scratch if > 150K

**Impact**: Every request over 150K tokens triggers fresh compaction, costing ~3500 tokens per compaction iteration. The API's internal `input_tokens` drops to ~3K after compaction, but Cursor's HTTP payload never shrinks.

**Why no fix is possible**: This is fundamental to the proxy-between-incompatible-formats architecture. We cannot:
- Add a `compaction` block type to OpenAI format (not our protocol)
- Make Cursor preserve and replay compaction blocks (not our client)
- Store message history in the proxy (would duplicate Cursor's state management, adding enormous complexity)

**Why it's acceptable**: Without compaction, sessions die at 200K tokens. With compaction, every qualifying request costs ~3500 extra tokens but the session survives indefinitely. The alternative (v1's proxy-side `manageContext()`) was complex, fragile, and slower.

---

### Issue #5: Cursor Context Display Mismatch (872K vs 200K)

**Status**: ⚠️ KNOWN LIMITATION (no fix possible)
**Severity**: High — the root cause of why compaction is needed
**Discovered**: Production observation, February 2026

**The problem**: Cursor IDE shows context usage as `"97.2K / 872K"` for Opus 4.6, where 872K is the model's native context window. However, Claude Code OAuth subscriptions hard-cap at **200K tokens**. Cursor believes it has ~672K of headroom remaining and NEVER triggers its built-in summarization.

When the conversation actually hits 200K tokens, the Anthropic API returns HTTP 400 (`"prompt is too long"`) and the session breaks irrecoverably — all context is lost.

**Why Cursor doesn't know**: The proxy presents itself as an OpenAI-compatible endpoint. Cursor queries model capabilities based on the model name. Since the model IS `claude-opus-4-6` (which has 872K native context), Cursor shows 872K. There is no mechanism in the OpenAI API protocol to communicate "the actual limit is lower than the model's native capability."

**The compaction solution**: Rather than trying to trick Cursor (model name spoofing or token inflation — both evaluated and rejected), we inject server-side compaction at 150K tokens. The API handles summarization transparently. Cursor never needs to know about the 200K cap.

---

## Development-Time Errors

### Issue #6: Wrong `compact_20260112` Edit Fields

**Status**: ✅ FIXED during development
**Severity**: Low — API returned clear validation error

**Error**: `compact_20260112.keep: Extra inputs are not permitted`

**Cause**: We assumed `compact_20260112` had a `keep` field like `clear_tool_uses_20250919`. It does not.

**Fix**: Removed `keep` field. The `compact_20260112` edit only accepts: `type`, `trigger`, `pause_after_compaction`, `instructions`.

---

### Issue #7: Wrong Trigger Type

**Status**: ✅ FIXED during development

**Error**: `trigger.type: Input should be 'input_tokens'`

**Cause**: Used `type: "token_count"` instead of `type: "input_tokens"` in the compaction trigger.

**Fix**: Changed to `{ type: "input_tokens", value: 150000 }`.

---

### Issue #8: Invalid `thinking: { type: "disabled" }`

**Status**: ✅ FIXED during development

**Error**: `Invalid value for thinking.type`

**Cause**: Anthropic API does NOT accept `{ type: "disabled" }` for the thinking parameter. Thinking is disabled by omitting the `thinking` field entirely.

**Fix**: Removed the `thinking` field from requests that don't need thinking, instead of setting it to disabled.

---

### Issue #9: `max_tokens` < `budget_tokens`

**Status**: ✅ FIXED during development

**Error**: `max_tokens (128) must be greater than thinking.budget_tokens (1024)`

**Cause**: Used a low `max_tokens` value with extended thinking enabled.

**Fix**: For Opus 4.6: switched to `thinking: { type: "adaptive" }` (no budget constraint) and bumped `max_tokens` to 128000. For 4.5 models: bumped `max_tokens` to 64000.

---

### Issue #10: 404 for Dated Model ID

**Status**: ✅ FIXED during development

**Error**: `404 Not Found for model "claude-opus-4-6-20250116"`

**Cause**: Used a dated model ID with timestamp suffix.

**Fix**: Use `claude-opus-4-6` (no timestamp suffix).

---

### Issue #11: Wrong `clear_at_least.type`

**Status**: ✅ FIXED during development

**Error**: `clear_at_least.type: Input should be 'input_tokens'`

**Cause**: Used `type: "percentage"` for `clear_at_least.type` in context management.

**Fix**: Simplified to use default config (no extra parameters).

---

## Open Issues / Needs More Testing

### Issue #12: Custom Compaction Instructions Effectiveness

**Status**: ⏳ NEEDS VALIDATION
**Severity**: Medium

**Question**: Do the custom compaction instructions produce responses that actually answer the user's question accurately after compaction? We know the model now produces text output (fixed Issue #2), but the quality and relevance of responses after compaction hasn't been thoroughly tested with diverse question types.

**Concern**: Very complex multi-part questions may not be perfectly preserved by the summarizer, leading to partial or off-target responses.

---

### Issue #13: Multiple Sequential Compactions Quality

**Status**: ⏳ NEEDS VALIDATION
**Severity**: Medium

**Question**: Since every request over 150K re-compacts from scratch (Issue #4), what happens to response quality over very long sessions? Does the summary-of-a-session-that-already-had-many-compactions lose important context over time?

---

### Issue #14: Cloudflare Tunnel Idle Timeout During Compaction

**Status**: ⏳ NEEDS VALIDATION
**Severity**: Low

**Question**: Compaction adds significant latency (the API must summarize before responding). Long thinking periods combined with compaction delay might exceed Cloudflare tunnel's idle timeout. The proxy sends SSE keepalives every 25s, but this hasn't been tested under worst-case conditions.

---

### Issue #15: System Prompt Survival After Compaction

**Status**: ⏳ NEEDS VALIDATION
**Severity**: Low

**Question**: What happens when compaction reduces a conversation to just the system prompt + summary? Does the Claude Code system prompt (prepended by `anthropic-client.ts`) survive compaction, or is it included in the "everything before compaction block gets dropped" behavior?
