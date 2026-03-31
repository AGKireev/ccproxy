/**
 * OpenAI Codex handler — production architecture.
 *
 * Architecture:
 *   Cursor → /v1/chat/completions (mixed format) → CCProxy → normalize
 *   → openai-oauth /v1/chat/completions → Codex backend
 *   → openai-oauth Chat Completions SSE → CCProxy repair wrapper → Cursor
 *
 * Key insight:
 *   - openai-oauth's /v1/chat/completions path streams real GPT-5.4 output quickly,
 *     even for large Cursor agent payloads
 *   - but that stream can end tool-calling turns with finish_reason: null, which
 *     breaks Cursor's tool execution loop
 *   - raw /v1/responses passthrough looked cleaner, but in practice it can sit on
 *     a 200 OK stream without producing visible assistant output for too long
 *
 * So the stable production path is:
 *   1. normalize Cursor's hybrid messages/tools
 *   2. execute through openai-oauth's chat-completions handler
 *   3. repair the emitted SSE so Cursor gets proper finish_reason/error behavior
 *
 * The Responses API conversion helpers remain in this file as reference/experimental
 * code, but they are not the active execution path.
 */

import { createOpenAIOAuthFetchHandler } from "openai-oauth";
import type { OpenAIOAuthServerOptions } from "openai-oauth";
import { getConfig } from "./config";
import { logger } from "./logger";
import {
  debugLogRequest,
  debugLogResponse,
  debugLogError,
  debugWrapStream,
} from "./openai-debug";

let handler: ((request: Request) => Promise<Response>) | null = null;

// Track the last error from openai-oauth for diagnostic logging
let lastCodexError: { message: string; durationMs: number; timestamp: number } | null = null;

function getHandler(): (request: Request) => Promise<Response> {
  if (handler) return handler;

  const options: OpenAIOAuthServerOptions = {
    requestLogger: (event) => {
      if (event.type === "chat_request") {
        console.log(`   [openai-oauth] Request: model=${event.model}, messages=${event.messageCount}, tools=${event.toolCount}, stream=${event.stream}`);
      } else if (event.type === "chat_response") {
        console.log(`   [openai-oauth] Response: status=${event.status}, stream=${event.stream}, finish=${event.finishReason}, duration=${event.durationMs}ms`);
        if (event.usage) {
          console.log(`   [openai-oauth] Usage: input=${event.usage.inputTokens ?? 0}, output=${event.usage.outputTokens ?? 0}, reasoning=${event.usage.reasoningTokens ?? 0}, cached=${event.usage.cachedInputTokens ?? 0}`);
        }
      } else if (event.type === "chat_error") {
        console.error(`   [openai-oauth] ❌ Error: ${event.message} (${event.durationMs}ms)`);
        lastCodexError = { message: event.message, durationMs: event.durationMs, timestamp: Date.now() };
      }
    },
  };

  handler = createOpenAIOAuthFetchHandler(options);
  console.log("✓ openai-oauth handler initialized");
  return handler;
}

// NOTE:
// Previous experiments in this file tried a raw /v1/responses passthrough.
// That path is kept here for reference, but the active production path now uses
// openai-oauth's /v1/chat/completions execution with a smaller SSE repair layer.

// ── Error parsing helper ────────────────────────────────────────────────

/**
 * Parse error bodies from the Codex backend or openai-oauth library and return
 * an enhanced, user-friendly error. Returns null if the error isn't recognized.
 *
 * Handles these scenarios:
 * 1. Direct Codex backend error: {error: {type: "usage_limit_reached", message: "...", resets_at: ...}}
 * 2. Library-wrapped error: {error: {message: "...", type: "server_error"}} where message contains the original error
 * 3. Vercel AI SDK error message with embedded responseBody
 */
function parseAndEnhanceCodexError(
  errorBody: string,
  httpStatus: number
): { message: string; type: string; status: number } | null {
  if (!errorBody) return null;

  try {
    const parsed = JSON.parse(errorBody);
    const err = parsed?.error;
    if (!err) return null;

    // Direct usage_limit_reached from Codex backend
    if (err.type === "usage_limit_reached" || err.message?.includes("usage limit")) {
      const resetsAt = err.resets_at;
      const resetTime = resetsAt ? new Date(resetsAt * 1000) : null;
      const planType = err.plan_type || "Plus";
      const message = `OpenAI usage limit reached (${planType} plan).${resetTime ? ` Resets at: ${resetTime.toLocaleString()}` : ""} Switch to a Claude model or wait for the limit to reset.`;
      console.error(`⚠️  [OpenAI Codex] Usage limit reached!${resetTime ? ` Resets at: ${resetTime.toLocaleString()}` : ""}`);
      return { message, type: "usage_limit_reached", status: 429 };
    }

    // Rate limit errors
    if (err.type === "rate_limit_error" || err.message?.includes("rate limit")) {
      return { message: `OpenAI rate limit hit. Please wait a moment and try again.`, type: "rate_limit_error", status: 429 };
    }

    // Auth errors
    if (err.type === "authentication_error" || err.message?.includes("auth") || err.message?.includes("token")) {
      return { message: `OpenAI authentication error: ${err.message}. Try running 'codex login' again.`, type: "authentication_error", status: 401 };
    }

    // Library-wrapped error: the message may contain a serialized upstream response
    if (err.type === "server_error" && typeof err.message === "string") {
      // Check if the message contains an embedded JSON error from the Codex backend
      const jsonMatch = err.message.match(/\{[\s\S]*"error"[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const innerParsed = JSON.parse(jsonMatch[0]);
          return parseAndEnhanceCodexError(JSON.stringify(innerParsed), httpStatus);
        } catch (innerParseErr) {
          console.warn(`   ⚠️  [error-parse] Failed to parse embedded error JSON: ${innerParseErr instanceof Error ? innerParseErr.message : "parse error"}`);
        }
      }

      // Check for known error strings in the message text
      if (err.message.includes("usage_limit_reached") || err.message.includes("usage limit")) {
        const resetMatch = err.message.match(/resets_at["\s:]+(\d{10,})/);
        const resetTime = resetMatch ? new Date(parseInt(resetMatch[1]) * 1000) : null;
        const planMatch = err.message.match(/plan_type["\s:]+["']?(\w+)/);
        const planType = planMatch?.[1] || "Plus";
        return {
          message: `OpenAI usage limit reached (${planType} plan).${resetTime ? ` Resets at: ${resetTime.toLocaleString()}` : ""} Switch to a Claude model or wait for the limit to reset.`,
          type: "usage_limit_reached",
          status: 429,
        };
      }

      // Pass through non-recognized library errors with the original message
      return { message: `OpenAI error: ${err.message}`, type: err.type, status: httpStatus };
    }
  } catch {
    // Not JSON — check for known patterns in raw text
    if (errorBody.includes("usage_limit_reached") || errorBody.includes("usage limit")) {
      return {
        message: "OpenAI usage limit reached. Switch to a Claude model or wait for the limit to reset.",
        type: "usage_limit_reached",
        status: 429,
      };
    }
  }

  return null;
}

// ── Text extraction helpers ─────────────────────────────────────────────

/** Extract plain text from any content format Cursor might send. */
function extractText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p: any) => p?.type === "text" || p?.type === "input_text" || p?.type === "output_text")
      .map((p: any) => p.text || "")
      .join("\n");
  }
  return String(content);
}

/** Extract user content, preserving images as structured parts. */
function extractUserContent(content: unknown): string | Array<{ type: string; text?: string; image_url?: unknown }> {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content);

  const hasImages = content.some((p: any) => p?.type === "image_url");
  if (hasImages) {
    return content.map((p: any) => {
      if (p?.type === "input_text") return { type: "text", text: p.text || "" };
      return p;
    });
  }

  // Text-only → join into string
  return content
    .filter((p: any) => p?.type === "text" || p?.type === "input_text" || p?.type === "output_text")
    .map((p: any) => p.text || "")
    .join("\n");
}

