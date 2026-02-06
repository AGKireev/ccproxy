import { countTokens, countMessageTokens, countTokensAPI } from "./token-counter";
import { ANTHROPIC_API_URL, CLAUDE_CODE_BETA_HEADERS, CLAUDE_CODE_SYSTEM_PROMPT } from "./config";
import { getValidToken } from "./oauth";
import type {
  AnthropicRequest,
  AnthropicMessage,
  AnthropicResponse,
  ContentBlock,
} from "./types";

const COMPRESSION_RATIO = 0.3; // summary is ~30% of original
const PROTECT_FIRST = 3; // protect first 3 messages (system context, initial instructions)
const PROTECT_LAST = 10; // protect last 10 messages (recent conversation)
const MAX_ITERATIONS = 3;
const MAX_INCREMENTAL_MERGES = 5; // force full re-summarization after N incremental merges (quality compaction)
const MIN_SUMMARY_CHARS = 200; // absolute minimum summary length
const SUMMARY_QUALITY_RATIO = 0.005; // summary must be at least 0.5% of estimated input chars
const INCREMENTAL_MAX_TOKENS = 8192; // smaller max_tokens for incremental merges (delta is small)

// --- Incremental Summarization Cache ---
// Instead of re-summarizing the entire middle section on every request, we cache the
// accumulated summary and only process NEW (delta) messages incrementally.
//
// STRATEGY:
// 1. Cold start: full summarization of middle messages, cache the result
// 2. Subsequent requests: detect how many messages are already summarized (via offset),
//    only call the API to merge the delta (new messages) into the existing summary
// 3. After MAX_INCREMENTAL_MERGES, force a full re-summarization (quality compaction)
//
// CACHE VALIDATION:
// - anchorHash: hash of first few middle messages — detects conversation divergence
// - lastSummarizedMessageHash: hash of boundary message — detects message edits/deletions
// - If either fails, cache is discarded and we fall back to cold start
//
// WHEN CACHE HELPS:
// - Sequential tool calls in same conversation (incremental merge, ~5s vs ~33s)
// - Retries (full cache hit, offset matches, ~0s)
// - Parallel tool calls (full cache hit, same messages)

interface IncrementalSummaryCache {
  // The accumulated summary text covering all previously-summarized messages
  summaryText: string;
  // How many messages from middleStart are covered by this summary
  summarizedUpToOffset: number;
  // Hash of the boundary message (last message included in summary) for integrity validation
  lastSummarizedMessageHash: string;
  // Hash of first few middle messages — detects conversation divergence
  anchorHash: string;
  // Estimated token count of the summary text itself
  summaryTokens: number;
  // How many incremental merges have been done (reset on full re-summarization)
  incrementalMergeCount: number;
  // Creation timestamp for TTL
  timestamp: number;
}

const summarizationCache = new Map<string, IncrementalSummaryCache>();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes (extended from 15 — conversations can span longer)
const MAX_CACHE_ENTRIES = 50;

/**
 * Generate a conversation ID from the first few messages.
 * This identifies "which conversation" we're in, stable across tool calls.
 */
function getConversationId(req: AnthropicRequest): string {
  // Use first 3 messages (protected messages) as conversation identifier
  const keyMessages = req.messages.slice(0, PROTECT_FIRST);
  const keyStr = JSON.stringify(keyMessages);
  return Bun.hash(keyStr).toString(16);
}

/**
 * Generate a hash for a range of messages (the "middle section" to be summarized).
 */
function hashMessages(messages: AnthropicMessage[]): string {
  const str = JSON.stringify(messages);
  return Bun.hash(str).toString(16);
}

/**
 * Hash a single message for boundary validation.
 */
function hashSingleMessage(msg: AnthropicMessage): string {
  return Bun.hash(JSON.stringify(msg)).toString(16);
}

/**
 * Compute anchor hash from the first few middle-section messages.
 * Used to detect conversation divergence (e.g., messages edited/deleted before our boundary).
 */
function computeAnchorHash(messages: AnthropicMessage[], middleStart: number): string {
  const anchorCount = Math.min(3, messages.length - middleStart);
  if (anchorCount <= 0) return "";
  const anchorMessages = messages.slice(middleStart, middleStart + anchorCount);
  return hashMessages(anchorMessages);
}

/**
 * Validate that a summary meets quality thresholds proportional to input size.
 * Catches near-empty summaries that slip through (e.g., "0K tokens, 100% compression").
 */
function validateSummaryQuality(
  summary: string,
  inputTokenEstimate: number
): { valid: boolean; reason?: string } {
  if (!summary || summary.trim().length === 0) {
    return { valid: false, reason: "Summary is empty" };
  }

  // Absolute minimum
  if (summary.trim().length < MIN_SUMMARY_CHARS) {
    return {
      valid: false,
      reason: `Summary too short: ${summary.trim().length} chars (minimum: ${MIN_SUMMARY_CHARS})`,
    };
  }

  // Proportional minimum: summary should be at least 0.5% of estimated input chars
  const estimatedInputChars = inputTokenEstimate * 3.5;
  const minChars = Math.max(
    MIN_SUMMARY_CHARS,
    Math.floor(estimatedInputChars * SUMMARY_QUALITY_RATIO)
  );

  if (summary.trim().length < minChars) {
    return {
      valid: false,
      reason: `Summary suspiciously short: ${summary.trim().length} chars for ~${Math.round(inputTokenEstimate / 1000)}K token input (minimum: ${minChars} chars)`,
    };
  }

  return { valid: true };
}

/**
 * Clean up expired and excess cache entries.
 */
function cleanupCache(): void {
  const now = Date.now();

  // Remove expired entries
  for (const [key, entry] of summarizationCache) {
    if (now - entry.timestamp > CACHE_TTL_MS) {
      summarizationCache.delete(key);
    }
  }

  // If still too many, remove oldest
  if (summarizationCache.size > MAX_CACHE_ENTRIES) {
    const entries = Array.from(summarizationCache.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp);

    const toRemove = entries.slice(0, entries.length - MAX_CACHE_ENTRIES);
    for (const [key] of toRemove) {
      summarizationCache.delete(key);
    }
  }
}

