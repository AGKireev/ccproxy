/**
 * Context trimmer — emergency truncation for "prompt is too long" errors.
 *
 * Ported from the old v1 context-manager.ts trimming logic.
 * NO summarization, NO API calls, NO caching — pure local truncation.
 *
 * Design:
 * - Only invoked on retry after the API returns "prompt is too long: N tokens > 200000 maximum"
 * - Each attempt trims progressively more aggressively (attempt 1 = gentle, 3 = aggressive)
 * - Preserves structural integrity: tool_use/tool_result pairs, user/assistant alternation
 * - Uses character-based token estimation (fast, no network calls)
 */

import type { AnthropicRequest, AnthropicMessage, ContentBlock } from "./types";
import { countTokens, countMessageTokens } from "./token-counter";

// --- Configuration ---
// Protection zones shrink with each attempt to shed more tokens
const ATTEMPT_CONFIG = [
  // Attempt 1 (gentle): only truncate oversized content blocks
  { protectFirst: 3, protectLast: 10, targetTokens: 195000, truncateToolDescs: false, removeImages: false },
  // Attempt 2 (moderate): drop oldest middle messages
  { protectFirst: 3, protectLast: 10, targetTokens: 190000, truncateToolDescs: false, removeImages: false },
  // Attempt 3 (aggressive): smaller protection zones, truncate tool descriptions, remove images
  { protectFirst: 2, protectLast: 6, targetTokens: 180000, truncateToolDescs: true, removeImages: true },
];

export interface TrimResult {
  request: AnthropicRequest;
  messagesBefore: number;
  messagesAfter: number;
  estimatedTokens: number;
}

/**
 * Main entry point: trim the request body to fit within the token limit.
 *
 * @param request - The Anthropic-format request body (will be deep-cloned, original not mutated)
 * @param actualTokens - The actual token count reported by the API error
 * @param maxTokens - The maximum allowed tokens reported by the API error
 * @param attempt - The attempt number (0-indexed: 0, 1, 2)
 */
export function trimForRetry(
  request: AnthropicRequest,
  actualTokens: number,
  maxTokens: number,
  attempt: number
): TrimResult {
  // Deep clone to avoid mutating the original
  const trimmed: AnthropicRequest = JSON.parse(JSON.stringify(request));
  const messagesBefore = trimmed.messages.length;
  const configIndex = Math.min(attempt, ATTEMPT_CONFIG.length - 1);
  const config = ATTEMPT_CONFIG[configIndex]!;
  const excess = actualTokens - maxTokens;

  console.log(`   [Trim] Attempt ${attempt + 1}/3: excess=${excess} tokens, target=${Math.round(config.targetTokens / 1000)}K, protect first ${config.protectFirst} + last ${config.protectLast}`);

  // Step 1: Truncate oversized content blocks (all attempts)
  truncateLargeContentBlocks(trimmed);

  // Step 2: Truncate tool descriptions (attempt 3 only)
  if (config.truncateToolDescs) {
    truncateToolDescriptions(trimmed);
  }

  // Step 3: Drop middle messages if still over target (attempts 2+)
  if (attempt >= 1) {
    dropMiddleMessages(trimmed, config.protectFirst, config.protectLast, config.targetTokens);
  }

  // Step 4: Remove images (attempt 3 only, last resort)
  if (config.removeImages) {
    removeImages(trimmed);
  }

  // Cleanup structural integrity after any removals
  trimmed.messages = cleanupOrphanedToolPairs(trimmed.messages);

  const estimatedTokens = countTokens(trimmed).total;
  const messagesAfter = trimmed.messages.length;

  console.log(`   [Trim] Result: ${messagesBefore} -> ${messagesAfter} messages, ~${Math.round(estimatedTokens / 1000)}K estimated tokens`);

  return { request: trimmed, messagesBefore, messagesAfter, estimatedTokens };
}

// --- Step 1: Truncate oversized content blocks ---

function truncateLargeContentBlocks(request: AnthropicRequest): void {
  let truncated = 0;

  for (const msg of request.messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        // Truncate large tool_result content (keep head + tail)
        if (
          block.type === "tool_result" &&
          typeof block.content === "string" &&
          block.content.length > 2000
        ) {
          block.content =
            block.content.slice(0, 1000) +
            "\n\n...[trimmed for context limit]...\n\n" +
            block.content.slice(-1000);
          truncated++;
        }

        // Truncate large tool_use inputs
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
            truncated++;
          }
        }

        // Truncate large text blocks (keep head + tail)
        if (block.type === "text" && block.text && block.text.length > 8000) {
          block.text =
            block.text.slice(0, 4000) +
            "\n\n...[trimmed for context limit]...\n\n" +
            block.text.slice(-4000);
          truncated++;
        }
      }
    }

    // Handle string content
    if (typeof msg.content === "string" && msg.content.length > 8000) {
      msg.content =
        msg.content.slice(0, 4000) +
        "\n\n...[trimmed for context limit]...\n\n" +
        msg.content.slice(-4000);
      truncated++;
    }
  }

  if (truncated > 0) {
    console.log(`   [Trim] Truncated ${truncated} oversized content block(s)`);
  }
}

// --- Step 2: Truncate tool descriptions ---

function truncateToolDescriptions(request: AnthropicRequest): void {
  if (!request.tools) return;

  let truncated = 0;
  for (const tool of request.tools as any[]) {
    if (tool.description && tool.description.length > 500) {
      tool.description = tool.description.slice(0, 497) + "...";
      truncated++;
    }
  }

  if (truncated > 0) {
    console.log(`   [Trim] Truncated ${truncated} tool description(s) to 500 chars`);
  }
}

// --- Step 3: Drop oldest middle messages ---

