# ccproxy-v2: Refactoring Notes

## Why v2 Exists

ccproxy v1's custom context management (summarization) **fights against Cursor's native context management**, causing:

- Cursor UI flickering and stuck states during summarization
- Stale cached content appearing in responses
- ~33s latency spikes when summarization triggers
- Message history rewriting that confuses Cursor's internal state

## Root Cause Analysis

### Discovery: Cursor Has Its Own Context Management

Cursor sends `anthropic-beta: context-management-2025-06-27` header, indicating it uses the **Anthropic Context Editing API** for server-side context management. It also sends a `context_management` field in the request body.

### How v1 Broke This

1. **Beta header overwrite** (`anthropic-client.ts:174`): The proxy replaced ALL of Cursor's beta headers with Claude Code's headers, stripping `context-management-2025-06-27`
2. **Message history rewrite** (`manageContext()`): The proxy injected summary pairs into the message array, confusing Cursor's state tracking
3. **Field stripping**: The `context_management` field from Cursor was lost during OpenAI-to-Anthropic conversion

## What v2 Changes

### Architecture: "Proxy manages context" -> "Proxy is transparent"

| Aspect | v1 | v2 |
|--------|----|----|
| Context management | Proxy summarizes messages | Cursor handles natively |
| Beta headers | Overwritten with Claude Code's | Merged (Cursor's + Claude Code auth) |
| Message history | Rewritten with summary pairs | Passed through unchanged |
| `context_management` field | Stripped | Passed through |
| `effort` field | Stripped | Passed through |
| Compaction blocks | Ignored | Forwarded to client |

### Key APIs

**Context Editing API** (`context-management-2025-06-27`):
- Server-side tool result clearing (`clear_tool_uses_20250919`)
- Thinking block clearing (`clear_thinking_20251015`)
- Applied before prompt reaches Claude

**Compaction API** (`compact-2026-01-12`):
- Server-side context summarization
- API generates `compaction` content blocks in responses
- Client appends compaction blocks; API auto-drops messages before them on next request

### Files Changed

| File | Change |
|------|--------|
| `src/types.ts` | Added `context_management`, `effort`, `compaction` types |
| `src/config.ts` | Added `mergeBetaHeaders()` function |
| `src/openai-adapter.ts` | Pass through `context_management` and `effort` |
| `src/anthropic-client.ts` | Merge beta headers instead of overwriting |
| `src/routes/openai.ts` | Removed `manageContext()`, transparent passthrough |
| `src/routes/anthropic.ts` | Removed `manageContext()`, transparent passthrough |
| `src/streaming.ts` | Handle `compaction` and `compaction_delta` blocks |
| `index.ts` | Banner update |
| `.env` | Port 8083 |
| `package.json` | Name `ccproxy-v2` |

### Files Unchanged

`oauth.ts`, `token-counter.ts`, `logger.ts`, `server.ts`, `tool-call-translator.ts`, `openai-passthrough.ts`, `context-manager.ts` (kept but no longer imported), `routes/models.ts`

## Auth Safety (Parallel Operation)

Both ccproxy (8082) and ccproxy-v2 (8083) share `~/.claude/.credentials.json`. The existing file-locking mechanism is safe:

- **In-process mutex**: `refreshInProgress` promise prevents concurrent refreshes within one process
- **Cross-process file lock**: Atomic `O_CREAT|O_EXCL` lock file with 30s stale timeout
- **Conflict resolution**: If process A refreshes while B has stale cache, B gets 401 -> clears cache -> re-reads fresh token from file -> succeeds

No code changes needed in `oauth.ts` for parallel operation.