/**
 * Look up the incremental summary cache for a conversation.
 * Validates anchor hash and boundary hash to ensure cache integrity.
 * Returns null if cache is stale, expired, or integrity checks fail.
 */
function getIncrementalCache(
  req: AnthropicRequest,
  middleStart: number
): IncrementalSummaryCache | null {
  const conversationId = getConversationId(req);
  const cached = summarizationCache.get(conversationId);

  if (!cached) {
    console.log(
      `📦 [Cache Miss] No cached summary for conversation ${conversationId.slice(0, 8)}...`
    );
    return null;
  }

  if (Date.now() - cached.timestamp > CACHE_TTL_MS) {
    console.log(
      `📦 [Cache Expired] Summary for ${conversationId.slice(0, 8)}... expired after ${Math.round(CACHE_TTL_MS / 60000)} minutes`
    );
    summarizationCache.delete(conversationId);
    return null;
  }

  // Validate anchor: first few middle messages haven't changed
  const currentAnchor = computeAnchorHash(req.messages, middleStart);
  if (currentAnchor !== cached.anchorHash) {
    console.log(
      `📦 [Cache Invalid] Anchor messages changed (conversation diverged), discarding`
    );
    summarizationCache.delete(conversationId);
    return null;
  }

  // Validate boundary message: the last message we summarized is still the same
  const boundaryIndex = middleStart + cached.summarizedUpToOffset - 1;
  if (boundaryIndex < middleStart || boundaryIndex >= req.messages.length) {
    console.log(
      `📦 [Cache Invalid] Boundary index ${boundaryIndex} out of range [${middleStart}..${req.messages.length - 1}], discarding`
    );
    summarizationCache.delete(conversationId);
    return null;
  }

  const currentBoundaryHash = hashSingleMessage(req.messages[boundaryIndex]);
  if (currentBoundaryHash !== cached.lastSummarizedMessageHash) {
    console.log(
      `📦 [Cache Invalid] Boundary message at index ${boundaryIndex} changed (hash mismatch), discarding`
    );
    summarizationCache.delete(conversationId);
    return null;
  }

  console.log(
    `📦 [Cache Hit] Found cached summary covering ${cached.summarizedUpToOffset} messages, ${cached.incrementalMergeCount} merges (conv: ${conversationId.slice(0, 8)}...)`
  );
  return cached;
}

/**
 * Store an incremental summary in the cache.
 */
function cacheIncrementalSummary(
  req: AnthropicRequest,
  middleStart: number,
  summarizedUpToOffset: number,
  summaryText: string,
  summaryTokens: number,
  incrementalMergeCount: number
): void {
  const conversationId = getConversationId(req);
  const anchorHash = computeAnchorHash(req.messages, middleStart);
  const boundaryIndex = middleStart + summarizedUpToOffset - 1;
  const lastSummarizedMessageHash = hashSingleMessage(req.messages[boundaryIndex]);

  summarizationCache.set(conversationId, {
    summaryText,
    summarizedUpToOffset,
    lastSummarizedMessageHash,
    anchorHash,
    summaryTokens,
    incrementalMergeCount,
    timestamp: Date.now(),
  });

  cleanupCache();
  console.log(
    `📦 [Cache Store] Cached summary covering ${summarizedUpToOffset} messages, merge #${incrementalMergeCount} (conv: ${conversationId.slice(0, 8)}...)`
  );
}

interface ContextConfig {
  strategy: "summarize" | "trim" | "none";
  summarizationModel: string;
  maxTokens: number;
  targetTokens: number;
}

function getContextConfig(): ContextConfig {
  return {
    strategy:
      (process.env.CONTEXT_STRATEGY as ContextConfig["strategy"]) ||
      "summarize",
    summarizationModel:
      process.env.CONTEXT_SUMMARIZATION_MODEL || "claude-sonnet-4-5-20250929",
    // Claude Code OAuth enforces 200K server-side (1M beta not available for OAuth)
    maxTokens: parseInt(process.env.CONTEXT_MAX_TOKENS || "200000"),
    targetTokens: parseInt(process.env.CONTEXT_TARGET_TOKENS || "180000"),
  };
}

/**
 * Format messages into a readable transcript for summarization.
 * Preserves coverage of ALL messages by truncating per-message content
 * rather than cutting the middle of the concatenated transcript.
 */
function formatTranscript(messages: AnthropicMessage[]): string {
  const MAX_TRANSCRIPT_CHARS = 400000; // ~115K tokens at 3.5 chars/token — safe for most models

  // First pass: format each message with generous per-block limits
  const formatted = messages.map((m) => {
    let text: string;
    if (typeof m.content === "string") {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      text = m.content
        .map((block) => {
          if (block.type === "text" && block.text) return block.text;
          if (block.type === "tool_use")
            return `[Tool Call: ${block.name}(${JSON.stringify(block.input).slice(0, 2000)})]`;
          if (block.type === "tool_result") {
            const content =
              typeof block.content === "string"
                ? block.content
                : JSON.stringify(block.content);
            return `[Tool Result: ${content?.slice(0, 2000)}]`;
          }
          return JSON.stringify(block).slice(0, 500);
        })
        .join("\n");
    } else {
      text = String(m.content);
    }
    return { role: m.role, text };
  });

  // Check total size
  const totalChars = formatted.reduce((sum, m) => sum + m.text.length + 20, 0); // +20 for role label + separators

  if (totalChars <= MAX_TRANSCRIPT_CHARS) {
    // Under limit — use full content
    return formatted
      .map((m) => `[${m.role.toUpperCase()}]:\n${m.text}`)
      .join("\n\n---\n\n");
  }

  // Over limit — calculate per-message budget and truncate individually
  // This preserves coverage of ALL messages instead of losing the middle
  const overhead = messages.length * 20; // role labels + separators
  const availableChars = MAX_TRANSCRIPT_CHARS - overhead;
  const perMessageBudget = Math.floor(availableChars / messages.length);

  console.log(
    `   📝 Transcript too large (${Math.round(totalChars / 1000)}K chars), truncating to ~${Math.round(perMessageBudget / 1000)}K chars per message`
  );

  return formatted
    .map((m) => {
      let text = m.text;
      if (text.length > perMessageBudget) {
        // Keep start + end of each message to preserve context
        const half = Math.floor(perMessageBudget / 2);
        text = text.slice(0, half) + "\n...[truncated]...\n" + text.slice(-half);
      }
      return `[${m.role.toUpperCase()}]:\n${text}`;
    })
    .join("\n\n---\n\n");
}

