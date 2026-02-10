# CCProxy — Testing & Validation

## Strategy Decision Tests

Before implementing compaction, we ran 5 tests to determine the optimal approach. The test script is at `src/test-context-strategy.ts`.

### Test Environment

- **Runtime**: Bun v1.3.8 (Windows x64)
- **Authentication**: Claude Code OAuth (production path)
- **Model**: `claude-opus-4-6`
- **Date**: February 2026

### Run Command

```bash
bun src/test-context-strategy.ts
```

---

## Test 1: Compaction API with OAuth

**Question**: Does the `compact-2026-01-12` beta work with Claude Code OAuth subscriptions?

**Method**: Send a request with `compact_20260112` edit and `compact-2026-01-12` beta header via OAuth.

**Result**: ✅ **PASSED — Status 200**

```json
{
  "context_management": { "applied_edits": [] },
  "content": [
    { "type": "thinking", "thinking": "..." },
    { "type": "text", "text": "test ok" }
  ]
}
```

The `applied_edits: []` is expected — compaction didn't trigger because input tokens (~44) were far below the 50K minimum threshold. The key finding: **the API accepted the request and didn't reject the beta feature**.

---

## Test 2: Context Editing with OAuth

**Question**: Does `context-management-2025-06-27` (clear_tool_uses, clear_thinking) work with OAuth?

**Method**: Send a request with `clear_tool_uses_20250919` edit via OAuth.

**Result**: ✅ **PASSED — Status 200**

This confirms Cursor's native context management edits work through the OAuth path. The proxy correctly passes them through.

---

## Test 3: Token Reporting

**Question**: Does the API report `input_tokens` and `output_tokens` in usage?

**Result**: ✅ **PASSED**

```
input_tokens: 44
output_tokens: 32
```

The proxy can use these values or override them when forwarding to Cursor.

---

## Test 4: Model Name Spoofing (Feasibility)

**Question**: Can we respond with a different model name to Cursor?

**Result**: ✅ **FEASIBLE** (but not used)

API returns `model='claude-opus-4-6'`. The proxy could respond with `model='claude-4.5-opus-high'` to make Cursor show a 164K context window instead of 872K. However, this approach was rejected in favor of compaction because:

- It would confuse Cursor's model capability detection
- Extended thinking, adaptive features might behave differently
- Compaction is a cleaner, API-supported solution

---

## Test 5: Inflated Token Count (Feasibility)

**Question**: Can the proxy report arbitrary `prompt_tokens` to Cursor?

**Result**: ✅ **FEASIBLE** (but not used)

Streaming events confirm the proxy controls the OpenAI-format usage chunk. We could report `prompt_tokens=850000` to trick Cursor into thinking context is nearly full. However:

- Cursor's response to inflated tokens is unpredictable
- Built-in summarization behavior is not well-documented
- Compaction is more reliable and doesn't depend on Cursor's behavior

---

## Errors Encountered During Testing

### Error 1: Wrong Trigger Type

```
trigger.type: Input should be 'input_tokens'
```

**Cause**: We used `type: "token_count"` instead of `type: "input_tokens"`.
**Fix**: Changed to `type: "input_tokens"`.

### Error 2: Wrong Model ID

```
404 Not Found for model "claude-opus-4-6-20250116"
```

**Cause**: Used a dated model ID with timestamp suffix.
**Fix**: Changed to `claude-opus-4-6` (no suffix).

### Error 3: Invalid `keep` Field

```
compact_20260112.keep: Extra inputs are not permitted
```

**Cause**: We assumed `compact_20260112` had a `keep` field like `clear_tool_uses_20250919`. It does not.
**Fix**: Removed `keep` field entirely. The `compact_20260112` edit only accepts: `type`, `trigger`, `pause_after_compaction`, `instructions`.

### Error 4: Wrong `clear_at_least.type`

```
clear_at_least.type: Input should be 'input_tokens'
```

**Cause**: Used `type: "percentage"` for `clear_at_least.type`.
**Fix**: Simplified test 2 to use default config (no extra parameters).

