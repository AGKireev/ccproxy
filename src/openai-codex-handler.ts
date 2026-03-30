/**
 * OpenAI Codex handler using the openai-oauth library.
 *
 * Cursor sends messages in Responses API item format mixed with Chat Completions:
 *   - {role: "assistant", content: [{type: "output_text", text: "..."}]}
 *   - {type: "function_call", call_id, name, arguments}  (no role!)
 *   - {type: "function_call_output", call_id, output: [{type: "input_text", text: "..."}]}  (no role!)
 *   - {role: "user", content: [{type: "input_text", text: "..."}]}
 *
 * The openai-oauth library (Vercel AI SDK) expects PURE OpenAI Chat Completions format:
 *   - {role: "assistant", content: "text", tool_calls: [...]}
 *   - {role: "tool", content: "text", tool_call_id: "..."}
 *   - {role: "user", content: "text" | [{type: "text", text: "..."}, {type: "image_url", ...}]}
 *
 * This module normalizes Cursor's format before passing to the library.
 */

import { createOpenAIOAuthFetchHandler } from "openai-oauth";
import type { OpenAIOAuthServerOptions } from "openai-oauth";
import { getConfig } from "./config";
import { logger } from "./logger";
import {
  isOpenAIDebugEnabled,
  debugLogRequest,
  debugLogResponse,
  debugLogError,
  debugWrapStream,
  type DebugRequestInfo,
} from "./openai-debug";

let handler: ((request: Request) => Promise<Response>) | null = null;

// Track the last error from openai-oauth for enriching stream errors
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

// ── finish_reason fixer ─────────────────────────────────────────────────
// The openai-oauth library (via Vercel AI SDK) sometimes emits finish_reason: null
// even when the model returned tool calls. Cursor relies on finish_reason: "tool_calls"
// to know that tool calls need executing; without it, Cursor drops the tool_calls
// from the assistant message, never executes them, and sends the same history back,
// causing an infinite loop.
//
// This wrapper tracks tool_call deltas in the SSE stream and:
//  1. Rewrites finish_reason: null → "tool_calls" if tool call chunks were seen
//  2. Injects a finish_reason chunk if the stream ends without one

function fixToolCallFinishReason(response: Response): Response {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream") || !response.body) {
    console.log("   [finish-fix] SKIP: not SSE or no body");
    return response;
  }

  console.log("   [finish-fix] Active — wrapping SSE stream");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let hasToolCalls = false;
  let emittedToolCallsFinish = false;
  let lastId = "chatcmpl-proxy";
  let lastModel = "gpt-5.4";
  let readCount = 0;

  // Simpler approach: process each raw chunk, scan for tool_calls and finish_reason,
  // and modify the bytes directly if needed.
  const wrappedStream = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        readCount++;

        if (done) {
          console.log(`   [finish-fix] Stream done after ${readCount} reads. hasToolCalls=${hasToolCalls}, emittedFinish=${emittedToolCallsFinish}`);
          // If we saw tool calls but no proper finish_reason, inject one + [DONE]
          if (hasToolCalls && !emittedToolCallsFinish) {
            console.log("   🔧 [OpenAI Codex] Injecting finish_reason: tool_calls at stream end");
            const finishChunk = `data: ${JSON.stringify({
              id: lastId,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: lastModel,
              choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            })}\n\n`;
            controller.enqueue(encoder.encode(finishChunk));
          }
          controller.close();
          return;
        }

        const text = decoder.decode(value, { stream: true });

        // Quick scan: does this chunk contain tool_calls?
        if (!hasToolCalls && text.includes('"tool_calls"')) {
          hasToolCalls = true;
          console.log(`   [finish-fix] Detected tool_calls in read #${readCount}`);
        }

        // Check for [DONE] — if present and we need to inject, do it before [DONE]
        if (hasToolCalls && !emittedToolCallsFinish && text.includes("data: [DONE]")) {
          console.log("   🔧 [OpenAI Codex] Injecting finish_reason: tool_calls before [DONE]");
          const finishEvent = `data: ${JSON.stringify({
            id: lastId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: lastModel,
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          })}\n\n`;
          // Insert our finish event before [DONE]
          const modified = text.replace("data: [DONE]", finishEvent + "data: [DONE]");
          emittedToolCallsFinish = true;
          controller.enqueue(encoder.encode(modified));
          return;
        }

        // Check if this chunk has a real finish_reason (not null)
        // Match finish_reason with any non-null value like "stop", "tool_calls", etc.
        const finishMatch = text.match(/"finish_reason"\s*:\s*"([^"]+)"/);
        if (finishMatch) {
          emittedToolCallsFinish = true;
          if (readCount <= 3) {
            console.log(`   [finish-fix] Found real finish_reason: "${finishMatch[1]}" in read #${readCount}`);
          }
        }

        // Also try to rewrite finish_reason: null on the "finish" chunk
        // The finish chunk has empty delta {} and finish_reason: null
        if (hasToolCalls && !emittedToolCallsFinish) {
          // Look for the pattern: empty delta + null finish_reason
          // This regex finds: "delta":{},"finish_reason":null  (the finish chunk)
          const emptyDeltaFinish = text.match(/"delta"\s*:\s*\{\s*\}\s*,\s*"finish_reason"\s*:\s*null/);
          if (emptyDeltaFinish) {
            console.log("   🔧 [OpenAI Codex] Rewriting finish_reason: null → tool_calls");
            const modified = text.replace(
              /"delta"\s*:\s*\{\s*\}\s*,\s*"finish_reason"\s*:\s*null/,
              '"delta":{},"finish_reason":"tool_calls"'
            );
            emittedToolCallsFinish = true;
            controller.enqueue(encoder.encode(modified));
            return;
          }
        }

        // Track metadata from the first few chunks
        if (readCount <= 2) {
          const idMatch = text.match(/"id"\s*:\s*"([^"]+)"/);
          if (idMatch) lastId = idMatch[1];
          const modelMatch = text.match(/"model"\s*:\s*"([^"]+)"/);
          if (modelMatch) lastModel = modelMatch[1];
        }

        // Pass through unmodified
        controller.enqueue(value);
      } catch (error) {
        throw error;
      }
    },
    cancel() {
      reader.cancel();
    },
  });

  const headers = new Headers(response.headers);
  return new Response(wrappedStream, { status: response.status, headers });
}