/**
 * Call the Anthropic API directly to summarize messages
 */
async function callSummarizationAPI(
  messages: AnthropicMessage[],
  config: ContextConfig
): Promise<string> {
  // Get OAuth token (same as main requests)
  const token = await getValidToken();
  if (!token) {
    throw new Error("No OAuth token available for summarization - run 'claude /login'");
  }

  const transcript = formatTranscript(messages);

  // Build system prompt: Claude Code required prefix + summarizer role instruction
  const systemBlocks = [
    { type: "text", text: CLAUDE_CODE_SYSTEM_PROMPT },
    {
      type: "text",
      text: `You are also acting as a conversation summarizer. Summarize coding assistant conversations concisely and accurately. Preserve ALL technical details: file paths, function signatures, code snippets, error messages, and their resolutions. Be dense and factual. Output only the summary.`,
    },
  ];

  const response = await fetch(`${ANTHROPIC_API_URL}/v1/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.accessToken}`,
      "anthropic-beta": CLAUDE_CODE_BETA_HEADERS,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
      "User-Agent": "claude-code/1.0.85",
    },
    body: JSON.stringify({
      model: config.summarizationModel,
      max_tokens: 16384,
      stream: false,
      system: systemBlocks,
      messages: [
        {
          role: "user",
          content: `Summarize the following conversation excerpt, preserving:

- Key decisions and conclusions reached
- Important code snippets, file paths, and technical details
- Tool calls and their significant results
- The user's goals, requirements, and preferences
- Any unresolved questions or action items
- Error messages and their resolutions

---

${transcript}`,
        },
      ],
    }),
    signal: AbortSignal.timeout(120_000), // 120s timeout for large summarizations
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "unknown");
    throw new Error(
      `Summarization API returned ${response.status}: ${errorText}`
    );
  }

  const data = (await response.json()) as AnthropicResponse;

  // Warn if summary was truncated due to max_tokens
  if (data.stop_reason === "max_tokens") {
    console.warn(`   ⚠️ Summary was truncated (hit max_tokens). Consider increasing max_tokens or reducing input.`);
  }

  return data.content?.[0]?.text || "";
}

/**
 * Call the Anthropic API to incrementally merge new messages into an existing summary.
 * Much faster than full re-summarization since the delta is typically only 2-6 messages.
 */
async function callIncrementalSummarizationAPI(
  existingSummary: string,
  newMessages: AnthropicMessage[],
  config: ContextConfig
): Promise<string> {
  const token = await getValidToken();
  if (!token) {
    throw new Error("No OAuth token available for incremental summarization - run 'claude /login'");
  }

  const transcript = formatTranscript(newMessages);

  const systemBlocks = [
    { type: "text", text: CLAUDE_CODE_SYSTEM_PROMPT },
    {
      type: "text",
      text: `You are a conversation summarizer. You will receive an existing summary of a coding conversation and new messages that occurred after the summary. Produce a single COMPLETE updated summary that incorporates both. Preserve ALL technical details: file paths, function signatures, code snippets, error messages, decisions, and resolutions. Be dense and factual. Output only the updated summary.`,
    },
  ];

  const response = await fetch(`${ANTHROPIC_API_URL}/v1/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.accessToken}`,
      "anthropic-beta": CLAUDE_CODE_BETA_HEADERS,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
      "User-Agent": "claude-code/1.0.85",
    },
    body: JSON.stringify({
      model: config.summarizationModel,
      max_tokens: INCREMENTAL_MAX_TOKENS,
      stream: false,
      system: systemBlocks,
      messages: [
        {
          role: "user",
          content: `== EXISTING SUMMARY (covers earlier messages) ==

${existingSummary}

== NEW MESSAGES (added after the summary) ==

${transcript}

Produce a COMPLETE updated summary incorporating both sections. Do not simply append — integrate the new information into a coherent whole. Preserve all technical details: file paths, function signatures, code snippets, error messages, decisions, and resolutions.`,
        },
      ],
    }),
    signal: AbortSignal.timeout(60_000), // 60s timeout (shorter — delta is small)
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "unknown");
    throw new Error(
      `Incremental summarization API returned ${response.status}: ${errorText}`
    );
  }

  const data = (await response.json()) as AnthropicResponse;

  if (data.stop_reason === "max_tokens") {
    console.warn(`   ⚠️ Incremental summary was truncated (hit max_tokens=${INCREMENTAL_MAX_TOKENS})`);
  }

  return data.content?.[0]?.text || "";
}

/**
 * Clean up orphaned tool_use/tool_result pairs after summarization.
 * This ensures every tool_result has a matching tool_use in a previous message,
 * and every tool_use has a matching tool_result in a following message.
 */