### Error 5: `max_tokens` < `budget_tokens`

```
max_tokens (128) must be greater than thinking.budget_tokens (1024)
```

**Cause**: Used `max_tokens: 128` with `thinking: { type: "enabled", budget_tokens: 1024 }`.
**Fix**: Switched to `thinking: { type: "adaptive" }` (no budget constraint) and `max_tokens: 2048`.

### Error 6: `thinking: { type: "disabled" }`

```
Invalid value for thinking.type
```

**Cause**: Anthropic API doesn't accept `type: "disabled"`. Thinking is disabled by omitting the field entirely.
**Fix**: Removed the `thinking` field from minimal test requests.

---

## Decision Matrix Output

```
🏆 RECOMMENDED: v3 = v2 + proxy-injected compaction at ~150K
   The Compaction API works with OAuth!
   Strategy:
   1. Proxy adds compact-2026-01-12 beta header
   2. Proxy injects compaction edit with trigger at ~150K
   3. Anthropic handles summarization server-side (fast, correct)
   4. Compaction blocks flow back through proxy to Cursor

✓  Context Editing (clear_tool_uses) works with OAuth — Cursor passthrough is valid.
```

---

## Post-Implementation Verification

### Startup Test

After implementing all changes, the proxy was started and verified:

```
╔═══════════════════════════════════════════════════════════════╗
║                 Claude Code Proxy (CCProxy)                   ║
╠═══════════════════════════════════════════════════════════════╣
║  Smart proxy with server-side compaction for Opus 4.6.        ║
║  Routes through Claude Code subscription, falls back to API.  ║
╚═══════════════════════════════════════════════════════════════╝

🚀 Server running at http://localhost:8099
   Anthropic:  http://localhost:8099/v1/messages
   OpenAI:     http://localhost:8099/v1/chat/completions
✓ Loaded credentials from file
✓ Claude Code credentials loaded
  Token expires in 195 minutes
⚠️  No fallback ANTHROPIC_API_KEY (will fail if Claude Code limits hit)
⚠️  No OPENAI_API_KEY (non-Claude models will fail)
✓ Server-side compaction enabled (trigger: 150000 tokens, Opus 4.6+ only)

📝 Verbose file logging disabled (set VERBOSE_LOGGING=true to enable)
```

### API Test

A test request was sent and returned successfully:

```json
{
  "id": "chatcmpl-msg_XXXXXXXXXXXXXXXXXXXX",
  "object": "chat.completion",
  "created": 1770569155,
  "model": "claude-4.6-opus",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hi! How can I help you today?"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 7, "completion_tokens": 12, "total_tokens": 19 }
}
```

### Consistency Checks

All import/export references verified across the codebase:

- ✅ All imports resolve to existing exports
- ✅ Port 8082 consistent across all config files
- ✅ ProxyConfig types match config.ts implementation
- ✅ `injectCompaction` properly exported and imported in both routes
- ✅ `REFACTORING.md` deleted (outdated)

---

## Production Testing Results (February 2026)

Real Cursor sessions were used to test compaction in production, revealing critical bugs that were fixed.

### Production Test 1: Compaction Trigger ✅ CONFIRMED

**Setup**: Long Cursor session with Opus 4.6, messages approaching 174K tokens.

**Result**: Compaction triggered correctly.

```
📊 [Tokens] ~174K tokens (estimate, passthrough mode)
[Compaction] Injected compact_20260112 (trigger: 150000 tokens)
[Debug] Captured input_tokens from message_start: 3171
[Compaction] ⚡ Compaction block started — context is being summarized by API
[Compaction] Compaction delta: 5944 chars (not forwarded to client)
```

**Key metrics**:

- Input before compaction: ~174K tokens
- Input after compaction: 3171 tokens (97.8% reduction)
- Compaction summary size: 5944 chars (~1500 tokens)
- Beta headers confirmed working through OAuth path

### Production Test 2: Compaction Summary Forwarding Bug 🐛 → ✅ FIXED

**Setup**: Same long session. Initially, compaction summaries were forwarded to Cursor as text.

