import type { AnthropicRequest, AnthropicMessage, ContentBlock, Tool } from "./types";
import { getValidToken } from "./oauth";
import { ANTHROPIC_API_URL, CLAUDE_CODE_BETA_HEADERS, CLAUDE_CODE_SYSTEM_PROMPT } from "./config";

export interface TokenCount {
  system: number;
  messages: number[]; // per-message token counts
  tools: number;
  total: number;
}

// Differentiated ratios — conservative to avoid undercounting
// Real-world Cursor messages contain code, XML tags, and paths which tokenize denser than pure prose
const PROSE_CHARS_PER_TOKEN = 3.2;
const JSON_CHARS_PER_TOKEN = 2.8; // tool_use, tool_result blocks
const SCHEMA_CHARS_PER_TOKEN = 2.5; // tool definitions (dense JSON schemas)
const MESSAGE_OVERHEAD_TOKENS = 4; // role, delimiters per message
const TOOL_OVERHEAD_TOKENS = 12; // name, wrapping per tool definition
const SAFETY_MARGIN = 1.03; // 3% buffer to account for estimation error

function proseTokens(text: string): number {
  return Math.ceil(text.length / PROSE_CHARS_PER_TOKEN);
}

function jsonTokens(text: string): number {
  return Math.ceil(text.length / JSON_CHARS_PER_TOKEN);
}

function schemaTokens(text: string): number {
  return Math.ceil(text.length / SCHEMA_CHARS_PER_TOKEN);
}

function countBlockTokens(block: ContentBlock): number {
  switch (block.type) {
    case "text":
      return proseTokens(block.text || "");

    case "tool_use":
      // Tool name + JSON-stringified input
      return jsonTokens(
        (block.name || "") + JSON.stringify(block.input || {})
      );

    case "tool_result": {
      if (typeof block.content === "string") {
        return jsonTokens(block.content);
      }
      if (Array.isArray(block.content)) {
        return block.content.reduce(
          (sum, b) => sum + countBlockTokens(b),
          0
        );
      }
      return 0;
    }

    case "image":
      // Images are handled by the API differently; estimate conservatively
      // A typical base64 image is ~1600 tokens for vision models
      return 1600;

    default:
      return jsonTokens(JSON.stringify(block));
  }
}

function countSystemTokens(
  system: string | ContentBlock[] | undefined
): number {
  if (!system) return 0;
  if (typeof system === "string") return proseTokens(system);
  return system.reduce((sum, block) => {
    if (block.text) return sum + proseTokens(block.text);
    return sum + jsonTokens(JSON.stringify(block));
  }, 0);
}

export function countMessageTokens(msg: AnthropicMessage): number {
  let tokens = MESSAGE_OVERHEAD_TOKENS;

  if (typeof msg.content === "string") {
    tokens += proseTokens(msg.content);
  } else if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      tokens += countBlockTokens(block);
    }
  }

  return tokens;
}

function countToolsTokens(tools: Tool[] | undefined): number {
  if (!tools || tools.length === 0) return 0;

  let tokens = 0;
  for (const tool of tools) {
    tokens += TOOL_OVERHEAD_TOKENS;
    tokens += schemaTokens(tool.name || "");
    tokens += schemaTokens(tool.description || "");
    tokens += schemaTokens(JSON.stringify(tool.input_schema || {}));
  }
  return tokens;
}

export function countTokens(req: AnthropicRequest): TokenCount {
  const system = countSystemTokens(req.system);
  const messages = req.messages.map((msg) => countMessageTokens(msg));
  const tools = countToolsTokens(req.tools);
  const raw = system + messages.reduce((a, b) => a + b, 0) + tools;
  const total = Math.ceil(raw * SAFETY_MARGIN);

  return { system, messages, tools, total };
}

/**
 * Result from API-based token counting
 */
export interface APITokenCountResult {
  inputTokens: number;
  source: "api" | "estimate";
  error?: string;
}

/**
 * Get accurate token count via Anthropic API using OAuth.
 * Falls back to character estimation on error.
 */
export async function countTokensAPI(req: AnthropicRequest): Promise<APITokenCountResult> {
  try {
    const token = await getValidToken();
    if (!token) {
      return { inputTokens: countTokens(req).total, source: "estimate", error: "No OAuth token" };
    }

    // Prepare body same as Claude Code requests (add required system prompt)
    const systemBlocks = [
      { type: "text", text: CLAUDE_CODE_SYSTEM_PROMPT },
      ...(typeof req.system === "string"
        ? [{ type: "text", text: req.system }]
        : Array.isArray(req.system)
          ? req.system
          : []),
    ];

    const body = {
      model: req.model,
      messages: req.messages,
      system: systemBlocks,
      tools: req.tools,
      thinking: req.thinking,
    };

    const response = await fetch(`${ANTHROPIC_API_URL}/v1/messages/count_tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        "anthropic-beta": CLAUDE_CODE_BETA_HEADERS,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
        "User-Agent": "claude-code/1.0.85",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000), // 5s timeout
    });

    if (!response.ok) {
      const err = await response.text();
      return { inputTokens: countTokens(req).total, source: "estimate", error: `API ${response.status}: ${err.slice(0, 200)}` };
    }

    const data = (await response.json()) as { input_tokens: number };
    return { inputTokens: data.input_tokens, source: "api" };
  } catch (err) {
    return { inputTokens: countTokens(req).total, source: "estimate", error: String(err) };
  }
}