function cleanupOrphanedToolPairs(messages: AnthropicMessage[]): AnthropicMessage[] {
  // Step 1: Collect all valid tool_use IDs (from assistant messages)
  const validToolUseIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_use" && block.id) {
          validToolUseIds.add(block.id);
        }
      }
    }
  }

  // Step 2: Remove orphaned tool_result blocks (no matching tool_use)
  let removedResults = 0;
  for (const msg of messages) {
    if (msg.role === "user" && Array.isArray(msg.content)) {
      const originalLength = msg.content.length;
      msg.content = msg.content.filter((block: ContentBlock) => {
        if (block.type === "tool_result" && block.tool_use_id) {
          const hasMatch = validToolUseIds.has(block.tool_use_id);
          if (!hasMatch) removedResults++;
          return hasMatch;
        }
        return true;
      });
    }
  }

  // Step 3: Collect all valid tool_result IDs (from user messages)
  const validToolResultIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_result" && block.tool_use_id) {
          validToolResultIds.add(block.tool_use_id);
        }
      }
    }
  }

  // Step 4: Remove orphaned tool_use blocks (no matching tool_result)
  let removedUses = 0;
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      msg.content = msg.content.filter((block: ContentBlock) => {
        if (block.type === "tool_use" && block.id) {
          const hasMatch = validToolResultIds.has(block.id);
          if (!hasMatch) removedUses++;
          return hasMatch;
        }
        return true;
      });
    }
  }

  // Step 5: Remove empty messages
  const filteredMessages = messages.filter(msg => {
    if (Array.isArray(msg.content)) {
      return msg.content.length > 0;
    }
    return msg.content && (typeof msg.content === "string" ? msg.content.length > 0 : true);
  });

  // Step 6: Fix role alternation (merge consecutive same-role messages)
  const result: AnthropicMessage[] = [];
  for (const msg of filteredMessages) {
    if (result.length === 0) {
      result.push(msg);
      continue;
    }

    const lastMsg = result[result.length - 1];
    if (lastMsg.role === msg.role) {
      // Merge with previous message
      const toBlocks = (m: AnthropicMessage): ContentBlock[] => {
        if (typeof m.content === "string") {
          return [{ type: "text", text: m.content } as ContentBlock];
        }
        if (Array.isArray(m.content)) return m.content;
        return [];
      };
      lastMsg.content = [...toBlocks(lastMsg), ...toBlocks(msg)];
    } else {
      result.push(msg);
    }
  }

  // Step 7: Ensure first message is from user
  if (result.length > 0 && result[0].role !== "user") {
    result.unshift({ role: "user", content: "Continue." });
  }

  if (removedResults > 0 || removedUses > 0) {
    console.log(`   🧹 Cleaned up ${removedResults} orphaned tool_result(s) and ${removedUses} orphaned tool_use(s)`);
  }

  return result;
}

/**
 * Adjust selection boundary to avoid orphaning tool_use/tool_result pairs.
 * Returns the adjusted end index.
 */
function adjustBoundary(
  messages: AnthropicMessage[],
  start: number,
  end: number
): number {
  if (end >= messages.length) return end;

  // Collect tool_use IDs from the selected range
  const selectedToolUseIds = new Set<string>();
  for (let i = start; i < end; i++) {
    const msg = messages[i];
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_use" && block.id) {
          selectedToolUseIds.add(block.id);
        }
      }
    }
  }

  // Check if the message right after our selection has tool_results referencing our tool_uses
  let adjusted = end;
  while (adjusted < messages.length) {
    const msg = messages[adjusted];
    if (msg.role !== "user" || !Array.isArray(msg.content)) break;

    const hasOrphanedResult = msg.content.some(
      (block) =>
        block.type === "tool_result" &&
        block.tool_use_id &&
        selectedToolUseIds.has(block.tool_use_id)
    );

    if (hasOrphanedResult) {
      adjusted++; // include this user message (tool_result)
      // Also check if there's a following assistant message to keep pairs clean
      if (
        adjusted < messages.length &&
        messages[adjusted].role === "assistant"
      ) {
        // Check if this assistant msg has tool_uses whose results are outside our range
        // If so, include it too
        const assistantMsg = messages[adjusted];
        if (Array.isArray(assistantMsg.content)) {
          const hasToolUse = assistantMsg.content.some(
            (b) => b.type === "tool_use"
          );
          if (hasToolUse) {
            adjusted++;
            continue; // re-check for cascading dependencies
          }
        }
      }
      break;
    }
    break;
  }

  return adjusted;
}

interface SummarizeResult {
  request: AnthropicRequest;
  finalTokenCount: number;
  countSource: "api" | "estimate";
}

/**
 * Summarize selected messages to reduce context size.
 * Uses INCREMENTAL summarization: caches the summary and only processes
 * new (delta) messages on subsequent requests, dramatically reducing latency.
 *
 * Flow:
 * 1. Cold start: full summarization of middle messages, cache result
 * 2. Cache hit: merge only new (delta) messages into existing summary (~5s vs ~33s)
 * 3. After MAX_INCREMENTAL_MERGES: force full re-summarization (quality compaction)
 *
 * @param req - The request to summarize
 * @param config - Context configuration
 * @param currentTokenCount - Accurate token count (from API if available)
 */