**Bug observed**:

```
Request 1: Messages=61,  tokens=~168K → compaction → "Summary of Session..." forwarded
Request 2: Messages=63,  tokens=~170K → compaction → another summary forwarded
Request 3: Messages=67,  tokens=~175K → compaction → another summary forwarded
...
Request N: Messages=131, tokens=~194K → approaching 200K hard cap
```

API `input_tokens` was always 102 (compaction working internally), but Cursor's payload only grew because it accumulated every summary as a regular assistant message.

**Fix applied**: Stopped forwarding compaction content to client (streaming.ts + openai-adapter.ts).

### Production Test 3: Empty Response After Compaction 🐛 → ✅ FIXED

**Setup**: After fixing the forwarding bug, tested compaction again.

**Bug observed**: Cursor displayed "It looks like your message came through empty."

```
input_tokens: 3171         ← compaction reduced 174K to 3K
output_tokens: 390          ← ALL thinking, ZERO text output
Stream sequence: compaction → thinking (390 tokens) → message_stop
                 NO text content_block_start
```

Model produced no text because the default compaction summary didn't preserve the user's latest question.

**Fix applied**: Custom `instructions` parameter telling summarizer to preserve the user's latest message verbatim.

### Production Test 4: Beta Header Rejection 🐛 → ✅ FIXED

**Setup**: Normal Cursor request through the proxy.

**Bug observed**: API returned 400:

```json
{
  "error": {
    "type": "invalid_request_error",
    "message": "The long context beta is not yet available for this subscription."
  }
}
```

Caused by Cursor sending `context-1m-2025-08-07` in its beta headers. This feature requires API Usage Tier 4.

**Fix applied**: Added `BLOCKED_BETAS` filter in `mergeBetaHeaders()`.

### Production Test 5: Merged Beta Headers ✅ CONFIRMED

**Observed merged beta header string** (from production logs):

```
claude-code-20250219,oauth-2025-04-20,adaptive-thinking-2026-01-28,
max-effort-2026-01-24,context-management-2025-06-27,
fine-grained-tool-streaming-2025-05-14,effort-2025-11-24,compact-2026-01-12
```

Note: `context-1m-2025-08-07` is stripped (not present). All other Cursor headers pass through.

### Production Test 6: Rate Limit Headers ✅ CONFIRMED

**Observed rate limit info** from Anthropic response headers:

```
anthropic-ratelimit-unified-5h-utilization: 0.14
anthropic-ratelimit-unified-7d-utilization: 0.69
anthropic-ratelimit-unified-overage-utilization: 0.0
anthropic-ratelimit-unified-representative-claim: five_hour
```

OAuth rate limits are tracked separately from API key limits. The 5-hour and 7-day utilization values can be used for monitoring.

---

## What Still Needs Testing

### Tested in Production ✅

1. ~~**Compaction trigger**~~: ✅ Confirmed at ~174K tokens
2. ~~**Session continuity**~~: ⚠️ Partially tested — compaction triggers but response quality depends on custom instructions (needs more validation)

### Still Needs Testing

3. **Custom instructions effectiveness**: Verify that the custom compaction instructions produce responses that actually answer the user's question after compaction.

4. **Multiple compactions**: In our proxy architecture, every request over 150K re-compacts. Verify that repeated compactions in a long session don't cause degrading quality.

5. **Context growth pattern**: After the forwarding fix, verify that Cursor's payload doesn't grow infinitely. It should grow naturally with conversation turns, not from accumulated summaries.

6. **Non-Opus models**: Verify that Sonnet 4.5 requests pass through without compaction injection. (Likely works — the `minorVersion` check is straightforward.)

7. **Cloudflare tunnel**: Verify compaction works end-to-end through the Cloudflare tunnel. Compaction adds latency (API must summarize before responding). Longer thinking periods may trigger tunnel idle timeout.

8. **Edge case: System prompt only**: What happens when compaction reduces a conversation to just the system prompt + summary? Does the Claude Code system prompt survive compaction?