function dropMiddleMessages(
  request: AnthropicRequest,
  protectFirst: number,
  protectLast: number,
  targetTokens: number
): void {
  const messages = request.messages;
  const middleStart = Math.min(protectFirst, messages.length);
  const middleEnd = Math.max(middleStart, messages.length - protectLast);

  if (middleStart >= middleEnd) {
    console.log(`   [Trim] Not enough middle messages to drop (${messages.length} total, protecting first ${protectFirst} + last ${protectLast})`);
    return;
  }

  // Calculate how many tokens we need to shed from the middle
  const currentEstimate = countTokens(request).total;
  if (currentEstimate <= targetTokens) {
    console.log(`   [Trim] Already under target after content truncation (~${Math.round(currentEstimate / 1000)}K <= ${Math.round(targetTokens / 1000)}K)`);
    return;
  }

  const excess = currentEstimate - targetTokens;

  // Accumulate messages from the start of the middle until we cover the excess
  const counts: number[] = request.messages.map(msg => countMessageTokens(msg));
  let accumulated = 0;
  let dropEnd = middleStart;

  for (let i = middleStart; i < middleEnd && accumulated < excess; i++) {
    accumulated += counts[i] ?? 0;
    dropEnd = i + 1;
  }

  // Adjust boundary to avoid orphaning tool_use/tool_result pairs
  dropEnd = Math.min(adjustBoundary(messages, middleStart, dropEnd), middleEnd);

  const dropped = dropEnd - middleStart;
  if (dropped <= 0) return;

  const droppedTokens = counts.slice(middleStart, dropEnd).reduce((a, b) => a + b, 0);

  // Replace dropped section with a marker
  const before = messages.slice(0, middleStart);
  const after = messages.slice(dropEnd);

  request.messages = [
    ...before,
    {
      role: "user" as const,
      content: `[${dropped} earlier messages trimmed to fit context limit]`,
    },
    {
      role: "assistant" as const,
      content: "Understood, continuing with the available context.",
    },
    ...after,
  ];

  console.log(`   [Trim] Dropped ${dropped} middle messages (~${Math.round(droppedTokens / 1000)}K tokens)`);
}

// --- Step 4: Remove images ---

function removeImages(request: AnthropicRequest): void {
  let removed = 0;

  for (const msg of request.messages) {
    if (Array.isArray(msg.content)) {
      const beforeCount = msg.content.length;
      msg.content = msg.content.filter((b: ContentBlock) => b.type !== "image");
      removed += beforeCount - msg.content.length;
    }
  }

  if (removed > 0) {
    console.log(`   [Trim] Removed ${removed} image(s)`);
  }
}

// --- Structural integrity helpers (ported from old context-manager.ts) ---

/**
 * Adjust selection boundary to avoid orphaning tool_use/tool_result pairs.
 * If dropping messages up to `end` would leave a tool_result without its tool_use
 * (or vice versa), extend the boundary to include the orphaned pair.
 */
export function adjustBoundary(
  messages: AnthropicMessage[],
  start: number,
  end: number
): number {
  if (end >= messages.length) return end;

  // Collect tool_use IDs from the selected range (messages being dropped)
  const selectedToolUseIds = new Set<string>();
  for (let i = start; i < end; i++) {
    const msg = messages[i]!;
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
    const msg = messages[adjusted]!;
    if (msg.role !== "user" || !Array.isArray(msg.content)) break;

    const hasOrphanedResult = msg.content.some(
      (block) =>
        block.type === "tool_result" &&
        block.tool_use_id &&
        selectedToolUseIds.has(block.tool_use_id)
    );

    if (hasOrphanedResult) {
      adjusted++; // include this user message (tool_result)
      // Also check if there's a following assistant message with more tool_uses
      if (adjusted < messages.length) {
        const assistantMsg = messages[adjusted]!;
        if (assistantMsg.role === "assistant" && Array.isArray(assistantMsg.content)) {
          const hasToolUse = assistantMsg.content.some(
            (b) => b.type === "tool_use"
          );
          if (hasToolUse) {
            // Include it and re-check for cascading dependencies
            for (const block of assistantMsg.content) {
              if (block.type === "tool_use" && block.id) {
                selectedToolUseIds.add(block.id);
              }
            }
            adjusted++;
            continue;
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
 * Clean up orphaned tool_use/tool_result pairs after message removal.
 * Ensures:
 * 1. Every tool_result has a matching tool_use in a previous message
 * 2. Every tool_use has a matching tool_result in a following message
 * 3. No empty messages remain
 * 4. User/assistant roles alternate properly
 * 5. First message is from user
 */
export function cleanupOrphanedToolPairs(messages: AnthropicMessage[]): AnthropicMessage[] {
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

    const lastMsg = result[result.length - 1]!;
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
  if (result.length > 0 && result[0]!.role !== "user") {
    result.unshift({ role: "user", content: "Continue." });
  }

  if (removedResults > 0 || removedUses > 0) {
    console.log(`   [Trim] Cleaned up ${removedResults} orphaned tool_result(s) and ${removedUses} orphaned tool_use(s)`);
  }

  return result;
}

/**
 * Parse the "prompt is too long" error message to extract token counts.
 * Expected format: "prompt is too long: 204826 tokens > 200000 maximum"
 * Returns null if the error doesn't match this pattern.
 */
export function parsePromptTooLongError(errorMessage: string): {
  actualTokens: number;
  maxTokens: number;
} | null {
  const match = errorMessage.match(
    /prompt is too long:\s*(\d+)\s*tokens?\s*>\s*(\d+)\s*maximum/i
  );
  if (!match || !match[1] || !match[2]) return null;

  return {
    actualTokens: parseInt(match[1], 10),
    maxTokens: parseInt(match[2], 10),
  };
}