async function summarizeContext(
  req: AnthropicRequest,
  config: ContextConfig,
  currentTokenCount: number
): Promise<SummarizeResult> {
  let result: AnthropicRequest = JSON.parse(JSON.stringify(req));
  let countSource: "api" | "estimate" = "estimate";

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    // Use targetTokens (180K) not maxTokens (200K) - we want a safety margin!
    if (currentTokenCount < config.targetTokens) {
      console.log(`   🔄 Token count ${Math.round(currentTokenCount / 1000)}K is below target ${Math.round(config.targetTokens / 1000)}K, done.`);
      break;
    }

    const messages = result.messages;
    const middleStart = Math.min(PROTECT_FIRST, messages.length);
    const middleEnd = Math.max(middleStart, messages.length - PROTECT_LAST);
    const totalMiddle = middleEnd - middleStart;

    if (middleStart >= middleEnd) {
      console.log(
        `   Not enough middle messages to summarize (${messages.length} total, protecting first ${PROTECT_FIRST} + last ${PROTECT_LAST})`
      );
      break;
    }

    // Check for incremental cache (use `result` not `req` — on iteration 2+, result has been modified)
    const cached = getIncrementalCache(result, middleStart);
    let summary: string;
    let summarizedUpToOffset: number;
    let mergeCount: number;

    if (cached && cached.summarizedUpToOffset > 0) {
      // === INCREMENTAL PATH ===
      const alreadySummarized = cached.summarizedUpToOffset;

      if (alreadySummarized >= totalMiddle) {
        // Full cache hit: all middle messages already summarized
        summary = cached.summaryText;
        summarizedUpToOffset = totalMiddle; // Cap to actual middle range (don't exceed into protected zone)
        mergeCount = cached.incrementalMergeCount;
        console.log(
          `   🔄 [Full Cache Hit] All ${alreadySummarized} middle messages already summarized, reusing (~0s)`
        );
      } else if (cached.incrementalMergeCount >= MAX_INCREMENTAL_MERGES) {
        // Quality compaction: too many incremental merges, force full re-summarization
        console.log(
          `   🔄 [Compaction] Merge count ${cached.incrementalMergeCount} >= ${MAX_INCREMENTAL_MERGES}, forcing full re-summarization`
        );

        // Summarize ALL middle messages
        let selectEnd = Math.min(
          adjustBoundary(messages, middleStart, middleEnd),
          middleEnd
        );
        const toSummarize = messages.slice(middleStart, selectEnd);
        if (toSummarize.length === 0) break;

        const summarizeTokens = toSummarize.reduce(
          (sum, msg) => sum + countMessageTokens(msg),
          0
        );

        console.log(
          `   🔄 Full re-summarizing ${toSummarize.length} messages (~${Math.round(summarizeTokens / 1000)}K tokens)`
        );
        console.log(`   🔄 Calling ${config.summarizationModel}...`);

        const startTime = Date.now();
        summary = await callSummarizationAPI(toSummarize, config);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        const quality = validateSummaryQuality(summary, summarizeTokens);
        if (!quality.valid) {
          throw new Error(`Compaction summarization quality check failed: ${quality.reason}`);
        }

        const summaryTokensEst = Math.ceil(summary.length / 3.5);
        console.log(
          `   🔄 Summary: ~${Math.round(summaryTokensEst / 1000)}K tokens (${Math.round((1 - summaryTokensEst / summarizeTokens) * 100)}% compression) in ${elapsed}s`
        );

        summarizedUpToOffset = selectEnd - middleStart;
        mergeCount = 0; // Reset merge count after compaction
      } else {
        // Incremental merge: summarize only the delta (new messages since last cache)
        const deltaStart = middleStart + alreadySummarized;
        let deltaEnd = Math.min(
          adjustBoundary(messages, deltaStart, middleEnd),
          middleEnd
        );

        const deltaMessages = messages.slice(deltaStart, deltaEnd);

        // Safety check: if the delta is very large, it means the cold start only
        // partially summarized (by token budget) and there are many unsummarized old
        // messages. In this case, don't use the incremental API — fall through to
        // cold start which handles token-budget-based selection properly.
        const MAX_INCREMENTAL_DELTA = 30; // max messages for incremental merge
        const deltaTokens = deltaMessages.reduce(
          (sum, msg) => sum + countMessageTokens(msg),
          0
        );

        if (deltaMessages.length === 0) {
          // No new messages to merge
          summary = cached.summaryText;
          summarizedUpToOffset = alreadySummarized;
          mergeCount = cached.incrementalMergeCount;
          console.log(`   🔄 [Incremental] No new messages to merge, reusing cached summary`);
        } else if (deltaMessages.length > MAX_INCREMENTAL_DELTA || deltaTokens > 40000) {
          // Delta too large for incremental merge — discard cache and use cold start
          // This happens when the previous cold start only partially summarized (token budget)
          // and there are many unsummarized messages remaining.
          console.log(
            `   🔄 [Incremental] Delta too large (${deltaMessages.length} messages, ~${Math.round(deltaTokens / 1000)}K tokens) for incremental merge, using cold start instead`
          );
          // Null out cached so we fall through to the cold start below
          // We need to break out of the incremental path — use a flag
          // Re-run as cold start by computing token-budget-based selection
          const counts = countTokens(result);
          const excess = currentTokenCount - config.targetTokens;
          const tokensToSelect = Math.ceil(excess / (1 - COMPRESSION_RATIO));

          let accumulated = 0;
          let selectEnd = middleStart;
          for (let i = middleStart; i < middleEnd && accumulated < tokensToSelect; i++) {
            accumulated += counts.messages[i];
            selectEnd = i + 1;
          }
          selectEnd = Math.min(adjustBoundary(messages, middleStart, selectEnd), middleEnd);

          const toSummarize = messages.slice(middleStart, selectEnd);
          if (toSummarize.length === 0) break;

          const summarizeTokens = toSummarize.reduce(
            (sum, msg) => sum + countMessageTokens(msg),
            0
          );

          console.log(
            `   🔄 [Cold Start Fallback] Summarizing ${toSummarize.length} messages (~${Math.round(summarizeTokens / 1000)}K tokens)`
          );
          console.log(`   🔄 Calling ${config.summarizationModel}...`);

          const startTime = Date.now();
          summary = await callSummarizationAPI(toSummarize, config);
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

          const quality = validateSummaryQuality(summary, summarizeTokens);
          if (!quality.valid) {
            throw new Error(`Summarization quality check failed: ${quality.reason}`);
          }

          const summaryTokensEst = Math.ceil(summary.length / 3.5);
          console.log(
            `   🔄 Summary: ~${Math.round(summaryTokensEst / 1000)}K tokens (${Math.round((1 - summaryTokensEst / summarizeTokens) * 100)}% compression) in ${elapsed}s`
          );

          summarizedUpToOffset = selectEnd - middleStart;
          mergeCount = 0;
        } else {
          console.log(
            `   🔄 [Incremental] Merging ${deltaMessages.length} new messages (~${Math.round(deltaTokens / 1000)}K tokens) into existing summary (merge #${cached.incrementalMergeCount + 1})`
          );
          console.log(`   🔄 Calling ${config.summarizationModel} (incremental)...`);

          const startTime = Date.now();
          summary = await callIncrementalSummarizationAPI(
            cached.summaryText,
            deltaMessages,
            config
          );
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

          // Quality check: use combined token estimate (existing summary + delta)
          const combinedTokenEstimate = cached.summaryTokens + deltaTokens;
          const quality = validateSummaryQuality(summary, combinedTokenEstimate);

          if (!quality.valid) {
            // Incremental merge produced bad result — fallback to full re-summarization
            console.warn(
              `   ⚠️ [Incremental] Quality check failed (${quality.reason}), falling back to full re-summarization`
            );

            const allMiddle = messages.slice(middleStart, middleEnd);
            const allMiddleTokens = allMiddle.reduce(
              (sum, msg) => sum + countMessageTokens(msg),
              0
            );

            console.log(`   🔄 Calling ${config.summarizationModel} (full fallback)...`);
            const fbStartTime = Date.now();
            summary = await callSummarizationAPI(allMiddle, config);
            const fbElapsed = ((Date.now() - fbStartTime) / 1000).toFixed(1);

            const fbQuality = validateSummaryQuality(summary, allMiddleTokens);
            if (!fbQuality.valid) {
              throw new Error(
                `Full fallback summarization quality check failed: ${fbQuality.reason}`
              );
            }

            const fbSummaryTokens = Math.ceil(summary.length / 3.5);
            console.log(
              `   🔄 Summary (fallback): ~${Math.round(fbSummaryTokens / 1000)}K tokens (${Math.round((1 - fbSummaryTokens / allMiddleTokens) * 100)}% compression) in ${fbElapsed}s`
            );

            summarizedUpToOffset = middleEnd - middleStart;
            mergeCount = 0;
          } else {
            const summaryTokensEst = Math.ceil(summary.length / 3.5);
            console.log(
              `   🔄 [Incremental] Merged: ~${Math.round(summaryTokensEst / 1000)}K tokens in ${elapsed}s`
            );
            summarizedUpToOffset = deltaEnd - middleStart;
            mergeCount = cached.incrementalMergeCount + 1;
          }
        }
      }
    } else {
      // === COLD START: Full summarization (same as original behavior) ===
      const counts = countTokens(result);
      const excess = currentTokenCount - config.targetTokens;
      const tokensToSelect = Math.ceil(excess / (1 - COMPRESSION_RATIO));

      console.log(
        `   🔄 Need to reduce ${Math.round(excess / 1000)}K tokens, selecting ~${Math.round(tokensToSelect / 1000)}K to summarize`
      );

      // Accumulate messages from middleStart until we cover tokensToSelect
      let accumulated = 0;
      let selectEnd = middleStart;
      for (let i = middleStart; i < middleEnd && accumulated < tokensToSelect; i++) {
        accumulated += counts.messages[i];
        selectEnd = i + 1;
      }

      // Adjust boundary to avoid orphaning tool pairs (capped at middleEnd)
      selectEnd = Math.min(adjustBoundary(messages, middleStart, selectEnd), middleEnd);

      const toSummarize = messages.slice(middleStart, selectEnd);
      if (toSummarize.length === 0) break;

      const summarizeTokens = toSummarize.reduce(
        (sum, msg) => sum + countMessageTokens(msg),
        0
      );

      console.log(
        `   🔄 [Cold Start] Summarizing ${toSummarize.length} messages (~${Math.round(summarizeTokens / 1000)}K tokens)`
      );
      console.log(`   🔄 Calling ${config.summarizationModel}...`);

      const startTime = Date.now();
      summary = await callSummarizationAPI(toSummarize, config);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      const quality = validateSummaryQuality(summary, summarizeTokens);
      if (!quality.valid) {
        throw new Error(`Summarization quality check failed: ${quality.reason}`);
      }

      const summaryTokensEst = Math.ceil(summary.length / 3.5);
      console.log(
        `   🔄 Summary: ~${Math.round(summaryTokensEst / 1000)}K tokens (${Math.round((1 - summaryTokensEst / summarizeTokens) * 100)}% compression) in ${elapsed}s`
      );

      summarizedUpToOffset = selectEnd - middleStart;
      mergeCount = 0;
    }

    // Cache the result for future incremental use (use `result` not `req` — matches what getIncrementalCache validates against)
    cacheIncrementalSummary(
      result,
      middleStart,
      summarizedUpToOffset,
      summary,
      Math.ceil(summary.length / 3.5),
      mergeCount
    );

    // Replace summarized messages with summary pair
    const replaceEnd = middleStart + summarizedUpToOffset;
    const before = messages.slice(0, middleStart);
    const after = messages.slice(replaceEnd);

    result.messages = [
      ...before,
      {
        role: "user" as const,
        content: `[Context Summary - ${summarizedUpToOffset} messages summarized]\n\n${summary}`,
      },
      {
        role: "assistant" as const,
        content:
          "Understood. I have the summarized context and will continue accordingly.",
      },
      ...after,
    ];

    // Clean up any orphaned tool_use/tool_result pairs
    result.messages = cleanupOrphanedToolPairs(result.messages);

    // Get accurate token count after summarization
    const postEstimate = countTokens(result);
    let newTokenCount: number;

    // If estimate is still near the limit, get accurate API count
    if (postEstimate.total >= config.targetTokens * 0.9) {
      console.log(`   🔄 Re-counting tokens via API (estimate ~${Math.round(postEstimate.total / 1000)}K)...`);
      const apiResult = await countTokensAPI(result);
      newTokenCount = apiResult.inputTokens;
      countSource = apiResult.source;
      if (apiResult.source === "api") {
        console.log(`   🔄 API count: ${Math.round(newTokenCount / 1000)}K tokens`);
      }
    } else {
      newTokenCount = postEstimate.total;
      countSource = "estimate";
    }

    console.log(
      `   🔄 Iteration ${iter + 1}: ${Math.round(currentTokenCount / 1000)}K → ${Math.round(newTokenCount / 1000)}K tokens`
    );

    // Update for next iteration
    currentTokenCount = newTokenCount;
  }

  return { request: result, finalTokenCount: currentTokenCount, countSource };
}

