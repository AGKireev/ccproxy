# Cursor Context Management Research

> **Status**: Active research — February 9, 2026
> **Project**: CCProxy (Bun proxy for Claude Code OAuth → Cursor IDE)
> **Focus**: Claude Opus 4.6 via Override OpenAI Base URL

---

## Goal

Make Cursor IDE + CCProxy work seamlessly for **long coding sessions** with Claude Opus 4.6 via OAuth, where the OAuth hard cap is 200K tokens but Cursor believes the limit is 872K.

**Success criteria**:

- ✅ Sessions survive indefinitely without breaking at 200K
- ✅ Context reduction maintains state consistency — Cursor's native summarization handles it
- ✅ No proxy tricks needed — MAX Mode OFF + Cursor's own summarization = zero state divergence

**SOLUTION FOUND**: Use Opus 4.6 with MAX Mode OFF → Cursor sees 200K denominator → auto-summarizes at ~95% → sessions run forever

---

## The Core Problem (UPDATED)

### Original Problem (MAX Mode ON — 872K denominator)

```
Cursor's belief:     43K / 872K  →  "95% headroom remaining, no action needed"
Reality (OAuth):     43K / 200K  →  "78% capacity, approaching limit"
```

- Cursor hardcodes **872K** as the context limit for Opus 4.6 MAX Mode (the model's native max)
- Claude Code OAuth enforces a **200K** hard cap server-side
- Cursor **never** triggers its built-in summarization because it thinks there's 775K+ of headroom
- At 200K real tokens → Anthropic API returns HTTP 400 `"prompt is too long"` → session dies

### ✅ Solution Found: MAX Mode OFF (200K denominator)

```
Cursor's belief:     43K / 200K  →  "78% capacity — approaching limit"
Reality (OAuth):     43K / 200K  →  "78% capacity — approaching limit"
                     ↑ PERFECTLY ALIGNED ↑
```

- **Opus 4.6 (Thinking)** without MAX Mode shows **200K context window** in Cursor
- The denominator now exactly matches the OAuth cap
- Context bar percentage is truthful — no inflation needed
- **Remaining question**: Does Cursor auto-summarize when approaching this 200K limit via Override Base URL?

---

## Cursor Behavioral Discoveries

### How Cursor Connects

- Cursor calls `POST /v1/chat/completions` (OpenAI format) through its **own backend servers** (IPs: `52.44.113.131`, `184.73.225.134`)
- Requires HTTPS endpoint (Cloudflare tunnel)
- Cursor is the **sole message manager** — stores all responses, replays full history on every request

### What Cursor Sends

- Model names in custom format: `claude-4.6-opus-max-thinking` → proxy normalizes to `claude-opus-4-6`
- Tool definitions in **Anthropic flat format** (not OpenAI nested format)
- `tool_use` / `tool_result` blocks in Anthropic format (despite using OpenAI endpoint)
- Beta headers including `context-1m-2025-08-07` (**must be stripped** — causes 400 on OAuth)
- Sometimes duplicate text blocks in user messages (proxy deduplicates)
- `input` field instead of `messages` in some cases (OpenAI Responses API format)

### What Cursor Does NOT Send (via Override OpenAI Base URL)

- ❌ `context_management` edits — **not sent at all** (tested in both Ask and Agent modes)
- ❌ Does not query `/v1/models` endpoint — **never called** (model capabilities are hardcoded)

### How Cursor Reads Context Size

- ✅ **Confirmed**: Cursor reads `prompt_tokens` from the `usage` field in streaming/non-streaming responses
- ✅ **Confirmed**: The context bar numerator directly reflects the `prompt_tokens` value we report
- ❌ Cursor does NOT read `context_window` from `/v1/models` responses for the denominator
- The denominator (872K) is **hardcoded** based on the model name

### Cursor's Built-in Summarization (Since v1.6)

- Triggers **automatically** when context approaches the model's limit (as Cursor understands it)
- Manual trigger via `/summarize` command
- After summarization: gives agent reference to chat history as files for recovery
- Uses "dynamic context discovery" — long tool responses become files, agent reads on demand
- **Untested**: At what exact threshold (% of denominator) does auto-summarization trigger?

---

## Hypotheses

### H1: `/v1/models` context_window field controls denominator ❌ REJECTED

- **Test**: Added `context_window: 200000` to all model entries in `/v1/models` response
- **Result**: Denominator stayed at 872K
- **Additional finding**: Cursor never even calls `/v1/models` — confirmed by adding console.log to the handler

### H2: `prompt_tokens` in usage response controls context bar numerator ✅ CONFIRMED

- **Test**: Multiplied `prompt_tokens` by 4.36 (872K/200K ratio)
- **Result**: Context bar showed 186.8K instead of 43K — perfect match with inflation math
- **Implication**: We can make Cursor's context bar fill proportionally to the real 200K limit

### H3: Inflated `prompt_tokens` will trigger Cursor's auto-summarization ❌ REJECTED

- **Test**: Used 20x inflation factor so ~44K real tokens displayed as 872K (100%)
- **Result**: Cursor hit 100% displayed multiple times — **no summarization triggered**
- **Critical discovery**: Cursor has **TWO token counting systems**:
  1. **During processing (live)**: Uses `prompt_tokens` from our usage response — we CAN control this
  2. **After response completes (stable)**: Cursor **recalculates locally** from its own stored messages — we CANNOT control this
- **Observed flow**:
  1. Message sent → context jumps to inflated value (400K → 872K) during thinking/streaming
  2. Response finishes → context **drops back** to Cursor's own local count (72.5K → 80.5K)
  3. This means Cursor's summarization trigger checks the **local recount**, not our reported number
- **Conclusion**: Token inflation cannot trigger Cursor's built-in summarization. Cursor's local recount always reflects the real (uninflated) token count of messages it stores.

### H4: Cursor sends `context_management` edits ❌ REJECTED

- **Test**: Observed proxy console in both Ask mode and Agent mode
- **Result**: No `context_management` field in any request
- **Note**: Cursor does send the beta header `context-management-2025-06-27`, but never sends the actual edits field in the request body (at least not through Override OpenAI Base URL)

### H5: Model-swap in response could trigger Cursor's auto-summarization 🔬 UNTESTED

- **Theory**: Cursor may use the `model` field from the API response (not just its dropdown selection) to determine the context denominator for its local recount
- **If true**: When context is large, proxy spoofs model name in response → Cursor recounts against a lower limit (e.g., 200K for 4.5) → triggers summarization
- **Prerequisites**: H5a: Cursor shows a lower denominator for 4.5 models. H5b: Cursor auto-summarize for 4.5 via Override URL
- **Status**: Partially superseded by H6 discovery — MAX Mode off already gives 200K denominator

### H6: Opus 4.6 without MAX Mode shows 200K context limit ✅ CONFIRMED

- **Discovery**: Turning OFF "MAX Mode" in Cursor for Opus 4.6 changes the context denominator from 872K to 200K
- **Evidence**: Cursor tooltip shows "200k context window" for "Claude Opus 4.6 (Thinking)" with MAX Mode off
- **Impact**: This ELIMINATES the core problem — the denominator now matches the real OAuth cap exactly

### H7: Cursor auto-summarizes at ~95% of denominator via Override Base URL ✅ CONFIRMED

- **Discovery**: At ~191K / 200K (95.5%), Cursor showed "Chat context summarized." and dropped context to 47K (23.5%)
- **Evidence**: Direct user observation — context bar dropped from ~95% to 23.5% after summarization
- **Impact**: This is THE solution — Cursor's native summarization works, zero state divergence, no proxy tricks needed
- **Conclusion**: The earlier failure (H3) was because the denominator was 872K (MAX Mode ON), so Cursor never thought it was close to the limit. With 200K denominator, Cursor correctly detects the limit and summarizes.

### H7: Server-side compaction works as safety net ✅ CONFIRMED

- **Test**: Production observation — compaction triggers at 150K estimated tokens
- **Result**: API returns `input_tokens=1` after compaction (context fully reduced)
- **But**: Cursor accumulates messages regardless — HTTP payload only grows

---

## Tests Completed

### Test 1.1 — Context Display Baseline ✅

- **Mode**: Ask mode, Claude 4.6 Opus Max Thinking
- **Result**: `4.9% - 43.0K / 872K` on first exchange
- **Conclusion**: Denominator is hardcoded 872K

### Test 1.2 — Context Growth in Agent Mode ✅

- **Mode**: Agent mode, Claude 4.6 Opus Max Thinking
- **Task**: "Analyze the full architecture" — multiple tool calls
- **End state**: `139.1K / 872K` (16%)
- **Observations**:
  - Compaction fired on multiple requests (anthropic input_tokens=1 after compaction)
  - Messages Count stayed low (Cursor bundles into few messages)
  - Task completed naturally without hitting any limit

### Test 1.3 — Does Cursor Send context_management? ✅

- **Mode**: Both Ask and Agent mode
- **Result**: No `context_management` in any request
- **Conclusion**: Cursor does not use Anthropic's context management API through Override OpenAI Base URL

### Test 2.1 — context_window in Models Response ✅

- **Change**: Added `context_window: 200000` to all model entries
- **Result**: Denominator still 872K
- **Conclusion**: Cursor ignores this field entirely and never queries `/v1/models`

### Test 3.1 — Token Inflation (4.36x) ✅

- **Change**: `prompt_tokens` multiplied by 872K/200K ≈ 4.36
- **Result**: Context bar showed `186.8K / 872K` (21.4%) vs expected ~43K
- **Math confirmed**: raw 42,840 × 4.36 = 186,782 ≈ 186.8K displayed
- **Conclusion**: Cursor reads `prompt_tokens` directly for context bar

### Test 3.2 — Aggressive Inflation (20x) to Trigger Summarization ✅ COMPLETED

- **Change**: `prompt_tokens` multiplied by 20
- **Result**: Cursor displayed 100% multiple times but **never triggered summarization**
- **Critical behavioral discovery**:
  - **During thinking/streaming**: Context bar shows our inflated number (jumps to 400K → 872K)
  - **After response completes**: Context bar **resets to Cursor's local recount** (~72.5K → 80.5K)
  - Cursor runs its own tokenizer on its stored messages after each turn
  - Our `prompt_tokens` is only used for the **live display during processing**
  - The **stable/resting context number** is always Cursor's own calculation
  - Summarization trigger (if it exists) checks the **stable** number, not the live one
- **Conclusion**: We cannot trick Cursor into summarizing by inflating tokens. Cursor's local state is authoritative.

---

## Tests Planned

### Test 3.3 — Observe Summarization Behavior ❌ CANCELLED

- **Reason**: H3 rejected — Cursor doesn't summarize based on our inflated tokens
- **New insight**: Cursor may not auto-summarize at all via Override OpenAI Base URL

---

## Revised Strategy: Proxy-Managed Compaction is the Only Path

**Key realization**: Since Cursor does NOT auto-summarize for Override OpenAI Base URL connections, the proxy MUST manage context itself. The current compaction approach in ccproxy is the right direction, but needs refinement.

### Test Group 4: Compaction Optimization (REVISED)

### Test 4.1 — Validate Current Compaction Behavior ⏳ PLANNED

- **Goal**: Confirm compaction kicks in at the right threshold before 200K real limit
- **Test**: Start a long conversation, watch proxy logs for compaction trigger
- **Check**: Does the model maintain coherence after compaction?

### Test 4.2 — Compaction Threshold Tuning ⏳ PLANNED

- **Goal**: Find optimal trigger point. Too early = wasteful, too late = risk 400 error
- **Options**: 120K (60%), 140K (70%), 160K (80%), 180K (90%)
- **Test**: Deliberately grow context and observe when compaction fires

### Test 4.3 — Token Inflation for Accurate Display ⏳ PLANNED

- **Goal**: Use token inflation NOT to trigger summarization, but to show users accurate context bar during processing
- **Approach**: Map real 200K → Cursor's 872K display so the bar percentage reflects true usage against the real limit
- **Factor**: 872K / 200K ≈ 4.36 (current factor is correct)
- **Issue**: Bar resets after each turn — decide if this is acceptable UX

### Test 4.4 — Long Session Stability with Compaction ⏳ PLANNED

- **Test**: Run a full coding session (~30+ exchanges) with compaction + inflation
- **Verify**: No 400 errors, coherent context, reasonable UX

### Test 4.5 — Compaction vs Model Awareness ⏳ PLANNED

- **Goal**: Test how well the model retains task knowledge after compaction
- **Test**: Give a complex multi-step task, let compaction fire, then ask the model to recall earlier details
- **Tune**: Compaction prompt/instructions to preserve maximum relevant context

---

## Architecture of Current Solution

### Primary: Server-Side Compaction

```
Cursor sends request → Proxy estimates tokens locally
  → Proxy injects compact_20260112 edit with trigger=150K
  → Request forwarded to Anthropic API via OAuth
  → If input_tokens < 150K: normal response
  → If input_tokens ≥ 150K: API generates compaction summary, then responds normally

After compaction:
  → API responds with input_tokens=1 (compacted)
  → Proxy strips compaction blocks from response stream
  → Cursor receives normal text response only
  → BUT: Cursor still holds its full message history unchanged
  → Next request: Cursor re-sends ALL messages → may trigger compaction again
```

### Cosmetic: Token Inflation for Live Display

```
Cursor sends request (real context: 43K tokens)
  → Proxy forwards to Anthropic API
  → API responds with usage: input_tokens=43K
  → Proxy inflates: 43K × 4.36 = 187K reported
  → DURING processing: Cursor shows 187K / 872K (21.4%) — proportional to real limit
  → AFTER response:    Cursor recalculates locally → shows ~43K / 872K (4.9%)
  (Token inflation is cosmetic — informational during processing, resets after)
```

### Known Limitation: Repeated Compaction

```
Since Cursor is the sole message manager and stores full history:
  → Each request re-sends ALL messages regardless of past compaction
  → If messages > 150K, compaction triggers EVERY request
  → The API re-summarizes from scratch each time (~3,500 extra tokens per turn)
  → This is unavoidable without modifying Cursor's message history
  → Mitigation: custom compaction instructions preserve key context through each cycle
```

### Files Modified for Token Inflation

- `src/streaming.ts` — inflates `prompt_tokens` in both streaming and non-streaming paths
- `src/routes/models.ts` — added `context_window` field (no effect, for documentation)
- `src/routes/models.ts` — added console.log to verify Cursor never calls `/v1/models`

---

## Key Constants

| Constant                       | Value                                              | Purpose                                                |
| ------------------------------ | -------------------------------------------------- | ------------------------------------------------------ |
| OAuth hard cap                 | 200,000 tokens                                     | Anthropic API limit for OAuth                          |
| Cursor limit (MAX Mode ON)     | 872,000 tokens                                     | Hardcoded for Opus 4.6 MAX                             |
| Cursor limit (MAX Mode OFF)    | 200,000 tokens                                     | ✅ Matches OAuth cap exactly!                          |
| Token inflation factor         | `872000 / 200000 ≈ 4.36`                           | Only needed for MAX Mode ON — unnecessary with MAX off |
| Compaction trigger             | 150,000 tokens                                     | Server-side compaction fires here                      |
| Cursor auto-summarization      | ✅ **WORKS** at ~95% of 200K via Override Base URL | Triggers at ~191K, reduces to ~47K                     |
| Cursor summarization threshold | ~95.5% of denominator (191K / 200K)                | Cursor's internal trigger point                        |

---

## Open Questions (Updated Feb 10)

1. ~~At what threshold does Cursor auto-summarize?~~ → ✅ **ANSWERED: ~95% of denominator (191K / 200K)**
2. ~~Does Cursor auto-summarize via Override OpenAI Base URL?~~ → ✅ **ANSWERED: YES, when denominator = 200K (MAX Mode OFF)**
3. ~~Best compaction trigger threshold?~~ → Less critical now — Cursor summarizes before compaction matters, but 150K still serves as safety net
4. ~~Should inflation be kept?~~ → **NO for MAX Mode OFF** — raw tokens are truthful. Only needed if someone uses MAX Mode ON
5. **How well does Cursor's summarization preserve context?** Does the model lose important task details after the 191K→47K reduction?
6. **Does compaction interfere with Cursor's summarization?** Compaction fired at ~172K est, Cursor summarized at ~191K — are these independent or do they conflict?
7. **Can/should compaction be disabled entirely** when using MAX Mode OFF? Cursor handles it natively — compaction may be redundant overhead
8. **Multi-session stability**: Does the cycle (grow → summarize → grow → summarize) work smoothly over 50+ exchanges?

---

## Decision Log

| Date         | Decision                                         | Rationale                                                                       |
| ------------ | ------------------------------------------------ | ------------------------------------------------------------------------------- |
| Feb 9, 2026  | Rejected `/v1/models` context_window approach    | Cursor never calls the endpoint; ignores the field                              |
| Feb 9, 2026  | Adopted token inflation via `prompt_tokens`      | Confirmed Cursor reads this for context bar                                     |
| Feb 9, 2026  | Tested 20x inflation — no summarization          | Cursor recalculates tokens locally after each response                          |
| Feb 9, 2026  | **Discovered dual token counting**               | Cursor uses our `prompt_tokens` during processing but recounts locally after    |
| Feb 9, 2026  | **Cursor won't auto-summarize via Override URL** | Proxy-managed compaction is the only viable path                                |
| Feb 9, 2026  | Compaction is primary strategy going forward     | Token inflation kept for cosmetic display during processing                     |
| Feb 9, 2026  | **MAX Mode OFF = 200K denominator**              | Opus 4.6 (Thinking) without MAX shows 200K — perfectly matches OAuth cap        |
| Feb 9, 2026  | Token inflation may be unnecessary               | With MAX off, context bar is truthful — inflation only needed for MAX Mode      |
| Feb 10, 2026 | **🎉 SOLUTION FOUND**                            | MAX Mode OFF + Cursor native summarization = perfect long sessions              |
| Feb 10, 2026 | Cursor summarizes at ~95% of denominator         | At ~191K / 200K, "Chat context summarized." → dropped to 47K (23.5%)            |
| Feb 10, 2026 | Earlier H3 failure explained                     | H3 failed because denominator was 872K — Cursor never thought it was near limit |
| Feb 10, 2026 | Compaction becomes backup only                   | Still useful as safety net, but Cursor's summarization is the primary mechanism |

### Test Group 6: MAX Mode OFF — Auto-Summarization 🔬 PRIORITY

### Test 6.1 — Baseline with MAX Mode OFF ✅ CONFIRMED

- **Result**: `12.4% - 24.8K / 200K context used` — denominator is 200K, perfectly aligned with OAuth cap
- **Proxy log**: `prompt_tokens=24756 (raw=24756, no inflation, anthropic=11889)`
- **Token inflation**: Disabled, raw tokens reported — Cursor displays them directly
- **Estimator accuracy**: Our estimate (24,756) is ~2x the API's real count (11,889) — conservative but safe
- **Conclusion**: MAX Mode OFF + no inflation = truthful context bar. No proxy tricks needed.

### Test 6.2 — Does Cursor auto-summarize at 200K via Override Base URL? ✅ YES!!!

- **Result**: At ~191K / 200K (95.5%), Cursor displayed **"Chat context summarized."** during thinking
- **Context dropped**: From 191K → **47.0K** (23.5%) — massive reduction, Cursor managed it entirely
- **Compaction also fired**: At ~172K estimated, proxy's compaction triggered (input_tokens=140 post-compaction)
- **Sequence**: Compaction fired first (at ~172K estimate / 150K trigger) → Cursor continued accumulating → Cursor summarized at ~191K / 200K
- **CONCLUSION**: 🎉 Cursor DOES auto-summarize via Override Base URL when the 200K denominator matches the real limit!
- **This is the holy grail**: MAX Mode OFF + Cursor's native summarization = perfect long sessions with zero state divergence

### Test 6.3 — Token Inflation Impact with MAX Mode OFF ⏳ PLANNED

- **Goal**: Determine if token inflation helps or hurts with 200K denominator
- **Theory**: With 200K denominator, inflation would make the bar show MORE than reality
- **Recommendation**: Probably disable inflation entirely when denominator = 200K
- **Test**: Compare context bar accuracy with inflation ON vs OFF

---

### Test Group 5: Model-Swap Summarization Strategy 🔬 DEPRIORITIZED (see Test Group 6)

### Test 5.1 — What denominator does Cursor show for Claude 4.5? ⏳ PLANNED

- **Goal**: Check if 4.5 models have a lower context denominator than 4.6's 872K
- **Test**: Select Claude 4.5 Sonnet (or Opus 4.5) in Cursor, send one message
- **Check**: What's the denominator? `X / ???K`
- **If 200K**: This strategy is very promising — 200K matches the OAuth limit exactly
- **If also high (600K+)**: Dead end for this approach

### Test 5.2 — Does Cursor auto-summarize for 4.5 via Override Base URL? ⏳ PLANNED

- **Goal**: Determine if the "no auto-summarization" issue is 4.6-specific or universal for Override URLs
- **Test**: Use 4.5 model, grow context toward the limit, watch for summarization
- **Check**: Does Cursor trigger summarization at some % of the 4.5 denominator?
- **If yes**: Model-swap strategy is viable
- **If no**: Auto-summarization is universally blocked for Override Base URL connections

### Test 5.3 — Proxy-side model-swap near limit ⏳ PLANNED (requires 5.1 ✅ + 5.2 ✅)

- **Goal**: Automatically trigger Cursor's summarization by spoofing model name in response
- **Flow**:
  1. Proxy detects context approaching 200K (via token estimate)
  2. Proxy changes `model` field in response chunks to a 4.5 model name
  3. Cursor stores response, recalculates tokens against 4.5's (presumably lower) denominator
  4. Cursor sees high %, triggers its own summarization
  5. After summarization, proxy resumes returning 4.6 model name
- **Key question**: Does Cursor use the _response_ model name or its _dropdown selection_ for the denominator?
- **Automation**: Fully automatic — proxy handles the swap transparently

### Test 5.4 — Response model name vs dropdown selection ⏳ PLANNED

- **Goal**: Determine which model name Cursor uses for its context denominator
- **Test**: Select 4.6 in Cursor dropdown, but have proxy return `model: "claude-4.5-sonnet"` in response
- **Check**: Does Cursor's context bar denominator change? Does it show 4.5's limit or 4.6's?

---

## Approach Comparison

| Approach                                        | Status              | Assessment                                                                                                    |
| ----------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------- |
| **v1: Proxy-side summarization**                | ❌ Abandoned        | Complex, fragile, requires API key, slow, state divergence                                                    |
| **Token inflation → Cursor auto-summarization** | ❌ Rejected         | Cursor recounts locally; won't summarize via Override Base URL                                                |
| **v2: Server-side compaction (current)**        | ✅ Active           | Works — API re-compacts each request over 150K. Costs extra tokens but maintains session stability            |
| **v2+: Compaction + cosmetic inflation**        | 🔬 Testing          | Compaction for safety + inflation for user awareness during processing                                        |
| **v2++: Model-swap → Cursor summarization**     | 💡 Idea             | Deprioritized — MAX Mode off may solve the same problem more simply                                           |
| **v2+++: MAX Mode OFF + native summarization**  | ✅ **THE SOLUTION** | 200K denominator matches OAuth cap. Cursor auto-summarizes at ~95%. Zero state divergence. Zero proxy tricks. |

---

## Raw Data

### Test 1.1 — Ask Mode Baseline

```
Context: 4.9% - 43.0K / 872K
Console: prompt_tokens=186782 (raw=42840, inflated x4.36, anthropic=30363)
```

### Test 1.2 — Agent Mode Session

```
End state: 139.1K / 872K
Usage sequence:
  prompt_tokens=98780  (raw=22656, inflated x4.36, anthropic=9709)
  prompt_tokens=87191  (raw=19998, inflated x4.36, anthropic=8184)
  prompt_tokens=96670  (raw=22172, inflated x4.36, anthropic=1)     ← compaction fired
  prompt_tokens=295329 (raw=67736, inflated x4.36, anthropic=1)     ← compaction fired
  prompt_tokens=429390 (raw=98484, inflated x4.36, anthropic=1)     ← compaction fired
  prompt_tokens=136647 (raw=31341, inflated x4.36, anthropic=1)     ← compaction fired
```

### Cursor Beta Headers Observed

```
Sent by Cursor: context-1m-2025-08-07 (STRIPPED), adaptive-thinking-2026-01-28,
  max-effort-2026-01-24, context-management-2025-06-27,
  fine-grained-tool-streaming-2025-05-14, effort-2025-11-24
Added by proxy: claude-code-20250219, oauth-2025-04-20, compact-2026-01-12
```