/** Extract text from function_call_output's output field. */
function extractToolOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    const text = output
      .filter((p: any) => p?.type === "input_text" || p?.type === "output_text" || p?.type === "text")
      .map((p: any) => p.text || "")
      .join("\n");
    return text || JSON.stringify(output);
  }
  return JSON.stringify(output || "");
}

// ── Normalizer ──────────────────────────────────────────────────────────

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface NormalizedMessage {
  role: string;
  content?: string | unknown[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

function normalizeCursorMessages(messages: unknown[]): NormalizedMessage[] {
  const result: NormalizedMessage[] = [];

  // We iterate through the Cursor items and merge consecutive function_call items
  // into the preceding assistant message's tool_calls array.
  // Pattern from Cursor:
  //   {role: "assistant", content: [{type: "output_text", ...}]}  ← preamble
  //   {type: "function_call", call_id, name, arguments}           ← merge into above
  //   {type: "function_call", call_id, name, arguments}           ← merge into above
  //   {type: "function_call_output", call_id, output}             ← becomes tool message
  //   {type: "function_call_output", call_id, output}             ← becomes tool message

  for (const rawMsg of messages) {
    const msg = rawMsg as Record<string, unknown>;
    const role = msg.role as string || "";
    const itemType = msg.type as string || "";

    // ── Responses API: function_call / custom_tool_call (no role) ──
    // Cursor sends both "function_call" (standard) and "custom_tool_call" (for custom tools).
    // Structure is the same except custom_tool_call uses "input" instead of "arguments".
    if (itemType === "function_call" || itemType === "custom_tool_call") {
      const tc: ToolCall = {
        id: (msg.call_id || msg.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`) as string,
        type: "function",
        function: {
          name: (msg.name || "") as string,
          arguments: typeof msg.arguments === "string"
            ? msg.arguments
            : typeof msg.input === "string"
              ? msg.input
              : JSON.stringify(msg.arguments || msg.input || {}),
        },
      };

      // Try to merge into the last assistant message
      const lastMsg = result[result.length - 1];
      if (lastMsg && lastMsg.role === "assistant") {
        if (!lastMsg.tool_calls) lastMsg.tool_calls = [];
        lastMsg.tool_calls.push(tc);
      } else {
        // No preceding assistant message — create one
        result.push({ role: "assistant", content: null, tool_calls: [tc] });
      }
      continue;
    }

    // ── Responses API: function_call_output / custom_tool_call_output (no role) ──
    // Same pattern — Cursor sends both variants.
    if (itemType === "function_call_output" || itemType === "custom_tool_call_output") {
      result.push({
        role: "tool",
        content: extractToolOutput(msg.output),
        tool_call_id: (msg.call_id || "unknown") as string,
      });
      continue;
    }

    // ── Tool messages (already OpenAI format) ──
    if (role === "tool") {
      result.push({
        role: "tool",
        content: typeof msg.content === "string" ? msg.content : extractToolOutput(msg.content),
        tool_call_id: msg.tool_call_id as string || undefined,
      });
      continue;
    }

    // ── System / developer ──
    if (role === "system" || role === "developer") {
      result.push({ role, content: extractText(msg.content) });
      continue;
    }

    // ── User messages ──
    if (role === "user") {
      const content = msg.content;

      if (Array.isArray(content)) {
        // Check for Anthropic-style tool_result blocks
        const hasToolResults = content.some((p: any) => p?.type === "tool_result");
        if (hasToolResults) {
          const textParts = content.filter((p: any) => p?.type !== "tool_result");
          const toolResultParts = content.filter((p: any) => p?.type === "tool_result");

          for (const tr of toolResultParts) {
            const trObj = tr as Record<string, unknown>;
            result.push({
              role: "tool",
              content: extractToolOutput(trObj.content),
              tool_call_id: (trObj.tool_use_id || "unknown") as string,
            });
          }

          const text = extractText(textParts);
          if (text.trim()) {
            result.push({ role: "user", content: text });
          }
        } else {
          result.push({ role: "user", content: extractUserContent(content) });
        }
      } else {
        result.push({ role: "user", content: extractText(content) });
      }
      continue;
    }

    // ── Assistant messages ──
    if (role === "assistant") {
      const content = msg.content;
      const toolCalls = msg.tool_calls as unknown[] | undefined;

      const normalizedMsg: NormalizedMessage = { role: "assistant" };
      normalizedMsg.content = extractText(content) || null;

      // Convert tool_calls if present
      if (toolCalls && Array.isArray(toolCalls) && toolCalls.length > 0) {
        normalizedMsg.tool_calls = toolCalls.map((tc: any) => ({
          id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          type: "function" as const,
          function: {
            name: tc.function?.name || tc.name || "",
            arguments: tc.function?.arguments || JSON.stringify(tc.input || {}),
          },
        }));
      }

      // Check for Anthropic-style tool_use blocks in content
      if (Array.isArray(content)) {
        const toolUseParts = content.filter((p: any) => p?.type === "tool_use");
        if (toolUseParts.length > 0) {
          if (!normalizedMsg.tool_calls) normalizedMsg.tool_calls = [];
          for (const tu of toolUseParts) {
            const tuObj = tu as Record<string, unknown>;
            normalizedMsg.tool_calls.push({
              id: (tuObj.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`) as string,
              type: "function",
              function: {
                name: (tuObj.name || "") as string,
                arguments: typeof tuObj.input === "string" ? tuObj.input : JSON.stringify(tuObj.input || {}),
              },
            });
          }
        }
      }

      result.push(normalizedMsg);
      continue;
    }

    // ── Unknown: FAIL FAST — log so we know what we're dropping ──
    if (role) {
      console.warn(`   ⚠️  [normalize] Unrecognized role="${role}" (type="${itemType}") — passing through as-is. Content preview: ${JSON.stringify(msg.content).substring(0, 200)}`);
      result.push({ role, content: extractText(msg.content) });
    } else if (itemType) {
      // Has a type but no role and didn't match function_call/function_call_output above
      console.error(`   ❌ [normalize] DROPPED message: unknown type="${itemType}" with no role. Keys: [${Object.keys(msg).join(", ")}]. This message will NOT reach the model!`);
    } else {
      // Neither role nor type — completely unrecognized
      console.error(`   ❌ [normalize] DROPPED message: no role, no type. Keys: [${Object.keys(msg).join(", ")}]. Content preview: ${JSON.stringify(msg).substring(0, 300)}. This message will NOT reach the model!`);
    }
  }

  // Sanity check: warn if normalization produced empty result from non-empty input
  if (messages.length > 0 && result.length === 0) {
    console.error(`   ❌ [normalize] CRITICAL: ${messages.length} input messages produced 0 normalized messages! The model will have NO context.`);
  }

  // Warn on suspicious patterns
  const roleStats: Record<string, number> = {};
  for (const m of result) {
    roleStats[m.role] = (roleStats[m.role] || 0) + 1;
  }
  if (result.length > 3 && !roleStats["user"] && !roleStats["tool"]) {
    console.warn(`   ⚠️  [normalize] No user or tool messages in ${result.length} normalized messages — model may lack context. Roles: ${JSON.stringify(roleStats)}`);
  }

  return result;
}