/**
 * Emergency fallback: trim context by dropping old messages.
 * Uses API token counts for accuracy when near the limit.
 */
async function trimToFitContext(
  result: AnthropicRequest,
  targetTokens: number,
  maxTokens: number
): Promise<AnthropicRequest> {
  let counts = countTokens(result);
  if (counts.total <= targetTokens) return result;

  const originalTotal = counts.total;
  console.log(
    `\n✂️  [Trim Fallback] Context too large: ~${Math.round(counts.total / 1000)}K tokens (target: ${Math.round(targetTokens / 1000)}K)`
  );

  // Step 1: Truncate tool descriptions to 500 chars
  if (result.tools) {
    for (const tool of result.tools as any[]) {
      if (tool.description && tool.description.length > 500) {
        tool.description = tool.description.slice(0, 497) + "...";
      }
    }
    counts = countTokens(result);
    console.log(
      `   Step 1 (trim tool descriptions): ~${Math.round(counts.total / 1000)}K tokens`
    );
  }

  // Step 2: Truncate large content blocks
  for (const msg of result.messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (
          block.type === "tool_result" &&
          typeof block.content === "string" &&
          block.content.length > 2000
        ) {
          block.content =
            block.content.slice(0, 1000) +
            "\n\n...[trimmed for context limit]...\n\n" +
            block.content.slice(-1000);
        }
        if (block.type === "tool_use" && block.input) {
          const inputStr = JSON.stringify(block.input);
          if (inputStr.length > 4000) {
            const trimmedInput: Record<string, unknown> = {};
            for (const [key, val] of Object.entries(
              block.input as Record<string, unknown>
            )) {
              if (typeof val === "string" && val.length > 2000) {
                trimmedInput[key] =
                  val.slice(0, 1000) + "\n...[trimmed]...\n" + val.slice(-1000);
              } else {
                trimmedInput[key] = val;
              }
            }
            block.input = trimmedInput;
          }
        }
        if (block.type === "text" && block.text && block.text.length > 8000) {
          block.text =
            block.text.slice(0, 4000) +
            "\n\n...[trimmed for context limit]...\n\n" +
            block.text.slice(-4000);
        }
      }
    }
    if (typeof msg.content === "string" && msg.content.length > 8000) {
      msg.content =
        msg.content.slice(0, 4000) +
        "\n\n...[trimmed for context limit]...\n\n" +
        msg.content.slice(-4000);
    }
  }
  counts = countTokens(result);
  console.log(
    `   Step 2 (trim large content blocks): ~${Math.round(counts.total / 1000)}K tokens`
  );

  // Step 3: Drop oldest middle messages using API counts for accuracy
  // Get accurate count before heavy dropping
  let apiResult = await countTokensAPI(result);
  let currentTokens = apiResult.inputTokens;
  let usingEstimate = apiResult.source === "estimate";
  if (usingEstimate) {
    console.log(`   ⚠️ Step 3: API count unavailable, using estimate: ~${Math.round(currentTokens / 1000)}K tokens`);
  } else {
    console.log(`   Step 3: API count before dropping: ${Math.round(currentTokens / 1000)}K tokens`);
  }

  const keepStart = 2; // Keep first 2 messages (system context)
  const minMessages = 4; // Minimum messages to keep
  let removed = 0;

  while (
    currentTokens > targetTokens &&
    result.messages.length > minMessages
  ) {
    result.messages.splice(keepStart, 2);
    removed += 2;

    // Re-check with API every 4 messages dropped (balance accuracy vs API calls)
    if (removed % 4 === 0 || result.messages.length <= minMessages + 2) {
      apiResult = await countTokensAPI(result);
      currentTokens = apiResult.inputTokens;
      usingEstimate = apiResult.source === "estimate";
    } else {
      // Quick estimate between API calls to avoid over-dropping
      const est = countTokens(result);
      if (est.total <= targetTokens) {
        // Estimate says we're probably under target — verify with API before stopping
        apiResult = await countTokensAPI(result);
        currentTokens = apiResult.inputTokens;
        usingEstimate = apiResult.source === "estimate";
      }
    }
  }

  if (removed > 0) {
    // Clean up orphaned tool_result blocks
    const validToolUseIds = new Set<string>();
    for (const msg of result.messages) {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "tool_use" && block.id) {
            validToolUseIds.add(block.id);
          }
        }
      }
    }

    for (let i = result.messages.length - 1; i >= 0; i--) {
      const msg = result.messages[i];
      if (msg.role === "user" && Array.isArray(msg.content)) {
        msg.content = msg.content.filter((block: any) => {
          if (block.type === "tool_result" && block.tool_use_id) {
            return validToolUseIds.has(block.tool_use_id);
          }
          return true;
        });
        if (msg.content.length === 0) {
          result.messages.splice(i, 1);
        }
      }
    }

    // Clean up orphaned tool_use blocks
    const validToolResultIds = new Set<string>();
    for (const msg of result.messages) {
      if (msg.role === "user" && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "tool_result" && block.tool_use_id) {
            validToolResultIds.add(block.tool_use_id);
          }
        }
      }
    }

    for (let i = result.messages.length - 1; i >= 0; i--) {
      const msg = result.messages[i];
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        msg.content = msg.content.filter((block: any) => {
          if (block.type === "tool_use" && block.id) {
            return validToolResultIds.has(block.id);
          }
          return true;
        });
        if (msg.content.length === 0) {
          result.messages.splice(i, 1);
        }
      }
    }

    // Fix role alternation
    for (let i = result.messages.length - 1; i > 0; i--) {
      if (result.messages[i].role === result.messages[i - 1].role) {
        const prev = result.messages[i - 1];
        const curr = result.messages[i];
        const toBlocks = (msg: any) => {
          if (typeof msg.content === "string")
            return [{ type: "text", text: msg.content }];
          if (Array.isArray(msg.content)) return msg.content;
          return [];
        };
        prev.content = [...toBlocks(prev), ...toBlocks(curr)];
        result.messages.splice(i, 1);
      }
    }

    if (
      result.messages.length > 0 &&
      result.messages[0].role !== "user"
    ) {
      result.messages.unshift({ role: "user", content: "Continue." });
    }

    // Get final count after cleanup
    apiResult = await countTokensAPI(result);
    currentTokens = apiResult.inputTokens;
    console.log(
      `   Step 3 (drop ${removed} middle messages, ${result.messages.length} remaining): ${Math.round(currentTokens / 1000)}K tokens (api)`
    );
  }

  // Step 4: Remove images if still over limit (last resort)
  if (currentTokens > maxTokens) {
    console.log(`   ⚠️ Still over limit (${Math.round(currentTokens / 1000)}K > ${Math.round(maxTokens / 1000)}K), removing images...`);
    let imagesRemoved = 0;
    for (const msg of result.messages) {
      if (Array.isArray(msg.content)) {
        const beforeCount = msg.content.length;
        msg.content = msg.content.filter((b: any) => b.type !== "image");
        imagesRemoved += beforeCount - msg.content.length;
      }
    }
    if (imagesRemoved > 0) {
      console.log(`   🗑️ Removed ${imagesRemoved} image(s)`);
      apiResult = await countTokensAPI(result);
      currentTokens = apiResult.inputTokens;
      console.log(`   Step 4: ${Math.round(currentTokens / 1000)}K tokens after image removal`);
    }
  }

  console.log(
    `   ✓ Trimmed: ${Math.round(originalTotal / 1000)}K → ${Math.round(currentTokens / 1000)}K tokens`
  );
  return result;
}

