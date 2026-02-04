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
const MAX_ITERATIONS = 2;

// --- Summarization Cache ---
// Prevents re-summarizing the same messages multiple times.
//
// STRATEGY: We cache the summary TEXT for a specific set of messages (identified by content hash).
// This ensures:
// 1. Same messages to summarize = cache hit (fast, reuse previous summary)
// 2. Different messages = cache miss (re-summarize to avoid stale data)
//
// LIMITATION: If the conversation grows by adding new messages in the "middle section"
// (between PROTECT_FIRST and PROTECT_LAST), the cache won't help because we're summarizing
// a different set of messages. This happens during sequential tool calls where each request
// has the full original conversation + new tool results.
//
// WHEN CACHE HELPS:
// - Retries (same request sent again)
// - Parallel tool calls (same conversation in multiple concurrent requests)
// - Any case where the exact same messages need summarization

interface SummarizationCacheEntry {
  // Hash of the messages that were summarized (the "middle section")
  summarizedMessagesHash: string;
  // The summary text that replaced those messages
  summaryText: string;
  // Number of messages that were summarized
  summarizedCount: number;
  // Timestamp for TTL
  timestamp: number;
}

const summarizationCache = new Map<string, SummarizationCacheEntry>();
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
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
 * Check if we can reuse a cached summary for this request.
 *
 * CACHING STRATEGY:
 * We cache the summary TEXT for a specific set of messages (identified by content hash).
 * Cache hit only if we're summarizing the EXACT same messages (same content, same count).
 *
 * This is conservative but safe:
 * - Same messages = reuse summary (fast!)
 * - Any change in messages = re-summarize (no stale data)
 *
 * Returns the cached summary info if applicable, null otherwise.
 */
function getCachedSummary(
  req: AnthropicRequest,
  toSummarize: AnthropicMessage[]
): SummarizationCacheEntry | null {
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

  // Cache hit ONLY if we're summarizing the exact same messages
  if (toSummarize.length !== cached.summarizedCount) {
    console.log(
      `📦 [Cache Miss] Message count changed: cached ${cached.summarizedCount} vs current ${toSummarize.length}`
    );
    return null;
  }

  const currentHash = hashMessages(toSummarize);
  if (currentHash !== cached.summarizedMessagesHash) {
    console.log(
      `📦 [Cache Miss] Message content changed (hash mismatch)`
    );
    return null;
  }

  console.log(
    `📦 [Cache Hit] Reusing cached summary for ${cached.summarizedCount} messages (conv: ${conversationId.slice(0, 8)}...)`
  );
  return cached;
}

/**
 * Store a summary in the cache for future reuse.
 */
function cacheSummary(
  req: AnthropicRequest,
  summarizedMessages: AnthropicMessage[],
  summaryText: string
): void {
  const conversationId = getConversationId(req);
  const messagesHash = hashMessages(summarizedMessages);

  summarizationCache.set(conversationId, {
    summarizedMessagesHash: messagesHash,
    summaryText: summaryText,
    summarizedCount: summarizedMessages.length,
    timestamp: Date.now(),
  });

  cleanupCache();
  console.log(
    `📦 [Cache Store] Cached summary of ${summarizedMessages.length} messages (conv: ${conversationId.slice(0, 8)}...)`
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
    maxTokens: parseInt(process.env.CONTEXT_MAX_TOKENS || "200000"),
    targetTokens: parseInt(process.env.CONTEXT_TARGET_TOKENS || "180000"),
  };
}

/**
 * Format messages into a readable transcript for summarization.
 * Preserves full content for quality summarization, with a cap to avoid
 * exceeding the summarization model's own context limit.
 */