// ── ApplyPatch format instructions for GPT models ───────────────────────
// Claude models know Cursor's custom patch format natively, but GPT models don't.
// We append explicit format instructions to the ApplyPatch tool description so
// GPT-5.4 generates patches in the correct *** Add/Update/Delete File format
// that Cursor can actually apply.

const APPLY_PATCH_FORMAT_INSTRUCTIONS = `

CRITICAL: You MUST use this EXACT patch format. Do NOT use standard unified diff format (--- a/ +++ b/).

When calling this tool through OpenAI function calling, put the ENTIRE patch text
inside the JSON string field "patch". The proxy will unwrap that field back into
raw Cursor ApplyPatch input before execution.

Example tool arguments JSON:
\`\`\`json
{"patch":"*** Begin Patch\n*** Update File: src/example.ts\n@@\n-old\n+new\n*** End Patch"}
\`\`\`

Format:
\`\`\`
*** Begin Patch
*** Add File: path/to/new_file.py
+first line of new file
+second line of new file

*** Update File: path/to/existing_file.py
@@
 context line (unchanged)
-line to remove
+line to add
 context line (unchanged)

*** Delete File: path/to/obsolete_file.py
*** End Patch
\`\`\`

Rules:
- Always wrap patches in *** Begin Patch / *** End Patch
- Use *** Add File: <path> for new files (every line starts with +)
- Use *** Update File: <path> for modifying files (use @@ hunks with - and + lines)
- Use *** Delete File: <path> for removing files
- Use @@ to start each change hunk in Update File sections
- Include a few context lines (starting with space) around changes for matching
- NEVER use --- a/path or +++ b/path headers
- Multiple files can appear in a single patch
- NEVER send {} for ApplyPatch arguments
- ALWAYS put the full patch text inside the "patch" string field`;

const APPLY_PATCH_ARGUMENT_SCHEMA = {
  type: "object",
  properties: {
    patch: {
      type: "string",
      description:
        "The full Cursor ApplyPatch payload as a single string, starting with *** Begin Patch and ending with *** End Patch.",
    },
  },
  required: ["patch"],
  additionalProperties: false,
};

function unwrapApplyPatchArguments(argsText: string): string {
  if (!argsText) return "";

  try {
    const parsed = JSON.parse(argsText);
    if (typeof parsed === "string") return parsed;
    if (parsed && typeof parsed === "object") {
      if (typeof (parsed as any).patch === "string") return (parsed as any).patch;
      if (typeof (parsed as any).input === "string") return (parsed as any).input;
    }
  } catch {
    // Raw Cursor patch strings are valid here; just pass them through.
  }

  return argsText;
}

/** Normalize Cursor's tool definitions to OpenAI format. */
function normalizeCursorTools(tools: unknown[], model?: string): unknown[] {
  const isGPT = model ? isOpenAIModel(model) : false;

  return tools.map((tool: any, idx: number) => {
    let normalized: any;

    if (tool.type === "function" && tool.function) {
      normalized = tool;
    } else if (tool.name) {
      normalized = {
        type: "function",
        function: {
          name: tool.name,
          description: tool.description || "",
          parameters: tool.input_schema || tool.parameters || { type: "object", properties: {} },
        },
      };
    } else {
      // FAIL FAST: unrecognized tool format — log it so we can fix
      console.error(`   ❌ [tools] Tool #${idx} has unrecognized format — passing through raw. Keys: [${Object.keys(tool).join(", ")}], type="${tool.type || "none"}". Preview: ${JSON.stringify(tool).substring(0, 300)}`);
      return tool;
    }

    // For GPT models, wrap ApplyPatch as a JSON object tool and teach the model
    // to place the raw patch text inside the required "patch" field.
    if (isGPT && normalized.function?.name === "ApplyPatch") {
      normalized = {
        ...normalized,
        function: {
          ...normalized.function,
          description: (normalized.function.description || "") + APPLY_PATCH_FORMAT_INSTRUCTIONS,
          parameters: APPLY_PATCH_ARGUMENT_SCHEMA,
        },
      };
      console.log("   [patch-fix] Wrapped ApplyPatch schema for GPT model");
    }

    return normalized;
  });
}

// ── Chat Completions → Responses API body converter ─────────────────────
// Experimental/reference helper kept for future investigation.
// The current production path does NOT send requests through /v1/responses.