// ── Stream error wrapper ────────────────────────────────────────────────
// The openai-oauth library returns streaming responses with status 200 immediately.
// If the Codex backend returns an error (e.g., usage_limit_reached), the library
// calls controller.error() on the ReadableStream — which just abruptly kills the
// stream. Cursor sees the stream stop but gets no error message, so it looks like
// the model just silently stopped responding.
//
// This wrapper intercepts stream aborts and converts them into a proper OpenAI-format
// error response that Cursor can display to the user.

function wrapStreamWithErrorHandling(response: Response, model: string): Response {
  const contentType = response.headers.get("content-type") || "";
  const isSSE = contentType.includes("text/event-stream");

  // Only wrap SSE streaming responses
  if (!isSSE || !response.body) return response;

  const reader = response.body.getReader();
  const encoder = new TextEncoder();

  let hasReceivedData = false;

  const wrappedStream = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        hasReceivedData = true;
        controller.enqueue(value);
      } catch (error: any) {
        // Stream was aborted by the library — this is where usage_limit_reached etc. end up
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`\n❌ [OpenAI Codex] Stream error intercepted: ${errorMessage}`);

        // Try to extract structured error info using multiple sources:
        // 1. The error's responseBody (Vercel AI SDK APICallError)
        // 2. The error message text
        // 3. The lastCodexError from the logger callback
        let userFacingMessage = `OpenAI error: ${errorMessage}`;
        let errorType = "api_error";

        // Source 1: Vercel AI SDK APICallError carries responseBody
        if (error?.responseBody) {
          console.error(`   responseBody: ${error.responseBody}`);
          const enhanced = parseAndEnhanceCodexError(error.responseBody, error.statusCode || 500);
          if (enhanced) {
            userFacingMessage = enhanced.message;
            errorType = enhanced.type;
          }
        }

        // Source 2: Check error message for embedded JSON or known patterns
        if (errorType === "api_error") {
          const jsonMatch = errorMessage.match(/\{[\s\S]*"error"[\s\S]*\}/);
          if (jsonMatch) {
            const enhanced = parseAndEnhanceCodexError(jsonMatch[0], 500);
            if (enhanced) {
              userFacingMessage = enhanced.message;
              errorType = enhanced.type;
            }
          } else if (errorMessage.includes("usage_limit") || errorMessage.includes("usage limit")) {
            userFacingMessage = "OpenAI usage limit reached. Switch to a Claude model or wait for the limit to reset.";
            errorType = "usage_limit_reached";
          } else if (errorMessage.includes("rate_limit")) {
            userFacingMessage = "OpenAI rate limit hit. Please wait a moment and try again.";
            errorType = "rate_limit_error";
          }
        }

        // Source 3: Recent error from the logger callback
        if (errorType === "api_error" && lastCodexError && (Date.now() - lastCodexError.timestamp) < 5000) {
          const errMsg = lastCodexError.message;
          if (errMsg.includes("usage_limit") || errMsg.includes("usage limit")) {
            userFacingMessage = "OpenAI usage limit reached. Switch to a Claude model or wait for the limit to reset.";
            errorType = "usage_limit_reached";
          }
        }

        // Build an OpenAI-format error SSE event so Cursor can display it
        const errorPayload = {
          error: {
            message: userFacingMessage,
            type: errorType,
            code: errorType,
          },
        };

        const errorSSE = `data: ${JSON.stringify(errorPayload)}\n\ndata: [DONE]\n\n`;
        try {
          controller.enqueue(encoder.encode(errorSSE));
          controller.close();
        } catch {
          // Controller may already be closed
        }
      }
    },
    cancel() {
      reader.cancel();
    },
  });

  const headers = new Headers(response.headers);
  return new Response(wrappedStream, {
    status: response.status,
    headers,
  });
}

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
        } catch {}
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

    // ── Responses API: function_call (no role) ──
    if (itemType === "function_call") {
      const tc: ToolCall = {
        id: (msg.call_id || msg.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`) as string,
        type: "function",
        function: {
          name: (msg.name || "") as string,
          arguments: typeof msg.arguments === "string" ? msg.arguments : JSON.stringify(msg.arguments || {}),
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

    // ── Responses API: function_call_output (no role) ──
    if (itemType === "function_call_output") {
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

    // ── Unknown: skip items with no role and no recognized type ──
    if (role) {
      result.push({ role, content: extractText(msg.content) });
    }
  }

  return result;
}

/** Normalize Cursor's tool definitions to OpenAI format. */
function normalizeCursorTools(tools: unknown[]): unknown[] {
  return tools.map((tool: any) => {
    if (tool.type === "function" && tool.function) return tool;
    if (tool.name) {
      return {
        type: "function",
        function: {
          name: tool.name,
          description: tool.description || "",
          parameters: tool.input_schema || tool.parameters || { type: "object", properties: {} },
        },
      };
    }
    return tool;
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
    body.tools = normalizeCursorTools(body.tools);
  }

  // Inject default reasoning_effort
  if (!body.reasoning_effort) {
    body.reasoning_effort = config.openaiCodexReasoningEffort || "high";
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

  // Build a Request for the openai-oauth handler
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
    // The handler itself threw — this should be rare since createOpenAIOAuthFetchHandler
    // has its own catch, but handle it defensively.
    const msg = handlerError instanceof Error ? handlerError.message : String(handlerError);
    console.error(`\n❌ [OpenAI Codex] Handler error: ${msg}`);
    debugLogError(debugInfo, msg, handlerError?.responseBody);

    // Check if it's a Vercel AI SDK APICallError (has statusCode and responseBody)
    const statusCode = handlerError?.statusCode;
    const respBody = handlerError?.responseBody;

    if (respBody) {
      console.error(`   responseBody: ${respBody}`);
      // Try to parse and enhance known error types
      try {
        const parsed = JSON.parse(respBody);
        if (parsed?.error?.type === "usage_limit_reached") {
          const resetsAt = parsed.error.resets_at;
          const resetTime = resetsAt ? new Date(resetsAt * 1000) : null;
          const enhanced = `OpenAI usage limit reached (${parsed.error.plan_type || "Plus"} plan).${resetTime ? ` Resets at: ${resetTime.toLocaleString()}` : ""} Switch to a Claude model or wait for the limit to reset.`;
          console.error(`⚠️  [OpenAI Codex] Usage limit reached!${resetTime ? ` Resets at: ${resetTime.toLocaleString()}` : ""}`);
          return Response.json(
            { error: { message: enhanced, type: "usage_limit_reached" } },
            { status: statusCode || 429, headers: { "Access-Control-Allow-Origin": "*" } }
          );
        }
      } catch {}
    }

    return Response.json(
      { error: { message: `OpenAI Codex error: ${msg}`, type: "api_error" } },
      { status: statusCode || 502, headers: { "Access-Control-Allow-Origin": "*" } }
    );
  }

  // Log non-200 responses clearly so they're visible in the proxy console
  if (!response.ok) {
    let errorBody = "";
    try {
      errorBody = await response.clone().text();
    } catch {}
    console.error(`\n❌ [OpenAI Codex] HTTP ${response.status} error from openai-oauth:`);
    console.error(`   responseBody: ${JSON.stringify(errorBody)}`);
    debugLogError(debugInfo, `HTTP ${response.status}`, errorBody);

    // Parse and enhance known error types for better Cursor display
    const enhanced = parseAndEnhanceCodexError(errorBody, response.status);
    if (enhanced) {
      return Response.json(
        { error: { message: enhanced.message, type: enhanced.type } },
        { status: enhanced.status, headers: { "Access-Control-Allow-Origin": "*" } }
      );
    }

    const responseHeaders = new Headers(response.headers);
    responseHeaders.set("Access-Control-Allow-Origin", "*");

    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders,
    });
  }

  debugLogResponse(debugInfo, response.status, !!body.stream);

  // Debug: wrap stream to capture SSE chunks to openai-debug.log
  let processedResponse = debugWrapStream(response, debugInfo);

  // FIX: Ensure finish_reason: "tool_calls" is present when the model emits tool calls
  // Without this, Cursor drops tool calls and creates an infinite loop
  processedResponse = fixToolCallFinishReason(processedResponse);

  // Wrap streaming responses to catch mid-stream errors (usage_limit_reached, etc.)
  processedResponse = wrapStreamWithErrorHandling(processedResponse, String(body.model));

  const responseHeaders = new Headers(processedResponse.headers);
  responseHeaders.set("Access-Control-Allow-Origin", "*");

  return new Response(processedResponse.body, {
    status: processedResponse.status,
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