function formatTranscript(messages: AnthropicMessage[]): string {
  const MAX_TRANSCRIPT_CHARS = 400000; // ~115K tokens at 3.5 chars/token — safe for most models

  let transcript = messages
    .map((m) => {
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
      return `[${m.role.toUpperCase()}]:\n${text}`;
    })
    .join("\n\n---\n\n");

  // Cap transcript to avoid exceeding summarization model's context
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    transcript =
      transcript.slice(0, MAX_TRANSCRIPT_CHARS / 2) +
      "\n\n...[transcript truncated for summarization limit]...\n\n" +
      transcript.slice(-MAX_TRANSCRIPT_CHARS / 2);
  }

  return transcript;
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

  // Build request with required Claude Code system prompt
  const systemBlocks = [
    { type: "text", text: CLAUDE_CODE_SYSTEM_PROMPT },
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
      max_tokens: 4096,
      stream: false,
      system: systemBlocks,
      messages: [
        {
          role: "user",
          content: `You are a conversation summarizer for a coding assistant. Summarize the following conversation excerpt concisely, preserving ALL of the following:

- Key decisions and conclusions reached
- Important code snippets, file paths, and technical details
- Tool calls and their significant results
- The user's goals, requirements, and preferences
- Any unresolved questions or action items
- Error messages and their resolutions

Be dense and factual. Preserve technical accuracy. Output only the summary.

---

${transcript}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "unknown");
    throw new Error(
      `Summarization API returned ${response.status}: ${errorText}`
    );
  }

  const data = (await response.json()) as AnthropicResponse;
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

/**
 * Summarize selected messages to reduce context size.
 * Uses cache to avoid re-summarizing the same messages on subsequent requests.
 *
 * @param req - The request to summarize
 * @param config - Context configuration
 * @param currentTokenCount - Accurate token count (from API if available)
 */
async function summarizeContext(
  req: AnthropicRequest,
  config: ContextConfig,
  currentTokenCount: number
): Promise<AnthropicRequest> {
  let result = structuredClone(req);

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    // Use targetTokens (180K) not maxTokens (200K) - we want a safety margin!
    if (currentTokenCount < config.targetTokens) {
      console.log(`   🔄 Token count ${Math.round(currentTokenCount / 1000)}K is below target ${Math.round(config.targetTokens / 1000)}K, done.`);
      break;
    }

    // Get per-message token counts for selection (estimate is fine for relative sizing)
    const counts = countTokens(result);

    // Use accurate currentTokenCount for excess calculation
    const excess = currentTokenCount - config.targetTokens;
    const tokensToSelect = Math.ceil(excess / (1 - COMPRESSION_RATIO));

    console.log(`   🔄 Need to reduce ${Math.round(excess / 1000)}K tokens, selecting ~${Math.round(tokensToSelect / 1000)}K to summarize`);

    const messages = result.messages;
    const middleStart = Math.min(PROTECT_FIRST, messages.length);
    const middleEnd = Math.max(middleStart, messages.length - PROTECT_LAST);

    if (middleStart >= middleEnd) {
      console.log(
        `   Not enough middle messages to summarize (${messages.length} total, protecting first ${PROTECT_FIRST} + last ${PROTECT_LAST})`
      );
      break;
    }

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

    // Check if we have a cached summary for these exact messages
    const cached = getCachedSummary(req, toSummarize);
    let summary: string;

    if (cached) {
      // CACHE HIT: Reuse the cached summary
      summary = cached.summaryText;
      console.log(
        `   🔄 Reusing cached summary for ${toSummarize.length} messages (~${Math.round(summarizeTokens / 1000)}K tokens)`
      );
    } else {
      // CACHE MISS: Need to call API
      console.log(
        `   🔄 Selecting ${toSummarize.length} messages (~${Math.round(summarizeTokens / 1000)}K tokens) for summarization`
      );
      console.log(
        `   🔄 Calling ${config.summarizationModel}...`
      );

      const startTime = Date.now();
      summary = await callSummarizationAPI(toSummarize, config);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      // Validate summary is not empty
      if (!summary || summary.trim().length < 50) {
        throw new Error(`Summarization returned empty or too short result (${summary?.length || 0} chars)`);
      }

      const summaryTokens = Math.ceil(summary.length / 3.5);

      console.log(
        `   🔄 Summary: ~${Math.round(summaryTokens / 1000)}K tokens (${Math.round((1 - summaryTokens / summarizeTokens) * 100)}% compression) in ${elapsed}s`
      );

      // Cache the summary for future requests
      cacheSummary(req, toSummarize, summary);
    }

    const summaryTokens = Math.ceil(summary.length / 3.5);

    // Replace selected messages with summary pair
    const before = messages.slice(0, middleStart);
    const after = messages.slice(selectEnd);

    result.messages = [
      ...before,
      {
        role: "user" as const,
        content: `[Context Summary - ${toSummarize.length} messages summarized]\n\n${summary}`,
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
    const estimate = countTokens(result);
    let newTokenCount: number;

    // If estimate is still near the limit, get accurate API count
    if (estimate.total >= config.targetTokens * 0.9) {
      console.log(`   🔄 Re-counting tokens via API (estimate ~${Math.round(estimate.total / 1000)}K)...`);
      const apiResult = await countTokensAPI(result);
      newTokenCount = apiResult.inputTokens;
      if (apiResult.source === "api") {
        console.log(`   🔄 API count: ${Math.round(newTokenCount / 1000)}K tokens`);
      }
    } else {
      newTokenCount = estimate.total;
    }

    console.log(
      `   🔄 Iteration ${iter + 1}: ${Math.round(currentTokenCount / 1000)}K → ${Math.round(newTokenCount / 1000)}K tokens`
    );

    // Update for next iteration
    currentTokenCount = newTokenCount;
  }

  return result;
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
  console.log(`   Step 3: API count before dropping: ${Math.round(currentTokens / 1000)}K tokens`);

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

/**
 * Main entry point: manage context to fit within token limits.
 * Uses summarization (preferred) or trim (fallback).
 *
 * Caching is handled inside summarizeContext() - it caches the summary TEXT
 * for specific message ranges, not the full request. This ensures:
 * - Same messages being summarized = reuse cached summary (fast!)
 * - New messages added = only new content triggers re-summarization
 * - Different content = no stale data returned
 */
export async function manageContext(
  req: AnthropicRequest
): Promise<AnthropicRequest> {
  const config = getContextConfig();
  if (config.strategy === "none") return req;

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

  if (tokenCount < config.maxTokens) return req;

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
      let result = await summarizeContext(req, config, tokenCount);

      // Get final accurate count
      const finalApiResult = await countTokensAPI(result);
      let finalTokenCount = finalApiResult.inputTokens;
      console.log(`   ✅ Summarization complete: ${Math.round(finalTokenCount / 1000)}K tokens (${finalApiResult.source})`);

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

      return result;
    } catch (err) {
      console.error(`   ❌ Context management failed:`, err);
      throw err;
    }
  } else if (config.strategy === "trim") {
    return await trimToFitContext(structuredClone(req), config.targetTokens, config.maxTokens);
  }

  // Strategy is "none" but we're over limit - shouldn't happen (we returned early)
  // but just in case, throw an error
  throw new Error(`Context exceeds ${config.maxTokens} tokens and strategy is "${config.strategy}"`);
}