function chatCompletionsToResponses(body: Record<string, unknown>): Record<string, unknown> {
  const messages = (body.messages || []) as NormalizedMessage[];
  const tools = (body.tools || []) as any[];

  // Extract system/developer messages → instructions
  const instructionMessages = messages.filter(m => m.role === "system" || m.role === "developer");
  const conversationMessages = messages.filter(m => m.role !== "system" && m.role !== "developer");

  // Build instructions string from all system/developer messages
  const instructions = instructionMessages.map(m => extractText(m.content)).join("\n\n") || undefined;

  // Build Responses API input items from conversation messages
  const input: any[] = [];

  for (const msg of conversationMessages) {
    if (msg.role === "user") {
      // User message → EasyInputMessage
      if (typeof msg.content === "string") {
        input.push({ role: "user", content: msg.content });
      } else if (Array.isArray(msg.content)) {
        // Structured content (images, etc.) → convert to Responses API content format
        const content = (msg.content as any[]).map((part: any) => {
          if (part.type === "text") return { type: "input_text", text: part.text || "" };
          if (part.type === "image_url") return { type: "input_image", image_url: part.image_url?.url || part.image_url };
          return part; // pass through unknown types
        });
        input.push({ role: "user", content });
      } else {
        input.push({ role: "user", content: String(msg.content || "") });
      }
    } else if (msg.role === "assistant") {
      // Assistant message with tool_calls → output_text + function_call items
      if (msg.content && String(msg.content).trim()) {
        // Text content → message with output_text content
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: String(msg.content) }],
        });
      }
      // Tool calls → separate function_call items
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        // If no text content was emitted, we still need the assistant context
        if (!msg.content || !String(msg.content).trim()) {
          // Push an empty assistant message to maintain conversation flow
          input.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "" }],
          });
        }
        for (const tc of msg.tool_calls) {
          input.push({
            type: "function_call",
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          });
        }
      }
    } else if (msg.role === "tool") {
      // Tool result → function_call_output
      input.push({
        type: "function_call_output",
        call_id: msg.tool_call_id || "unknown",
        output: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
      });
    }
  }

  // Convert Chat Completions tools → Responses API tools
  const responsesTools: any[] = tools.map((tool: any) => {
    if (tool.type === "function" && tool.function) {
      return {
        type: "function",
        name: tool.function.name,
        description: tool.function.description || "",
        parameters: tool.function.parameters || { type: "object", properties: {} },
        strict: false,
      };
    }
    return tool; // pass through unknown types
  });

  const result: Record<string, unknown> = {
    model: body.model,
    input,
    stream: true,  // Always stream for Cursor
    instructions,
    tools: responsesTools.length > 0 ? responsesTools : undefined,
    // NOTE: openai-oauth's normalizeCodexResponsesBody() deletes max_output_tokens.
    // The Codex backend will use its own default (typically generous for gpt-5.4).
    // If output truncation becomes an issue, we may need to bypass the library's normalization.
    max_output_tokens: body.max_tokens || 16384,
    temperature: body.temperature,
    top_p: body.top_p,
    parallel_tool_calls: body.parallel_tool_calls,
    reasoning: {
      effort: body.reasoning_effort || "xhigh",
      summary: "auto",
    },
    // Don't store in the backend — we manage state ourselves
    store: false,
  };

  // Clean undefined keys
  for (const key of Object.keys(result)) {
    if (result[key] === undefined) delete result[key];
  }

  return result;
}

// ── Responses API SSE → Chat Completions SSE converter ──────────────────
// Experimental/reference helper kept for future investigation.
//
// It reads raw Responses API SSE events from the Codex backend and emits
// proper OpenAI Chat Completions SSE chunks that Cursor expects.
//
// Responses API events we handle:
//   response.output_text.delta → delta.content
//   response.function_call_arguments.delta → delta.tool_calls[i].function.arguments  
//   response.output_item.added → start new tool_call or text content
//   response.output_item.done → (tracking)
//   response.content_part.added → (tracking)
//   response.content_part.done → (tracking)
//   response.completed → finish_reason: "stop" or "tool_calls"
//   response.failed → error
//   response.in_progress → (ignore)
//   response.created → (ignore)
//   error → error