export interface ManageContextResult {
  request: AnthropicRequest;
  /** Token count BEFORE any summarization/trimming — what Cursor actually sent */
  originalTokenCount: number;
}

/**
 * Main entry point: manage context to fit within token limits.
 * Uses summarization (preferred) or trim (fallback).
 * Returns both the (possibly reduced) request AND the original token count
 * so callers can report accurate usage to clients like Cursor.
 *
 * Caching uses INCREMENTAL summarization inside summarizeContext():
 * - Cold start: full summarization, result cached with offset
 * - Subsequent requests: only new (delta) messages merged into cached summary (~5s vs ~33s)
 * - After MAX_INCREMENTAL_MERGES: full re-summarization for quality compaction
 * - Integrity validated via anchor hash + boundary hash
 */
export async function manageContext(
  req: AnthropicRequest
): Promise<ManageContextResult> {
  const config = getContextConfig();
  if (config.strategy === "none") {
    const estimate = countTokens(req);
    return { request: req, originalTokenCount: estimate.total };
  }

  // Quick character-based estimate first
  const estimate = countTokens(req);
  const msgTokensTotal = estimate.messages.reduce((a, b) => a + b, 0);

  // If estimate is within 15% of limit, get accurate API count
  const ACCURACY_THRESHOLD = config.maxTokens * 0.85; // 170K for 200K limit

  let tokenCount: number;
  let countSource: string;

  if (estimate.total >= ACCURACY_THRESHOLD) {
    console.log(
      `📊 [Tokens] Estimate ~${Math.round(estimate.total / 1000)}K (near ${Math.round(config.maxTokens / 1000)}K limit), getting accurate count...`
    );
    const apiResult = await countTokensAPI(req);
    tokenCount = apiResult.inputTokens;
    countSource = apiResult.source;
    if (apiResult.error) {
      console.log(`   ⚠ API count failed: ${apiResult.error}`);
    } else {
      console.log(`   ✓ API count: ${Math.round(tokenCount / 1000)}K tokens`);
    }
  } else {
    tokenCount = estimate.total;
    countSource = "estimate";
  }

  // Log final count
  console.log(
    `📊 [Tokens] ~${Math.round(tokenCount / 1000)}K total (${countSource}) | system: ~${Math.round(estimate.system / 1000)}K, messages: ~${Math.round(msgTokensTotal / 1000)}K × ${req.messages.length}, tools: ~${Math.round(estimate.tools / 1000)}K | limit: ${Math.round(config.maxTokens / 1000)}K`
  );

  // Preserve the ORIGINAL token count before any summarization/trimming
  const originalTokenCount = tokenCount;

  if (tokenCount < config.maxTokens) {
    return { request: req, originalTokenCount };
  }

  console.log(
    `\n🔄 [Summarization] Exceeds limit by ~${Math.round((tokenCount - config.maxTokens) / 1000)}K tokens, reducing to ${Math.round(config.targetTokens / 1000)}K target...`
  );
  console.log(
    `   Strategy: ${config.strategy}`
  );

  // Handle based on strategy
  if (config.strategy === "summarize") {
    try {
      // Pass the accurate token count to summarizeContext
      const summarized = await summarizeContext(req, config, tokenCount);
      let result = summarized.request;
      let finalTokenCount = summarized.finalTokenCount;

      // If summarizeContext used estimate, verify with API before deciding
      if (summarized.countSource === "estimate" && finalTokenCount >= config.targetTokens * 0.9) {
        const verifyResult = await countTokensAPI(result);
        finalTokenCount = verifyResult.inputTokens;
        console.log(`   ✅ Summarization complete: ${Math.round(finalTokenCount / 1000)}K tokens (verified via ${verifyResult.source})`);
      } else {
        console.log(`   ✅ Summarization complete: ${Math.round(finalTokenCount / 1000)}K tokens (${summarized.countSource})`);
      }

      // If still over the hard limit, fall back to trimming
      if (finalTokenCount >= config.maxTokens) {
        console.log(`   ⚠️ Still over limit after summarization (${Math.round(finalTokenCount / 1000)}K >= ${Math.round(config.maxTokens / 1000)}K), applying trim fallback...`);
        result = await trimToFitContext(result, config.targetTokens, config.maxTokens);

        // Re-count after trimming
        const trimApiResult = await countTokensAPI(result);
        finalTokenCount = trimApiResult.inputTokens;
        console.log(`   ✅ After trimming: ${Math.round(finalTokenCount / 1000)}K tokens (${trimApiResult.source})`);

        // If STILL over limit after both summarization and trimming, this is truly critical
        if (finalTokenCount >= config.maxTokens) {
          console.error(`   ❌ CRITICAL: Still over limit after summarization AND trimming (${Math.round(finalTokenCount / 1000)}K >= ${Math.round(config.maxTokens / 1000)}K)`);
          console.error(`   ❌ Request may be fundamentally too large (e.g., single huge message or too many large images)`);

          const dumpFile = `context-dump-${Date.now()}.json`;
          try {
            const dumpData = {
              timestamp: new Date().toISOString(),
              finalTokenCount,
              maxTokens: config.maxTokens,
              targetTokens: config.targetTokens,
              strategy: config.strategy,
              request: result
            };
            await Bun.write(dumpFile, JSON.stringify(dumpData, null, 2));
            console.error(`   📄 Dumped full context to ${dumpFile}`);
          } catch (dumpErr) {
            console.error(`   ❌ Failed to dump context: ${dumpErr}`);
          }

          throw new Error(`Cannot reduce context below ${config.maxTokens} tokens (final: ${finalTokenCount})`);
        }
      }

      return { request: result, originalTokenCount };
    } catch (err) {
      console.error(`   ❌ Context management failed:`, err);
      throw err;
    }
  } else if (config.strategy === "trim") {
    const trimmed = await trimToFitContext(JSON.parse(JSON.stringify(req)), config.targetTokens, config.maxTokens);
    return { request: trimmed, originalTokenCount };
  }

  // Strategy is "none" but we're over limit - shouldn't happen (we returned early)
  // but just in case, throw an error
  throw new Error(`Context exceeds ${config.maxTokens} tokens and strategy is "${config.strategy}"`);
}
