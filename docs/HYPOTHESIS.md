# CCProxy — Hypotheses & Decisions

Documents the hypotheses we tested, strategies we evaluated, and architectural decisions we made — with reasoning and outcomes.

---

## Strategy Evaluation (Pre-Implementation)

Before implementing compaction, we evaluated 4 strategies to solve the 200K context cap problem. See [TESTING.md](TESTING.md) for detailed test results.

### Hypothesis 1: Server-Side Compaction via Anthropic API

**Hypothesis**: Anthropic's `compact_20260112` API will work with Claude Code OAuth subscriptions and can be injected transparently by the proxy.

**Test**: Send a request with the compaction edit and beta header via OAuth.

**Result**: ✅ CONFIRMED — API accepted the request (status 200). `applied_edits: []` was expected since test input was only ~44 tokens (below 50K minimum). The beta feature was not tier-gated for OAuth.

**Decision**: **ADOPTED** as the primary strategy. API handles summarization server-side — no proxy-side complexity needed.

---

### Hypothesis 2: Model Name Spoofing

**Hypothesis**: If the proxy responds with `model='claude-4.5-opus-high'` instead of `claude-opus-4-6`, Cursor would show a 164K context window instead of 872K, and would trigger its built-in summarization before hitting 200K.

**Test**: Verified that the proxy controls the model name in the response.

**Result**: ✅ FEASIBLE but ❌ REJECTED

**Reasoning**:

- Would confuse Cursor's model capability detection
- Extended thinking, adaptive features might behave differently if Cursor thinks it's a 4.5 model
- Cursor's built-in summarization behavior when it thinks context is full is not well-documented
- Server-side compaction is a cleaner, API-supported solution

---

### Hypothesis 3: Token Count Inflation

**Hypothesis**: If the proxy reports `prompt_tokens=850000` in the response usage chunk, Cursor would think context is nearly full (850K/872K) and trigger its built-in summarization.

**Test**: Verified that the proxy controls the usage chunk in streaming responses.

**Result**: ✅ FEASIBLE but ❌ REJECTED

**Reasoning**:

- Cursor's response to inflated tokens is unpredictable and not documented
- Built-in summarization behavior might not work as expected
- Cursor might simply refuse to send more messages instead of summarizing
- Server-side compaction is more reliable and doesn't depend on Cursor's behavior

---

### Hypothesis 4: Proxy-Side Summarization (v1 Approach)

**Hypothesis**: The proxy can manage context itself by intercepting messages, summarizing them with a separate API call, and replacing old messages with summaries.

**Background**: This was the v1 approach (`manageContext()` in ccproxy v1).

**Result**: ❌ REJECTED for v2

**Reasoning**:

- Complex implementation: separate summarization calls, message tracking, token counting
- Fragile: proxy must understand conversation structure, handle tool calls in summaries, etc.
- Slower: adds a full API round-trip for every summarization
- Error-prone: summarization model might lose important context
- Server-side compaction is simpler, faster, and handled by the same model that generates the response

---

## Architectural Decisions (Implementation)

### Decision 1: Strip Compaction Blocks, Don't Forward

**Context**: When compaction triggers, the API returns both a `compaction` block (summary) and a `text` block (actual response). The Anthropic docs say clients should store and replay compaction blocks on subsequent requests.

**Original hypothesis**: Forward compaction summary as plain text to Cursor so it becomes part of the conversation.