function responsesStreamToChatCompletions(response: Response, model: string): Response {
  if (!response.body) {
    return response;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const chatId = `chatcmpl_${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  // Track tool call indexes: call_id → index (for Cursor's delta.tool_calls[index])
  const toolCallIndexes = new Map<string, number>();
  let nextToolCallIndex = 0;
  let hasToolCalls = false;
  let hasTextContent = false;
  let isCompleted = false;
  let isClosed = false;
  let sentAssistantStart = false;

  // Stall detection
  const INITIAL_STALL_TIMEOUT_MS = 300_000;  // 5 minutes for initial thinking
  const FLOWING_STALL_TIMEOUT_MS = 120_000;  // 2 minutes once flowing
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  let chunkCount = 0;

  function clearStallTimer() {
    if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
  }

  function emitChunk(controller: ReadableStreamDefaultController, delta: any, finishReason: string | null = null) {
    if (isClosed) return;
    const chunk = {
      id: chatId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
  }

  function emitDone(controller: ReadableStreamDefaultController) {
    if (isClosed) return;
    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
  }

  function emitAssistantStart(controller: ReadableStreamDefaultController) {
    if (isClosed || sentAssistantStart) return;
    sentAssistantStart = true;
    emitChunk(controller, { role: "assistant", content: "" });
  }

  // Buffer for incomplete SSE lines across TCP chunks
  let sseBuffer = "";

  function processSSELine(line: string, controller: ReadableStreamDefaultController) {
    if (!line.startsWith("data: ")) return;
    const dataStr = line.slice(6).trim();
    if (!dataStr || dataStr === "[DONE]") return;

    let data: any;
    try {
      data = JSON.parse(dataStr);
    } catch (e) {
      console.warn(`   ⚠️  [responses→chat] Failed to parse SSE data: ${dataStr.substring(0, 200)}`);
      return;
    }

    const eventType = data.type as string || "";

    switch (eventType) {
      case "response.created": {
        // Emit the standard Chat Completions start chunk immediately so Cursor
        // doesn't sit on a 200 OK SSE stream with zero bytes while the model reasons.
        emitAssistantStart(controller);
        break;
      }

      case "response.output_text.delta": {
        // Text content streaming
        const text = data.delta as string;
        if (text) {
          emitAssistantStart(controller);
          emitChunk(controller, { content: text });
          hasTextContent = true;
        }
        break;
      }

      case "response.function_call_arguments.delta": {
        // Tool call argument streaming
        const callId = data.call_id as string;
        const delta = data.delta as string;
        if (!callId || !delta) break;

        let tcIndex = toolCallIndexes.get(callId);
        if (tcIndex === undefined) {
          // New tool call — should have been registered by output_item.added,
          // but handle gracefully if not
          tcIndex = nextToolCallIndex++;
          toolCallIndexes.set(callId, tcIndex);
          hasToolCalls = true;
          console.warn(`   ⚠️  [responses→chat] function_call_arguments.delta for unknown call_id=${callId}, auto-assigned index=${tcIndex}`);
        }

        emitChunk(controller, {
          tool_calls: [{
            index: tcIndex,
            function: { arguments: delta },
          }],
        });
        break;
      }

      case "response.output_item.added": {
        // New output item being generated
        const item = data.item;
        if (!item) break;

        if (item.type === "function_call") {
          // New tool call starting
          const callId = item.call_id as string;
          const name = item.name as string;
          const tcIndex = nextToolCallIndex++;
          toolCallIndexes.set(callId, tcIndex);
          hasToolCalls = true;

          console.log(`   [responses→chat] Tool call started: ${name} (call_id=${callId}, index=${tcIndex})`);

          // Emit the tool call header with role, name, and empty arguments
          const delta: any = {
            role: "assistant",
            tool_calls: [{
              index: tcIndex,
              id: callId,
              type: "function",
              function: { name: name, arguments: "" },
            }],
          };
          if (sentAssistantStart) {
            delete delta.role;
          } else {
            sentAssistantStart = true;
          }
          emitChunk(controller, delta);

        } else if (item.type === "message") {
          // Message output items do not include a role in the raw Responses SSE.
          // Treat them as assistant starts so Cursor gets the expected initial chunk.
          emitAssistantStart(controller);
        }
        break;
      }

      case "response.function_call_arguments.done": {
        // Tool call arguments complete — no action needed, Cursor assembles from deltas
        const callId = data.call_id as string;
        const name = data.name as string;
        console.log(`   [responses→chat] Tool call arguments done: ${name} (call_id=${callId})`);
        break;
      }

      case "response.output_item.done": {
        // Output item complete
        const item = data.item;
        if (item?.type === "function_call") {
          console.log(`   [responses→chat] Tool call complete: ${item.name} (call_id=${item.call_id})`);
        }
        break;
      }

      case "response.completed": {
        // Response complete — determine finish_reason
        isCompleted = true;
        const finishReason = hasToolCalls ? "tool_calls" : "stop";
        console.log(`   [responses→chat] Response completed. finish_reason=${finishReason}, hasToolCalls=${hasToolCalls}, hasText=${hasTextContent}`);

        // Extract usage info if available
        const usage = data.response?.usage;
        if (usage) {
          console.log(`   [responses→chat] Usage: input=${usage.input_tokens || 0}, output=${usage.output_tokens || 0}, reasoning=${usage.output_tokens_details?.reasoning_tokens || 0}`);
        }

        // Emit final chunk with finish_reason
        emitChunk(controller, {}, finishReason);
        emitDone(controller);
        break;
      }

      case "response.failed": {
        // Response failed — emit error
        isCompleted = true;  // Prevent duplicate finish on stream end
        const error = data.response?.error || data.error;
        const errorMsg = error?.message || "Unknown error from Codex backend";
        const errorType = error?.code || error?.type || "api_error";
        console.error(`\n❌ [responses→chat] Response failed: ${errorType}: ${errorMsg}`);

        // Emit error as a Chat Completions error event
        const errorPayload = {
          error: { message: errorMsg, type: errorType },
        };
        if (!isClosed) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorPayload)}\n\n`));
          emitDone(controller);
        }
        break;
      }

      case "response.output_text.done": {
        // Text output complete — logged for debugging
        break;
      }

      case "response.content_part.added":
      case "response.content_part.done":
      case "response.in_progress":
        // Informational events — ignore
        break;

      case "error": {
        // Top-level error event
        isCompleted = true;  // Prevent duplicate finish on stream end
        const errorMsg = data.message || data.error?.message || "Unknown stream error";
        const errorType = data.code || data.error?.type || "stream_error";
        console.error(`\n❌ [responses→chat] Stream error: ${errorType}: ${errorMsg}`);

        const errorPayload = {
          error: { message: errorMsg, type: errorType },
        };
        if (!isClosed) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorPayload)}\n\n`));
          emitDone(controller);
        }
        break;
      }

      default: {
        // FAIL FAST: log unrecognized events so we can add support
        if (eventType) {
          console.warn(`   ⚠️  [responses→chat] Unhandled Responses API event: ${eventType}. Data preview: ${JSON.stringify(data).substring(0, 300)}`);
        }
        break;
      }
    }
  }

  const wrappedStream = new ReadableStream({
    start(controller) {
      // Match openai-oauth's chat-completions behavior: emit the initial
      // assistant role chunk immediately, even if the raw Responses stream
      // stays silent for a while during heavy reasoning.
      emitAssistantStart(controller);
    },
    async pull(controller) {
      if (isClosed) return;

      // Reset stall timer
      clearStallTimer();
      const timeout = chunkCount < 2 ? INITIAL_STALL_TIMEOUT_MS : FLOWING_STALL_TIMEOUT_MS;
      stallTimer = setTimeout(() => {
        if (isClosed) return;
        const phase = chunkCount < 2 ? "initial thinking" : "mid-stream";
        const msg = `OpenAI stream stalled — no data for ${timeout / 1000}s (${phase}) after ${chunkCount} chunks. The model may be overloaded. Please retry.`;
        console.error(`\n❌ [OpenAI Codex] ${msg}`);
        if (!isClosed) {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: msg, type: "stream_timeout" } })}\n\ndata: [DONE]\n\n`));
            controller.close();
          } catch { /* already closed */ }
          isClosed = true;
        }
        reader.cancel().catch(() => {});
      }, timeout);

      try {
        const { done, value } = await reader.read();
        clearStallTimer();

        if (done) {
          // Stream ended — make sure we emitted a completion
          if (!isCompleted && !isClosed) {
            console.warn(`   ⚠️  [responses→chat] Stream ended without response.completed event`);
            const finishReason = hasToolCalls ? "tool_calls" : "stop";
            emitChunk(controller, {}, finishReason);
            emitDone(controller);
          }
          if (!isClosed) {
            isClosed = true;
            controller.close();
          }
          return;
        }

        chunkCount++;
        const text = decoder.decode(value, { stream: true });
        sseBuffer += text;

        // Process complete SSE lines
        const lines = sseBuffer.split("\n");
        // Keep the last potentially incomplete line
        sseBuffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) {
            processSSELine(trimmed, controller);
          }
        }
      } catch (error: any) {
        clearStallTimer();
        if (isClosed) return;

        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(`\n❌ [responses→chat] Stream read error: ${errorMsg}`);

        // Try to emit error to Cursor
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            error: { message: `OpenAI stream error: ${errorMsg}`, type: "stream_error" },
          })}\n\ndata: [DONE]\n\n`));
          controller.close();
        } catch { /* already closed */ }
        isClosed = true;
      }
    },
    cancel() {
      clearStallTimer();
      isClosed = true;
      reader.cancel().catch(() => {});
    },
  });

  return new Response(wrappedStream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}

// ── Chat Completions SSE repair wrapper ──────────────────────────────────
// We intentionally execute GPT requests through openai-oauth's
// /v1/chat/completions path because it streams real content promptly, even for
// very large Cursor agent payloads. The trade-off is that the emitted SSE has a
// critical Cursor-breaking bug:
//   - ALL responses (both tool-call AND text-only) end with finish_reason: null
//     instead of "tool_calls" or "stop". Without a proper finish_reason, Cursor
//     interprets the response as interrupted/incomplete and resends the request,
//     causing an infinite loop where the model repeats the same action forever.
//   - usage chunks may arrive before a proper finish_reason chunk
//   - mid-stream upstream errors can terminate the stream without a helpful
//     error payload for Cursor
//
// This wrapper repairs those issues without changing the underlying execution
// path that actually works well with GPT-5.4.
function repairChatCompletionsStream(response: Response, model: string): Response {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream") || !response.body) {
    return response;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let isClosed = false;
  let sseBuffer = "";
  let hasToolCalls = false;
  let hasTextContent = false;
  let hasFinishReason = false;
  const applyPatchCallIndexes = new Set<number>();
  const applyPatchArgBuffers = new Map<number, string>();
  let lastId = `chatcmpl_${crypto.randomUUID()}`;
  let lastModel = model;
  let lastCreated = Math.floor(Date.now() / 1000);
  let stallTimer: ReturnType<typeof setTimeout> | null = null;

  const STALL_TIMEOUT_MS = 180_000;

  function clearStallTimer() {
    if (stallTimer) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
  }

  function injectFinishReason(controller: ReadableStreamDefaultController) {
    if (isClosed || hasFinishReason) return;
    hasFinishReason = true;
    const reason = hasToolCalls ? "tool_calls" : "stop";
    const finishChunk = {
      id: lastId,
      object: "chat.completion.chunk",
      created: lastCreated,
      model: lastModel,
      choices: [{ index: 0, delta: {}, finish_reason: reason }],
    };
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(finishChunk)}\n\n`));
    console.log(`   [chat-fix] Injected finish_reason=${reason}`);
  }

  function flushBufferedApplyPatchArgs(controller: ReadableStreamDefaultController) {
    if (isClosed || applyPatchArgBuffers.size === 0) return;

    for (const [index, wrappedArgs] of Array.from(applyPatchArgBuffers.entries())) {
      const patchText = unwrapApplyPatchArguments(wrappedArgs);
      if (!patchText) continue;

      const patchChunk = {
        id: lastId,
        object: "chat.completion.chunk",
        created: lastCreated,
        model: lastModel,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index,
              function: { arguments: patchText },
            }],
          },
          finish_reason: null,
        }],
      };

      controller.enqueue(encoder.encode(`data: ${JSON.stringify(patchChunk)}\n\n`));
      console.log(`   [patch-fix] Unwrapped ApplyPatch arguments for Cursor (${patchText.length} chars)`);
    }

    applyPatchArgBuffers.clear();
  }

  function processEvent(eventText: string, controller: ReadableStreamDefaultController): boolean {
    const lines = eventText.split("\n").filter(Boolean);
    const dataLines = lines
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6));

    if (dataLines.length === 0) {
      controller.enqueue(encoder.encode(eventText + "\n\n"));
      return true;
    }

    const dataText = dataLines.join("\n").trim();
    if (!dataText) return false;

    if (dataText === "[DONE]") {
      flushBufferedApplyPatchArgs(controller);
      injectFinishReason(controller);
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      return true;
    }

    try {
      const parsed = JSON.parse(dataText);
      if (typeof parsed.id === "string") lastId = parsed.id;
      if (typeof parsed.model === "string") lastModel = parsed.model;
      if (typeof parsed.created === "number") lastCreated = parsed.created;

      const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
      const choice0 = choices[0];
      const delta = choice0?.delta;

      if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0) {
        hasToolCalls = true;

        const hadOnlyToolCalls =
          delta &&
          typeof delta === "object" &&
          !Array.isArray(delta) &&
          Object.keys(delta).length === 1 &&
          Array.isArray(delta.tool_calls);

        const forwardedToolCalls: any[] = [];
        for (const toolCall of delta.tool_calls) {
          const index = typeof toolCall?.index === "number" ? toolCall.index : null;
          const name = toolCall?.function?.name;
          const argDelta = typeof toolCall?.function?.arguments === "string"
            ? toolCall.function.arguments
            : "";

          if (name === "ApplyPatch" && index !== null) {
            applyPatchCallIndexes.add(index);
            if (argDelta) {
              applyPatchArgBuffers.set(index, (applyPatchArgBuffers.get(index) || "") + argDelta);
            }

            forwardedToolCalls.push({
              index,
              id: toolCall.id,
              type: toolCall.type,
              function: {
                name,
                arguments: "",
              },
            });
            continue;
          }

          if (index !== null && applyPatchCallIndexes.has(index)) {
            if (argDelta) {
              applyPatchArgBuffers.set(index, (applyPatchArgBuffers.get(index) || "") + argDelta);
            }
            continue;
          }

          forwardedToolCalls.push(toolCall);
        }

        if (forwardedToolCalls.length > 0) {
          delta.tool_calls = forwardedToolCalls;
        } else if (hadOnlyToolCalls && choice0?.finish_reason == null && choices.length === 1 && !parsed.usage) {
          return false;
        } else {
          delete delta.tool_calls;
        }
      }

      if (typeof delta?.content === "string" && delta.content.length > 0) {
        hasTextContent = true;
      }

      if (typeof choice0?.finish_reason === "string" && choice0.finish_reason) {
        hasFinishReason = true;
      }

      // openai-oauth emits the terminal chunk as delta:{} with finish_reason:null
      // for BOTH tool-call and text-only responses. Detect this pattern and inject
      // the correct finish_reason so Cursor knows the response is complete.
      if (
        choice0 &&
        choice0.finish_reason == null &&
        delta &&
        typeof delta === "object" &&
        !Array.isArray(delta) &&
        Object.keys(delta).length === 0 &&
        (hasToolCalls || hasTextContent)
      ) {
        const reason = hasToolCalls ? "tool_calls" : "stop";
        choice0.finish_reason = reason;
        hasFinishReason = true;
      }

      if (
        applyPatchArgBuffers.size > 0 &&
        (
          (choice0 && typeof choice0.finish_reason === "string" && choice0.finish_reason) ||
          (
            choice0 &&
            choice0.finish_reason == null &&
            delta &&
            typeof delta === "object" &&
            !Array.isArray(delta) &&
            Object.keys(delta).length === 0 &&
            hasToolCalls
          ) ||
          (choices.length === 0 && parsed.usage)
        )
      ) {
        flushBufferedApplyPatchArgs(controller);
      }

      // If a usage-only chunk arrives before we ever got a finish_reason, inject
      // one immediately before forwarding the usage chunk.
      if (!hasFinishReason && choices.length === 0 && parsed.usage) {
        injectFinishReason(controller);
      }

      controller.enqueue(encoder.encode(`data: ${JSON.stringify(parsed)}\n\n`));
      return true;
    } catch {
      // If parsing fails, forward the raw event instead of dropping it.
      controller.enqueue(encoder.encode(eventText + "\n\n"));
      return true;
    }
  }

  const wrappedStream = new ReadableStream({
    async pull(controller) {
      if (isClosed) return;

      try {
        while (!isClosed) {
          clearStallTimer();
          stallTimer = setTimeout(() => {
            if (isClosed) return;
            const msg = `OpenAI chat-completions stream stalled for ${STALL_TIMEOUT_MS / 1000}s.`;
            console.error(`\n❌ [OpenAI Codex] ${msg}`);
            try {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                error: { message: msg, type: "stream_timeout" },
              })}\n\ndata: [DONE]\n\n`));
              controller.close();
            } catch { /* already closed */ }
            isClosed = true;
            reader.cancel().catch(() => {});
          }, STALL_TIMEOUT_MS);

          const { done, value } = await reader.read();
          clearStallTimer();

          if (done) {
            if (!isClosed) {
              flushBufferedApplyPatchArgs(controller);
              injectFinishReason(controller);
              isClosed = true;
              controller.close();
            }
            return;
          }

          sseBuffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
          const events = sseBuffer.split("\n\n");
          sseBuffer = events.pop() || "";

          let emittedSomething = false;
          for (const eventText of events) {
            const trimmed = eventText.trim();
            if (trimmed) {
              emittedSomething = processEvent(trimmed, controller) || emittedSomething;
            }
          }

          if (emittedSomething) {
            return;
          }
        }
      } catch (error: any) {
        clearStallTimer();
        if (isClosed) return;

        const rawMessage = error instanceof Error ? error.message : String(error);
        const enhanced =
          (lastCodexError ? parseAndEnhanceCodexError(lastCodexError.message, 500) : null) ||
          parseAndEnhanceCodexError(rawMessage, 500);

        const errorPayload = enhanced
          ? { error: { message: enhanced.message, type: enhanced.type } }
          : { error: { message: `OpenAI stream error: ${rawMessage}`, type: "stream_error" } };

        console.error(`\n❌ [OpenAI Codex] Stream read error: ${rawMessage}`);
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorPayload)}\n\ndata: [DONE]\n\n`));
          controller.close();
        } catch { /* already closed */ }
        isClosed = true;
      }
    },
    cancel() {
      clearStallTimer();
      isClosed = true;
      reader.cancel().catch(() => {});
    },
  });

  return new Response(wrappedStream, {
    status: response.status,
    headers: new Headers(response.headers),
  });
}

// ── Main handler ────────────────────────────────────────────────────────

export async function handleOpenAICodexRequest(req: Request): Promise<Response> {
  const config = getConfig();
  const body = (await req.json()) as Record<string, unknown>;

  // Normalize messages and tools
  if (Array.isArray(body.messages)) {
    body.messages = normalizeCursorMessages(body.messages);
  }
  if (Array.isArray(body.tools)) {
    body.tools = normalizeCursorTools(body.tools, String(body.model || ""));
  }

  // Set reasoning effort — now goes directly to Responses API which supports "xhigh" for gpt-5.4+
  const VALID_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
  const rawEffort = (body.reasoning_effort as string) || config.openaiCodexReasoningEffort || "high";
  if (!VALID_REASONING_EFFORTS.has(rawEffort)) {
    console.warn(`   ⚠️  [OpenAI Codex] reasoning_effort "${rawEffort}" not recognized — mapping to "high"`);
    body.reasoning_effort = "high";
  } else {
    body.reasoning_effort = rawEffort;
  }

  // Ensure max_tokens is set — without it, the model may have a very low default output limit.
  // Cursor doesn't send max_tokens for GPT models, but the model needs headroom for tool calls
  // and extended reasoning. The Codex backend maps this to max_output_tokens in the Responses API.
  if (!body.max_tokens) {
    body.max_tokens = 16384; // Generous default for agentic tool-calling workflows
    console.log(`   [OpenAI Codex] Set max_tokens=${body.max_tokens} (Cursor didn't send one)`);
  }

  // For GPT models: if ApplyPatch tool is present, inject a developer message
  // reinforcing the correct patch format. GPT-5.4 gives high weight to developer
  // messages, making this the most reliable way to teach the format.
  if (isOpenAIModel(String(body.model || ""))) {
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const hasApplyPatch = tools.some(
      (t: any) => t.function?.name === "ApplyPatch" || t.name === "ApplyPatch"
    );
    if (hasApplyPatch && Array.isArray(body.messages)) {
      const formatMsg = {
        role: "developer",
        content:
          "IMPORTANT: When using the ApplyPatch tool, you MUST format patches with " +
          "a JSON arguments object whose single string field is `patch`. " +
          "Put the ENTIRE patch text inside that `patch` field; the proxy will unwrap it before Cursor executes the tool. " +
          "*** Begin Patch / *** Add File: <path> / *** Update File: <path> / " +
          "*** Delete File: <path> / *** End Patch headers. " +
          "Use @@ to start each change hunk. " +
          "NEVER use standard unified diff format (--- a/ +++ b/ headers). " +
          "The patch will be REJECTED if you use the wrong format or if you send `{}`.",
      };
      // Insert after the first system/developer message, or at position 0
      const firstNonSystemIdx = body.messages.findIndex(
        (m: any) => m.role !== "system" && m.role !== "developer"
      );
      if (firstNonSystemIdx > 0) {
        (body.messages as any[]).splice(firstNonSystemIdx, 0, formatMsg);
      } else {
        (body.messages as any[]).unshift(formatMsg);
      }
      console.log("   [patch-fix] Injected developer message for ApplyPatch format");
    }
  }

  // Strip Cursor-specific fields that openai-oauth / Codex backend don't understand
  delete body.prompt_cache_retention;
  delete body.include;
  delete body.metadata;
  delete body.reasoning;
  delete body.user;

  // Log summary — always show enough to diagnose issues
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const roleCounts: Record<string, number> = {};
  for (const m of messages) {
    const r = (m as any).role || "?";
    roleCounts[r] = (roleCounts[r] || 0) + 1;
  }

  // Count tool_calls in assistant messages for loop detection
  let totalToolCalls = 0;
  const toolCallNames: Record<string, number> = {};
  for (const m of messages) {
    const msg = m as any;
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        totalToolCalls++;
        const name = tc.function?.name || "?";
        toolCallNames[name] = (toolCallNames[name] || 0) + 1;
      }
    }
  }

  console.log(`   [OpenAI Codex] Model: ${body.model}, reasoning: ${body.reasoning_effort}, stream: ${body.stream}, messages: ${messages.length} (${Object.entries(roleCounts).map(([r, c]) => `${r}:${c}`).join(" ")}), tools: ${tools.length}`);
  if (totalToolCalls > 0) {
    console.log(`   [OpenAI Codex] Tool calls in history: ${totalToolCalls} (${Object.entries(toolCallNames).map(([n, c]) => `${n}:${c}`).join(" ")})`);
  }

  // Detect potential tool call loops — if the last N tool calls are the same tool with similar args
  if (totalToolCalls >= 4) {
    const lastAssistantMsgs = messages.filter((m: any) => m.role === "assistant" && m.tool_calls?.length > 0).slice(-4);
    const lastToolNames = lastAssistantMsgs.flatMap((m: any) => m.tool_calls?.map((tc: any) => tc.function?.name) || []);
    const uniqueNames = new Set(lastToolNames);
    if (uniqueNames.size === 1 && lastToolNames.length >= 4) {
      console.warn(`   ⚠️  [OpenAI Codex] POSSIBLE TOOL CALL LOOP DETECTED: Last ${lastToolNames.length} tool calls are all "${lastToolNames[0]}". The model may be stuck.`);
    }
  }

  logger.verbose(`   [OpenAI Codex] Normalized request body:\n${JSON.stringify(body, null, 2)}`);

  // Debug logging — writes detailed request data to openai-debug.log
  const debugInfo = debugLogRequest(body);

  // ── Production architecture: openai-oauth chat-completions + targeted SSE repair ──
  // Raw /v1/responses passthrough looked attractive on paper, but for real
  // Cursor-sized GPT-5.4 agent payloads it can sit on a 200 OK response without
  // emitting any visible content for a very long time. The openai-oauth
  // /v1/chat/completions route, despite its finish_reason bugs, streams real
  // assistant content promptly. We therefore execute through chat-completions and
  // repair the broken SSE details that Cursor cares about.
  console.log(`   [chat-repair] Sending to /v1/chat/completions via openai-oauth`);

  const internalRequest = new Request("http://internal/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const oauthHandler = getHandler();
  let response: Response;

  try {
    response = await oauthHandler(internalRequest);
  } catch (handlerError: any) {
    const msg = handlerError instanceof Error ? handlerError.message : String(handlerError);
    console.error(`\n❌ [OpenAI Codex] Handler error: ${msg}`);
    debugLogError(debugInfo, msg, handlerError?.responseBody);

    const statusCode = handlerError?.statusCode;
    const respBody = handlerError?.responseBody;

    if (respBody) {
      console.error(`   responseBody: ${respBody}`);
      const enhanced = parseAndEnhanceCodexError(respBody, statusCode || 500);
      if (enhanced) {
        return Response.json(
          { error: { message: enhanced.message, type: enhanced.type } },
          { status: enhanced.status, headers: { "Access-Control-Allow-Origin": "*" } }
        );
      }
    }

    return Response.json(
      { error: { message: `OpenAI Codex error: ${msg}`, type: "api_error" } },
      { status: statusCode || 502, headers: { "Access-Control-Allow-Origin": "*" } }
    );
  }

  // Log non-200 responses
  if (!response.ok) {
    let errorBody = "";
    try {
      errorBody = await response.clone().text();
    } catch (cloneErr) {
      console.warn(`   ⚠️  [handler] Could not read error response body: ${cloneErr instanceof Error ? cloneErr.message : "read error"}`);
    }
    console.error(`\n❌ [OpenAI Codex] HTTP ${response.status} error:`);
    console.error(`   responseBody: ${JSON.stringify(errorBody)}`);
    debugLogError(debugInfo, `HTTP ${response.status}`, errorBody);

    const enhanced = parseAndEnhanceCodexError(errorBody, response.status);
    if (enhanced) {
      return Response.json(
        { error: { message: enhanced.message, type: enhanced.type } },
        { status: enhanced.status, headers: { "Access-Control-Allow-Origin": "*" } }
      );
    }

    const responseHeaders = new Headers(response.headers);
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    return new Response(response.body, { status: response.status, headers: responseHeaders });
  }

  debugLogResponse(debugInfo, response.status, !!body.stream);

  const repairedStream = repairChatCompletionsStream(response, String(body.model || "gpt-5.4"));

  // Debug logger for visibility
  const debuggedStream = debugWrapStream(repairedStream, debugInfo);

  const responseHeaders = new Headers(debuggedStream.headers);
  responseHeaders.set("Access-Control-Allow-Origin", "*");

  return new Response(debuggedStream.body, {
    status: debuggedStream.status,
    headers: responseHeaders,
  });
}

/**
 * Check if a model name is an OpenAI model (not Claude).
 */
export function isOpenAIModel(model: string): boolean {
  const lower = model.toLowerCase();
  return (
    lower.startsWith("gpt-") ||
    lower.startsWith("o1") ||
    lower.startsWith("o3") ||
    lower.startsWith("o4") ||
    lower.startsWith("chatgpt-")
  );
}