**Result**: ❌ DISPROVEN IN PRODUCTION — caused infinite context growth (see [ISSUES.md](ISSUES.md) Issue #1).

**What we learned**: Forwarding compaction content to Cursor causes it to accumulate as regular assistant messages. Cursor sends ALL messages back on every request. The payload only ever grows: 168K→170K→175K→...→194K. Sessions eventually died at 200K.

**Final decision**: Strip compaction blocks entirely — do NOT forward to Cursor.

- Streaming: `compaction_delta` is logged but not enqueued to the response stream
- Non-streaming: `anthropicToOpenai()` returns `null` for compaction blocks, then filters nulls
- Consequence: API cannot reuse previous compaction blocks → every request over 150K re-compacts from scratch

---

### Decision 2: Custom Compaction Instructions Are Required

**Context**: After Decision 1 (strip compaction blocks), the model must respond to the user in the SAME request where compaction occurs — unlike the intended API flow where the client replays the compaction block on the next request and the model responds then.

**Original hypothesis**: The default Anthropic compaction prompt will produce a summary good enough for the model to continue responding.

**Result**: ❌ DISPROVEN IN PRODUCTION — model produced empty responses (see [ISSUES.md](ISSUES.md) Issue #2).

**What we learned**: The default prompt summarizes the ENTIRE conversation into a general narrative ("the user discussed various technical topics"). After compaction reduces 174K → 3K tokens, the model sees only this vague summary and has nothing specific to respond to. It produced 390 thinking tokens and ZERO text.

**Final decision**: Inject custom `instructions` that tell the summarizer to:

1. Reproduce the user's LATEST message/question verbatim
2. Preserve key context (project, files, decisions)
3. Preserve any active/pending tasks
4. Preserve important technical details

This ensures the model has a clear question to respond to after compaction.

---

### Decision 3: Block Incompatible Beta Headers

**Context**: Cursor sends various `anthropic-beta` headers. Not all of them are available on Claude Code OAuth subscriptions.

**Hypothesis**: All beta headers Cursor sends are compatible with OAuth.

**Result**: ❌ DISPROVEN — `context-1m-2025-08-07` requires API Usage Tier 4, causing 400 errors (see [ISSUES.md](ISSUES.md) Issue #3).

**Final decision**: Maintain a `BLOCKED_BETAS` set in `config.ts` that filters out known-incompatible headers before merging. Currently blocks:

- `context-1m-2025-08-07` — 1M context requires API Tier 4

This is a safelist approach — if Cursor adds new headers that are also incompatible, they'll need to be added to `BLOCKED_BETAS`.

---

### Decision 4: Re-Compaction From Scratch Is Acceptable

**Context**: Due to Decision 1 (strip compaction blocks), every request over 150K tokens triggers fresh compaction. The API re-summarizes the entire conversation from scratch each time.

**Hypothesis**: The overhead of re-compaction (~3500 tokens per iteration) is an acceptable tradeoff.

**Analysis**:

- **Cost**: ~3500 tokens per compaction iteration (reported via `usage.iterations`)
- **Frequency**: Only on requests exceeding 150K tokens (long sessions)
- **Alternative**: Session death at 200K tokens (unrecoverable)
- **Alternative 2**: Proxy-side message management (v1 approach — complex, fragile, slower)

**Final decision**: ✅ ACCEPTED. Session survival >> compaction overhead. The overhead is small relative to the 150K+ token requests that trigger it.

---

### Decision 5: Opus 4.6+ Only for Compaction

**Context**: The Anthropic compaction API (`compact_20260112`) may or may not support models other than Opus 4.6.

**Hypothesis**: Compaction is only needed for Opus 4.6 because it's the only model with a context window (872K) larger than the OAuth cap (200K).

**Analysis**:

- Opus 4.6: 872K native, 200K on OAuth → **mismatch, compaction needed**
- Opus 4.5: 200K native, 200K on OAuth → no mismatch
- Sonnet 4.5: 200K native, 200K on OAuth → no mismatch
- Haiku 4.5: 200K native, 200K on OAuth → no mismatch

**Final decision**: Only inject compaction when `minorVersion >= 6`. This naturally covers Opus 4.6 and any future models with version ≥ 4.6. If Anthropic releases a 4.7 model with an even larger window, compaction will automatically activate.

---

### Decision 6: No `pause_after_compaction`

**Context**: The compaction API offers `pause_after_compaction: true` which causes the API to return with `stop_reason: "compaction"` after generating the summary, allowing the client to manipulate messages before making a second request for the actual response.

**Hypothesis**: Pausing after compaction would give us more control.

**Analysis**:

- Pausing would require detecting `stop_reason: "compaction"` and making a SECOND API call
- Adds latency (two round-trips instead of one)
- Adds complexity (proxy must manage multi-step flow)
- Adds cost (two API calls instead of one)
- In our proxy architecture, the compaction block is stripped anyway — there are no messages to "manipulate" between compaction and response

**Final decision**: ❌ REJECTED. Use the default (no pause) — API generates compaction summary and continues the response in a single shot.

---

### Decision 7: Adaptive Thinking for Opus 4.6, Explicit Budget for 4.5

**Context**: Anthropic offers two thinking modes: `{ type: "adaptive" }` (model decides how much to think) and `{ type: "enabled", budget_tokens: N }` (fixed budget).

**Discovery**: `{ type: "adaptive" }` is ONLY supported on Opus 4.6+. Using it on 4.5 models causes an API error.

**Additional discovery**: `{ type: "disabled" }` is INVALID on all models. To disable thinking, omit the `thinking` field entirely.

**Final decision**:

- Opus 4.6+ (`minorVersion >= 6`): Use `{ type: "adaptive" }` with `max_tokens: 128000`
- 4.5 models: Use `{ type: "enabled", budget_tokens: N }` with `max_tokens: 64000`
- No thinking needed: Omit the `thinking` field entirely (do NOT set to `disabled`)

Cursor sends thinking budget hints in the model name suffix (`-high`, `-medium`, `-low`, `-max`). For 4.6, these are informational only (adaptive overrides them). For 4.5, they map to explicit budget values.

---

### Decision 8: Compaction Trigger at 150K Tokens

**Context**: The compaction trigger threshold determines when the API starts summarizing.

**Analysis**:

- OAuth limit: 200K tokens
- Need headroom for: compaction overhead (~3500 tokens) + response generation + thinking
- Too low (e.g., 50K): Unnecessary compaction, wasted tokens, information loss
- Too high (e.g., 190K): Risk of hitting 200K before compaction can complete
- 150K: ~50K of headroom for compaction overhead + response (including 128K potential output)

**Final decision**: Default trigger at 150K tokens. Configurable via `COMPACTION_TRIGGER_TOKENS` env var. Minimum enforced at 50K (API requirement).

---

### Decision 9: Edit Ordering Enforcement

**Context**: The Anthropic API requires context management edits in a specific order. Cursor may send its own edits (`clear_thinking`, `clear_tool_uses`), and the proxy appends compaction.

**Discovery**: API rejects out-of-order edits. The required order is:

1. `clear_thinking_20251015`
2. `clear_tool_uses_20250919`
3. `compact_20260112`

**Final decision**: `injectCompaction()` sorts all edits after insertion using a priority map. This ensures correct ordering regardless of what Cursor sends.

---

## Hypotheses Still Being Tested

### Hypothesis: Custom Instructions Produce Quality Responses

**Status**: ⏳ TESTING IN PRODUCTION

**Question**: Do our custom compaction instructions produce responses that are accurate, relevant, and properly address the user's actual question after compaction?

**Current evidence**: The model now produces text output (Issue #2 fixed), but we haven't tested with diverse question types:

- Simple follow-up questions ← likely fine
- Complex multi-part questions ← may lose nuance
- Code-specific questions referencing earlier files ← depends on summary quality
- Questions that depend on understanding conversation flow ← may lose ordering

---

### Hypothesis: Repeated Re-Compaction Maintains Quality

**Status**: ⏳ NEEDS TESTING

**Question**: In very long sessions where compaction triggers many times, does the quality of the API's summary degrade? Each time, the API summarizes a conversation that includes previous compaction-era content. Does context quality erode over many iterations?

---

### Hypothesis: Claude Code System Prompt Survives Compaction

**Status**: ⏳ NEEDS TESTING

**Question**: The proxy prepends a Claude Code system prompt (via `prepareClaudeCodeBody()` in `anthropic-client.ts`). When the API compacts, does it preserve the system prompt? Or does it get included in the "drop everything before the compaction block" behavior?

**Expected**: System prompts are separate from messages in the Anthropic API format. They should survive compaction. But this hasn't been explicitly verified.
