import { getConfig, CLAUDE_CREDENTIALS_PATH } from "./src/config";
import { loadCredentials, getValidToken } from "./src/oauth";
import { proxyRequest } from "./src/anthropic-client";
import {
  openaiToAnthropic,
  anthropicToOpenai,
  createOpenAIStreamChunk,
  createOpenAIStreamStart,
  createOpenAIToolCallChunk,
  parseXMLToolCalls,
  type OpenAIChatRequest,
} from "./src/openai-adapter";
import {
  isOpenAIPassthroughEnabled,
  proxyOpenAIRequest,
} from "./src/openai-passthrough";
import {
  getDb,
  getAnalytics,
  getBudgetSettings,
  updateBudgetSettings,
  getRecentRequests,
  resetAnalytics,
  type BudgetSettings,
} from "./src/db";
import { formatCost } from "./src/pricing";
import type { AnthropicRequest, AnthropicError } from "./src/types";
import {
  translateToolCalls,
  needsTranslation,
} from "./src/tool-call-translator";
import { logger } from "./src/logger";

const config = getConfig();

function shouldPassthroughToOpenAI(model: string): boolean {
  if (!isOpenAIPassthroughEnabled()) return false;
  const normalized = model.toLowerCase();
  // Pass through non-Claude models (GPT, Gemini, Llama, etc.)
  return !normalized.includes("claude");
}

async function checkCredentials(): Promise<boolean> {
  const creds = await loadCredentials();
  if (!creds?.claudeAiOauth) {
    console.log("\n⚠️  No Claude Code credentials found.");
    console.log(`   Expected at: ${CLAUDE_CREDENTIALS_PATH}`);
    console.log("   Run 'claude /login' to authenticate.\n");

    if (config.anthropicApiKey) {
      console.log("✓ Fallback ANTHROPIC_API_KEY is configured");
      return true;
    }

    console.log("⚠️  No ANTHROPIC_API_KEY fallback configured either.");
    return false;
  }

  console.log("✓ Claude Code credentials loaded");

  const token = await getValidToken();
  if (token) {
    const expiresIn = Math.round((token.expiresAt - Date.now()) / 1000 / 60);
    console.log(`  Token expires in ${expiresIn} minutes`);
  }

  if (config.anthropicApiKey) {
    console.log("✓ Fallback ANTHROPIC_API_KEY configured");
  } else {
    console.log(
      "⚠️  No fallback ANTHROPIC_API_KEY (will fail if Claude Code limits hit)"
    );
  }

  return true;
}

function logRequestDetails(req: Request, endpoint: string) {
  const url = new URL(req.url);
  const userAgent = req.headers.get("user-agent") || "unknown";
  const origin = req.headers.get("origin") || "none";
  const referer = req.headers.get("referer") || "none";
  const cfRay = req.headers.get("cf-ray") || "none";
  const cfConnectingIp = req.headers.get("cf-connecting-ip") || "none";
  const xForwardedFor = req.headers.get("x-forwarded-for") || "none";
  const xRealIp = req.headers.get("x-real-ip") || "none";

  const anthropicBeta = req.headers.get("anthropic-beta") || "none";

  console.log(`\n📥 [${endpoint}] Request Details:`);
  console.log(`   User-Agent: ${userAgent}`);
  console.log(`   Origin: ${origin}`);
  console.log(`   Referer: ${referer}`);
  console.log(`   CF-Ray: ${cfRay}`);
  console.log(`   CF-Connecting-IP: ${cfConnectingIp} (Cursor backend server)`);
  console.log(`   X-Forwarded-For: ${xForwardedFor}`);
  console.log(`   X-Real-IP: ${xRealIp}`);
  console.log(`   Anthropic-Beta: ${anthropicBeta}`);
  console.log(`   URL: ${url.pathname}${url.search}`);
  console.log(`   Method: ${req.method}`);

  // Log all headers (useful for debugging tunnel issues)
  const allHeaders: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    allHeaders[key] = value;
  });
  console.log(`   All Headers: ${JSON.stringify(allHeaders, null, 2)}`);
}

function extractHeaders(req: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  const passthrough = ["anthropic-version", "anthropic-beta"];

  for (const key of passthrough) {
    const value = req.headers.get(key);
    if (value) headers[key] = value;
  }

  if (!headers["anthropic-version"]) {
    headers["anthropic-version"] = "2023-06-01";
  }

  return headers;
}

function extractAPIKey(req: Request): string | null {
  // Check Authorization header (Bearer token)
  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const apiKey = authHeader.substring(7).trim();
    // Only use if it looks like an Anthropic API key (starts with sk-ant-)
    if (apiKey.startsWith("sk-ant-")) {
      return apiKey;
    }
  }

  // Check x-api-key header (Anthropic format)
  const apiKeyHeader = req.headers.get("x-api-key");
  if (apiKeyHeader?.startsWith("sk-ant-")) {
    return apiKeyHeader;
  }

  return null;
}

function checkIPWhitelist(req: Request): {
  allowed: boolean;
  ip?: string;
  reason?: string;
} {
  // Only enforce IP whitelist when requests come through tunnel (have CF headers)
  const cfRay = req.headers.get("cf-ray");
  const cfConnectingIp = req.headers.get("cf-connecting-ip");

  // If no CF headers, assume local request (allow)
  if (!cfRay && !cfConnectingIp) {
    return { allowed: true, ip: "local" };
  }

  // If CF headers present, validate IP
  const clientIP =
    cfConnectingIp || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();

  if (!clientIP) {
    return { allowed: false, reason: "No IP found in headers" };
  }

  const isAllowed = config.allowedIPs.includes(clientIP);

  if (!isAllowed) {
    console.log(
      `\n🚫 [SECURITY] Blocked request from unauthorized IP: ${clientIP}`
    );
    console.log(`   Allowed IPs: ${config.allowedIPs.join(", ")}`);
    console.log(`   CF-Ray: ${cfRay}`);
  }

  return {
    allowed: isAllowed,
    ip: clientIP,
    reason: isAllowed ? undefined : `IP ${clientIP} not in whitelist`,
  };
}

const server = Bun.serve({
  port: config.port,
  idleTimeout: 255, // 255 seconds for streaming responses

  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers":
            "Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta",
        },
      });
    }

    // Check IP whitelist for API endpoints (not health checks)
    if (
      url.pathname.startsWith("/v1/") ||
      url.pathname.startsWith("/analytics") ||
      url.pathname.startsWith("/budget")
    ) {
      const ipCheck = checkIPWhitelist(req);
      if (!ipCheck.allowed) {
        return Response.json(
          {
            error: {
              type: "authentication_error",
              message: `Unauthorized: ${
                ipCheck.reason || "IP not whitelisted"
              }`,
            },
          },
          { status: 403 }
        );
      }
    }

    if (url.pathname === "/health" || url.pathname === "/") {
      const token = await getValidToken();
      return Response.json({
        status: "ok",
        claudeCode: {
          authenticated: !!token,
          expiresAt: token?.expiresAt,
        },
        fallback: !!config.anthropicApiKey,
        openaiPassthrough: {
          enabled: isOpenAIPassthroughEnabled(),
          baseUrl: config.openaiBaseUrl,
        },
      });
    }

    // Anthropic-compatible endpoint
    if (url.pathname === "/v1/messages" && req.method === "POST") {
      try {
        logRequestDetails(req, "Anthropic /v1/messages");
        const body = (await req.json()) as AnthropicRequest;
        const headers = extractHeaders(req);

        // Check if user provided their own API key
        const userAPIKey = extractAPIKey(req);
        if (userAPIKey) {
          console.log(`\n🔑 Using user-provided API key from request`);
        }

        console.log(
          `\n→ Model: "${body.model}" | ${
            body.stream ? "stream" : "sync"
          } | max_tokens=${body.max_tokens}`
        );

        const response = await proxyRequest(
          "/v1/messages",
          body,
          headers,
          userAPIKey || undefined
        );

        const responseHeaders = new Headers(response.headers);
        responseHeaders.set("Access-Control-Allow-Origin", "*");

        return new Response(response.body, {
          status: response.status,
          headers: responseHeaders,
        });
      } catch (error) {
        console.error("Request handling error:", error);
        return Response.json(
          {
            type: "error",
            error: { type: "invalid_request_error", message: String(error) },
          } satisfies AnthropicError,
          { status: 400 }
        );
      }
    }

    // OpenAI-compatible endpoint
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      try {
        logRequestDetails(req, "OpenAI /v1/chat/completions");
        const openaiBody = (await req.json()) as OpenAIChatRequest;

        // Log the request body from Cursor (truncated)
        const bodyStr = JSON.stringify(openaiBody, null, 2);
        const truncatedBody =
          bodyStr.length > 500
            ? bodyStr.substring(0, 500) + "... [truncated]"
            : bodyStr;

        console.log(`\n📋 [Cursor Request Body]:`);
        console.log(`   Model: "${openaiBody.model}"`);
        console.log(`   Stream: ${openaiBody.stream || false}`);
        console.log(
          `   Max Tokens: ${
            openaiBody.max_tokens ||
            openaiBody.max_completion_tokens ||
            "not set"
          }`
        );
        console.log(`   Temperature: ${openaiBody.temperature || "not set"}`);
        console.log(`   Messages Count: ${openaiBody.messages?.length || 0}`);

        // Log the FULL raw request body to file for debugging tool call format
        logger.verbose(`\n🔍 [FULL Cursor Request Body]:`);
        logger.verbose(JSON.stringify(openaiBody, null, 2));

        // Log all messages, especially system messages (verbose to file)
        if (openaiBody.messages && openaiBody.messages.length > 0) {
          logger.verbose(`\n📝 [Cursor Messages]:`);
          openaiBody.messages.forEach((msg, idx) => {
            const content =
              typeof msg.content === "string"
                ? msg.content
                : JSON.stringify(msg.content);

            // For system messages, log the full content (might contain tool call format instructions)
            if (msg.role === "system") {
              logger.verbose(
                `   [${idx}] System Message (${content.length} chars):`
              );
              logger.verbose(
                `   ${content
                  .split("\n")
                  .map((l: string) => `      ${l}`)
                  .join("\n")}`
              );
            } else {
              // For other messages, log full content (no truncation in verbose mode)
              logger.verbose(
                `   [${idx}] ${msg.role} (${content.length} chars):`
              );
              logger.verbose(
                `   ${content
                  .split("\n")
                  .map((l: string) => `      ${l}`)
                  .join("\n")}`
              );
            }
          });
        }

        console.log(`\n   Body Preview: ${truncatedBody}`);

        // Passthrough to OpenAI/OpenRouter for non-Claude models
        if (shouldPassthroughToOpenAI(openaiBody.model)) {
          console.log(
            `\n→ [OpenAI Passthrough] ${openaiBody.model} | ${
              openaiBody.stream ? "stream" : "sync"
            }`
          );

          const response = await proxyOpenAIRequest(
            "/v1/chat/completions",
            openaiBody
          );

          const responseHeaders = new Headers(response.headers);
          responseHeaders.set("Access-Control-Allow-Origin", "*");

          return new Response(response.body, {
            status: response.status,
            headers: responseHeaders,
          });
        }

        // Convert to Anthropic for Claude models
        const anthropicBody = openaiToAnthropic(openaiBody);
        const headers = extractHeaders(req);

        // Check if user provided their own API key
        const userAPIKey = extractAPIKey(req);
        if (userAPIKey) {
          console.log(`\n🔑 Using user-provided API key from request`);
        }

        console.log(
          `\n→ [OpenAI→Anthropic] Original: "${
            openaiBody.model
          }" → Normalized: "${anthropicBody.model}" | ${
            anthropicBody.stream ? "stream" : "sync"
          } | max_tokens=${anthropicBody.max_tokens}`
        );
        if (anthropicBody.reasoning_budget) {
          console.log(`   Reasoning Budget: ${anthropicBody.reasoning_budget}`);
        }

        // Log the system prompt that will be sent to Claude Code (verbose to file)
        if (anthropicBody.system) {
          const systemContent =
            typeof anthropicBody.system === "string"
              ? anthropicBody.system
              : Array.isArray(anthropicBody.system)
              ? anthropicBody.system
                  .map((block) =>
                    block &&
                    typeof block === "object" &&
                    "type" in block &&
                    block.type === "text"
                      ? block.text
                      : JSON.stringify(block)
                  )
                  .join("\n")
              : String(anthropicBody.system);
          logger.verbose(
            `\n📋 [Anthropic System Prompt] (${systemContent.length} chars):`
          );
          logger.verbose(
            systemContent
              .split("\n")
              .map((l: string) => `   ${l}`)
              .join("\n")
          );
        }

        // Log Anthropic messages (verbose to file)
        if (anthropicBody.messages && anthropicBody.messages.length > 0) {
          logger.verbose(
            `\n📨 [Anthropic Messages] (${anthropicBody.messages.length}):`
          );
          anthropicBody.messages.forEach((msg, idx) => {
            const content =
              typeof msg.content === "string"
                ? msg.content
                : Array.isArray(msg.content)
                ? msg.content
                    .map((block) =>
                      block &&
                      typeof block === "object" &&
                      "type" in block &&
                      block.type === "text"
                        ? block.text
                        : JSON.stringify(block)
                    )
                    .join("\n")
                : JSON.stringify(msg.content);
            // Log full content (no truncation in verbose mode for debugging tool calls)
            logger.verbose(
              `   [${idx}] ${msg.role} (${content.length} chars):`
            );
            logger.verbose(
              `   ${content
                .split("\n")
                .map((l: string) => `      ${l}`)
                .join("\n")}`
            );
          });
        }

        // Log what we're about to send (before Claude Code preparation)
        console.log(`\n📤 [Prepared Request Summary]:`);
        console.log(`   System prompt present: ${!!anthropicBody.system}`);
        if (anthropicBody.system) {
          const sysStr =
            typeof anthropicBody.system === "string"
              ? anthropicBody.system
              : "array";
          console.log(
            `   System type: ${typeof anthropicBody.system}, preview: ${String(
              sysStr
            ).substring(0, 100)}...`
          );
        }

        const response = await proxyRequest(
          "/v1/messages",
          anthropicBody,
          headers,
          userAPIKey || undefined
        );

        console.log(
          `   [Debug] Response status: ${response.status}, ok: ${response.ok}`
        );

        if (!response.ok) {
          const errorText = await response
            .clone()
            .text()
            .catch(() => "Unable to read error");
          console.log(
            `   [Debug] Error response: ${errorText.substring(0, 500)}`
          );
        }

        console.log(
          `   [Debug] Response headers: ${JSON.stringify(
            Object.fromEntries(response.headers)
          )}`
        );
        console.log(
          `   [Debug] Response body readable: ${response.body !== null}`
        );

        const responseHeaders = new Headers();
        responseHeaders.set("Access-Control-Allow-Origin", "*");
        responseHeaders.set("Content-Type", "application/json");

        // Handle streaming
        if (anthropicBody.stream && response.ok) {
          responseHeaders.set("Content-Type", "text/event-stream");
          responseHeaders.set("Cache-Control", "no-cache");
          responseHeaders.set("Connection", "keep-alive");
          responseHeaders.set("X-Accel-Buffering", "no"); // Disable buffering for nginx/proxies

          const streamId = Date.now().toString();
          const reader = response.body?.getReader();

          logger.verbose(
            `   [Debug] Stream reader created: ${reader !== null}`
          );

          if (!reader) {
            return Response.json(
              { error: { message: "No response body" } },
              { status: 500 }
            );
          }

          let cancelled = false;
          const stream = new ReadableStream({
            async start(controller) {
              const decoder = new TextDecoder();
              let buffer = "";
              let sentStart = false;
              let toolCallBuffer = ""; // Buffer for tool calls that span multiple chunks
              let inToolCall = false;
              let lastChunkTime = Date.now();
              const HEARTBEAT_INTERVAL = 5000; // Send heartbeat every 5 seconds if buffering
              let currentBlockIndex = -1; // Track which content block we're processing
              let blockTextSent = false; // Track if we've sent text from content_block_start
              let toolCallIndex = 0; // Track tool call index for OpenAI format
              let currentToolCall: {
                id: string;
                name: string;
                inputJson: string;
              } | null = null; // Current tool_use block being streamed

              // Helper to safely enqueue data
              const safeEnqueue = (data: Uint8Array) => {
                try {
                  if (!cancelled) {
                    controller.enqueue(data);
                  }
                } catch {
                  // Controller might be closed, ignore
                  cancelled = true;
                }
              };

              try {
                logger.verbose(`   [Debug] Starting to read stream...`);
                let chunkCount = 0;
                while (true) {
                  if (cancelled) {
                    logger.verbose(`   [Debug] Stream cancelled by client`);
                    break;
                  }

                  const { done, value } = await reader.read();
                  if (done) {
                    console.log(
                      `   [Debug] Stream ended after ${chunkCount} chunks`
                    );
                    break;
                  }

                  if (cancelled) break;

                  chunkCount++;
                  if (chunkCount === 1) {
                    console.log(
                      `   [Debug] First chunk received, length: ${value.length}`
                    );
                  }

                  buffer += decoder.decode(value, { stream: true });
                  const lines = buffer.split("\n");
                  buffer = lines.pop() || "";

                  for (const line of lines) {
                    if (cancelled) break;
                    if (!line.startsWith("data: ")) continue;
                    const data = line.slice(6);
                    if (data === "[DONE]") {
                      safeEnqueue(new TextEncoder().encode("data: [DONE]\n\n"));
                      continue;
                    }

                    try {
                      const event = JSON.parse(data);
                      if (chunkCount === 1) {
                        console.log(
                          `   [Debug] First event type: ${
                            event.type
                          }, full event: ${JSON.stringify(event).substring(
                            0,
                            200
                          )}`
                        );
                      }

                      // Handle message_start - send OpenAI start chunk
                      if (event.type === "message_start" && !sentStart) {
                        safeEnqueue(
                          new TextEncoder().encode(
                            createOpenAIStreamStart(streamId, openaiBody.model)
                          )
                        );
                        sentStart = true;
                        console.log(
                          `   [Debug] Sent OpenAI stream start chunk`
                        );
                      }

                      // Handle content_block_start - ensure we've sent start
                      if (event.type === "content_block_start") {
                        if (!sentStart) {
                          safeEnqueue(
                            new TextEncoder().encode(
                              createOpenAIStreamStart(
                                streamId,
                                openaiBody.model
                              )
                            )
                          );
                          sentStart = true;
                        }

                        // Log content_block_start for debugging (tool_use blocks come here)
                        const block = event.content_block;
                        logger.verbose(
                          `   [Debug] content_block_start: type=${
                            block?.type
                          }, block=${JSON.stringify(block)}`
                        );

                        // Handle text blocks that might contain tool calls (complete blocks, not streaming)
                        currentBlockIndex = event.index ?? currentBlockIndex;
                        blockTextSent = false;

                        if (block?.type === "text" && block.text) {
                          const textContent = block.text;
                          logger.verbose(
                            `   [Debug] content_block_start text block (${textContent.length} chars): ${textContent}`
                          );
                          // Text blocks are handled in content_block_delta
                        }

                        // Handle tool_use blocks - Anthropic's native tool call format
                        if (block?.type === "tool_use") {
                          logger.verbose(
                            `   [Debug] tool_use block started: id=${block.id}, name=${block.name}`
                          );

                          // Store current tool call info for accumulating input
                          currentToolCall = {
                            id: block.id,
                            name: block.name,
                            inputJson: "",
                          };

                          // Send the first OpenAI tool call chunk (id, type, function.name)
                          safeEnqueue(
                            new TextEncoder().encode(
                              createOpenAIToolCallChunk(
                                streamId,
                                openaiBody.model,
                                toolCallIndex,
                                block.id,
                                block.name,
                                undefined,
                                null
                              )
                            )
                          );
                        }
                      }

                      // Handle content_block_stop - reset block tracking and finalize tool calls
                      if (event.type === "content_block_stop") {
                        logger.verbose(
                          `   [Debug] content_block_stop for index ${event.index}`
                        );

                        // If we were building a tool call, send the final arguments chunk
                        if (currentToolCall) {
                          logger.verbose(
                            `   [Debug] Finalizing tool call: ${currentToolCall.name} with args: ${currentToolCall.inputJson}`
                          );

                          // Send the arguments chunk
                          safeEnqueue(
                            new TextEncoder().encode(
                              createOpenAIToolCallChunk(
                                streamId,
                                openaiBody.model,
                                toolCallIndex,
                                undefined,
                                undefined,
                                currentToolCall.inputJson || "{}",
                                null
                              )
                            )
                          );

                          toolCallIndex++;
                          currentToolCall = null;
                        }

                        blockTextSent = false;
                        currentBlockIndex = -1;
                      }

                      // Handle input_json_delta for tool_use blocks
                      if (
                        event.type === "content_block_delta" &&
                        event.delta?.type === "input_json_delta" &&
                        currentToolCall
                      ) {
                        const jsonChunk = event.delta.partial_json || "";
                        currentToolCall.inputJson += jsonChunk;
                        logger.verbose(
                          `   [Debug] input_json_delta: "${jsonChunk}" (total: ${currentToolCall.inputJson.length} chars)`
                        );
                        // Don't send anything yet - accumulate until content_block_stop
                        continue;
                      }

                      // Handle content_block_delta events
                      if (
                        event.type === "content_block_delta" &&
                        event.delta?.text
                      ) {
                        // Skip deltas if we already sent complete text from content_block_start
                        if (blockTextSent) {
                          logger.verbose(
                            `   [Debug] Skipping delta - already sent complete text from content_block_start`
                          );
                          continue;
                        }

                        if (!sentStart) {
                          safeEnqueue(
                            new TextEncoder().encode(
                              createOpenAIStreamStart(
                                streamId,
                                openaiBody.model
                              )
                            )
                          );
                          sentStart = true;
                        }

                        let text = event.delta.text;

                        // Log all text chunks for debugging (especially tool calls)
                        logger.verbose(
                          `   [Debug] content_block_delta chunk (${
                            text.length
                          } chars): ${JSON.stringify(text)}`
                        );

                        // Check if this chunk contains tool call markers (including incorrect formats)
                        const hasToolCallMarkers =
                          /<function_calls/i.test(text) ||
                          /<invoke/i.test(text) ||
                          /<\/invoke>/i.test(text) ||
                          /<\/function_calls>/i.test(text) ||
                          /<search_files/i.test(text) ||
                          /<read_file/i.test(text) ||
                          /<\/search_files>/i.test(text) ||
                          /<\/read_file>/i.test(text) ||
                          /<grep>/i.test(text) ||
                          /<\/grep>/i.test(text);

                        // Also detect potential tool call starts (partial tags like "<search" or "<rea")
                        // This catches tool calls that start mid-chunk, even partial ones
                        const mightStartToolCall =
                          !inToolCall &&
                          (/<sea/i.test(text) || // <search_files
                            /<rea/i.test(text) || // <read_file
                            /<gre/i.test(text) || // <grep
                            /<inv/i.test(text) || // <invoke
                            /<fun/i.test(text)); // <function_calls

                        if (hasToolCallMarkers) {
                          logger.verbose(
                            `   [Debug] Detected tool call markers in chunk!`
                          );
                        }

                        if (mightStartToolCall) {
                          logger.verbose(
                            `   [Debug] Detected potential tool call start in chunk!`
                          );
                        }

                        if (
                          hasToolCallMarkers ||
                          inToolCall ||
                          mightStartToolCall
                        ) {
                          // Start or continue buffering tool calls
                          // If this is a new tool call starting mid-chunk, split it:
                          // send text before the tool call, buffer the tool call part
                          if (
                            !inToolCall &&
                            (mightStartToolCall || hasToolCallMarkers)
                          ) {
                            // Find where the tool call starts in this chunk
                            // Look for < followed by letters (start of a tag)
                            const toolCallStartMatch = text.match(/<[a-z]/i);
                            if (
                              toolCallStartMatch &&
                              toolCallStartMatch.index !== undefined
                            ) {
                              const beforeToolCall = text.substring(
                                0,
                                toolCallStartMatch.index
                              );
                              const toolCallPart = text.substring(
                                toolCallStartMatch.index
                              );

                              // Send the text before the tool call
                              if (beforeToolCall) {
                                safeEnqueue(
                                  new TextEncoder().encode(
                                    createOpenAIStreamChunk(
                                      streamId,
                                      openaiBody.model,
                                      beforeToolCall
                                    )
                                  )
                                );
                                logger.verbose(
                                  `   [Debug] Sent text before tool call: "${beforeToolCall}"`
                                );
                              }

                              // Buffer the tool call part
                              inToolCall = true;
                              toolCallBuffer = toolCallPart;
                              logger.verbose(
                                `   [Debug] Started buffering tool call: "${toolCallPart.substring(
                                  0,
                                  50
                                )}..."`
                              );
                            } else {
                              // Couldn't find start, buffer everything
                              inToolCall = true;
                              toolCallBuffer += text;
                              logger.verbose(
                                `   [Debug] Buffering entire chunk (no split point found)`
                              );
                            }
                          } else if (inToolCall) {
                            // Already in tool call, keep buffering
                            toolCallBuffer += text;
                            logger.verbose(
                              `   [Debug] Continuing to buffer tool call, total: ${toolCallBuffer.length} chars`
                            );
                          } else {
                            // Complete marker found but not in tool call yet, buffer everything
                            inToolCall = true;
                            toolCallBuffer += text;
                          }

                          // Check if we now have a complete tool call
                          // Extract the FIRST complete tool call from the buffer
                          let completeToolCall = "";
                          let remainingBuffer = "";

                          // Find opening tag first
                          const openMatch = toolCallBuffer.match(
                            /<(search_files|read_file|grep|invoke|function_calls)/i
                          );
                          if (
                            openMatch &&
                            openMatch.index !== undefined &&
                            openMatch[1]
                          ) {
                            const tagName = openMatch[1];
                            const closeTag = `</${tagName}>`;

                            // Find the matching closing tag
                            const closeIndex = toolCallBuffer.indexOf(
                              closeTag,
                              openMatch.index
                            );
                            if (closeIndex !== -1) {
                              // Extract the complete tool call (including the closing tag)
                              completeToolCall = toolCallBuffer.substring(
                                openMatch.index,
                                closeIndex + closeTag.length
                              );
                              // Everything after the closing tag is remaining buffer
                              remainingBuffer = toolCallBuffer.substring(
                                closeIndex + closeTag.length
                              );
                            }
                          }

                          if (completeToolCall) {
                            // Parse the XML tool call into structured format
                            const parsedToolCalls =
                              parseXMLToolCalls(completeToolCall);

                            // Update buffer with remaining content
                            toolCallBuffer = remainingBuffer;
                            if (!toolCallBuffer) {
                              inToolCall = false;
                            }

                            if (parsedToolCalls.length > 0) {
                              logger.verbose(
                                `   [Debug] Parsed ${
                                  parsedToolCalls.length
                                } tool call(s) from XML:\n${JSON.stringify(
                                  parsedToolCalls,
                                  null,
                                  2
                                )}`
                              );

                              // Emit OpenAI tool_calls format for each parsed tool call
                              for (const [i, tc] of parsedToolCalls.entries()) {
                                const toolCallId = `call_${Date.now()}_${i}`;

                                // First chunk: id, type, function.name
                                safeEnqueue(
                                  new TextEncoder().encode(
                                    createOpenAIToolCallChunk(
                                      streamId,
                                      openaiBody.model,
                                      toolCallIndex,
                                      toolCallId,
                                      tc.name,
                                      undefined,
                                      null
                                    )
                                  )
                                );

                                // Second chunk: function.arguments (as JSON string)
                                safeEnqueue(
                                  new TextEncoder().encode(
                                    createOpenAIToolCallChunk(
                                      streamId,
                                      openaiBody.model,
                                      toolCallIndex,
                                      undefined,
                                      undefined,
                                      JSON.stringify(tc.arguments),
                                      null
                                    )
                                  )
                                );

                                toolCallIndex++;
                              }
                            } else {
                              // Fallback: couldn't parse, send as text
                              logger.verbose(
                                `   [Debug] Could not parse tool call, sending as text: ${completeToolCall.substring(
                                  0,
                                  100
                                )}...`
                              );
                              safeEnqueue(
                                new TextEncoder().encode(
                                  createOpenAIStreamChunk(
                                    streamId,
                                    openaiBody.model,
                                    completeToolCall
                                  )
                                )
                              );
                            }
                            continue;
                          } else {
                            // Still buffering incomplete tool call
                            // Send heartbeat comment to keep connection alive if we've been buffering for a while
                            const timeSinceLastChunk =
                              Date.now() - lastChunkTime;
                            if (timeSinceLastChunk > HEARTBEAT_INTERVAL) {
                              // Send a comment chunk to keep connection alive
                              safeEnqueue(
                                new TextEncoder().encode(
                                  createOpenAIStreamChunk(
                                    streamId,
                                    openaiBody.model,
                                    "" // Empty content, just keep connection alive
                                  )
                                )
                              );
                              lastChunkTime = Date.now();
                            }
                            continue;
                          }
                        }
                        // Note: We no longer flush the buffer prematurely here.
                        // The buffer is only flushed when we detect a complete tool call
                        // or at the end of the stream.

                        // Translate any remaining tool calls in the text (safety check)
                        if (needsTranslation(text)) {
                          const originalText = text;
                          text = translateToolCalls(text);
                          if (text !== originalText) {
                            logger.verbose(
                              `   [Debug] Translated tool call format in chunk:\n     Original (${
                                originalText.length
                              } chars):\n${originalText
                                .split("\n")
                                .map((l: string) => `       ${l}`)
                                .join("\n")}\n     Translated (${
                                text.length
                              } chars):\n${text
                                .split("\n")
                                .map((l: string) => `       ${l}`)
                                .join("\n")}`
                            );
                          }
                        }

                        safeEnqueue(
                          new TextEncoder().encode(
                            createOpenAIStreamChunk(
                              streamId,
                              openaiBody.model,
                              text
                            )
                          )
                        );
                        lastChunkTime = Date.now();
                      }

                      // Handle message_stop
                      if (event.type === "message_stop") {
                        // Flush any remaining tool call buffer (force flush)
                        if (toolCallBuffer) {
                          const parsedToolCalls =
                            parseXMLToolCalls(toolCallBuffer);
                          if (parsedToolCalls.length > 0) {
                            for (const [i, tc] of parsedToolCalls.entries()) {
                              const toolCallId = `call_${Date.now()}_${i}`;

                              safeEnqueue(
                                new TextEncoder().encode(
                                  createOpenAIToolCallChunk(
                                    streamId,
                                    openaiBody.model,
                                    toolCallIndex,
                                    toolCallId,
                                    tc.name,
                                    undefined,
                                    null
                                  )
                                )
                              );

                              safeEnqueue(
                                new TextEncoder().encode(
                                  createOpenAIToolCallChunk(
                                    streamId,
                                    openaiBody.model,
                                    toolCallIndex,
                                    undefined,
                                    undefined,
                                    JSON.stringify(tc.arguments),
                                    null
                                  )
                                )
                              );

                              toolCallIndex++;
                            }
                            logger.verbose(
                              `   [Debug] Flushed final tool call buffer: ${parsedToolCalls.length} tool calls`
                            );
                          } else {
                            // Couldn't parse, send as text
                            safeEnqueue(
                              new TextEncoder().encode(
                                createOpenAIStreamChunk(
                                  streamId,
                                  openaiBody.model,
                                  toolCallBuffer
                                )
                              )
                            );
                          }
                          toolCallBuffer = "";
                          inToolCall = false;
                        }

                        // Use "tool_calls" finish reason if we emitted any tool calls
                        const finishReason =
                          toolCallIndex > 0 ? "tool_calls" : "stop";

                        safeEnqueue(
                          new TextEncoder().encode(
                            createOpenAIStreamChunk(
                              streamId,
                              openaiBody.model,
                              undefined,
                              finishReason as "stop" | "length"
                            )
                          )
                        );
                        safeEnqueue(
                          new TextEncoder().encode("data: [DONE]\n\n")
                        );
                        logger.verbose(
                          `   [Debug] Sent [DONE] chunk with finish_reason: ${finishReason}`
                        );
                      }
                    } catch (parseError) {
                      // Only log if not cancelled (avoid spam when cancelled)
                      if (!cancelled) {
                        console.log(
                          `   [Debug] Failed to parse event: ${parseError}`
                        );
                      }
                      // Skip unparseable events
                    }
                  }
                }
              } catch (streamError) {
                // Only log/error if not cancelled
                if (!cancelled) {
                  console.error(
                    `   [Error] Stream processing failed: ${streamError}`
                  );
                  try {
                    controller.error(streamError);
                  } catch {
                    // Controller already closed, ignore
                  }
                }
              } finally {
                // Cancel upstream reader if still active
                try {
                  if (!cancelled) {
                    reader.cancel().catch(() => {
                      // Reader might already be cancelled, ignore
                    });
                  }
                } catch {
                  // Reader might already be released, ignore
                }

                // Close controller if not already closed
                try {
                  if (!cancelled) {
                    controller.close();
                  }
                } catch {
                  // Controller already closed, ignore
                }
              }
            },
            cancel(reason) {
              logger.verbose(
                `   [Debug] Stream cancelled by client: ${reason}`
              );
              cancelled = true;
              // Cancel the upstream reader
              reader.cancel(reason).catch(() => {
                // Reader might already be cancelled, ignore
              });
            },
          });

          return new Response(stream, { headers: responseHeaders });
        }

        // Non-streaming response
        if (!response.ok) {
          const error = (await response.json()) as {
            error?: { message?: string; type?: string };
          };
          // Normalize model name in error messages if present
          let errorMessage = error?.error?.message || "Unknown error";
          if (errorMessage.includes("model:")) {
            // Replace any x- prefixed model names in error message with normalized version
            errorMessage = errorMessage.replace(
              /model:\s*x-([^\s,]+)/g,
              (_match, modelName) => `model: ${modelName}`
            );
          }
          return Response.json(
            {
              error: {
                message: errorMessage,
                type: error?.error?.type,
              },
            },
            { status: response.status, headers: responseHeaders }
          );
        }

        const anthropicResponse = await response.json();
        const openaiResponse = anthropicToOpenai(
          anthropicResponse,
          openaiBody.model
        );

        return Response.json(openaiResponse, { headers: responseHeaders });
      } catch (error) {
        console.error("OpenAI request handling error:", error);
        return Response.json(
          { error: { message: String(error), type: "invalid_request_error" } },
          { status: 400 }
        );
      }
    }

    // OpenAI models endpoint (for compatibility)
    if (url.pathname === "/v1/models" && req.method === "GET") {
      return Response.json({
        object: "list",
        data: [
          // Claude 4.5 models (Anthropic format)
          {
            id: "claude-sonnet-4-5",
            object: "model",
            created: 1700000000,
            owned_by: "anthropic",
          },
          {
            id: "claude-opus-4-5",
            object: "model",
            created: 1700000000,
            owned_by: "anthropic",
          },
          {
            id: "claude-haiku-4-5",
            object: "model",
            created: 1700000000,
            owned_by: "anthropic",
          },
          // Cursor format models (will be normalized)
          {
            id: "claude-4.5-opus-high",
            object: "model",
            created: 1700000000,
            owned_by: "anthropic",
          },
          {
            id: "claude-4.5-sonnet-high",
            object: "model",
            created: 1700000000,
            owned_by: "anthropic",
          },
          {
            id: "claude-4.5-haiku",
            object: "model",
            created: 1700000000,
            owned_by: "anthropic",
          },
        ],
      });
    }

    // Analytics endpoints
    if (url.pathname === "/analytics" && req.method === "GET") {
      const period = url.searchParams.get("period") || "day";
      const now = Date.now();
      let since: number;

      switch (period) {
        case "hour":
          since = now - 60 * 60 * 1000;
          break;
        case "day":
          since = now - 24 * 60 * 60 * 1000;
          break;
        case "week":
          since = now - 7 * 24 * 60 * 60 * 1000;
          break;
        case "month":
          since = now - 30 * 24 * 60 * 60 * 1000;
          break;
        case "all":
          since = 0;
          break;
        default:
          since = now - 24 * 60 * 60 * 1000;
      }

      const analytics = getAnalytics(since, now);

      return Response.json({
        period,
        ...analytics,
        estimatedApiKeyCostFormatted: formatCost(analytics.estimatedApiKeyCost),
        estimatedSavingsFormatted: formatCost(analytics.estimatedSavings),
        note: "Costs are estimates. Actual costs may be lower due to prompt caching.",
      });
    }

    if (url.pathname === "/analytics/requests" && req.method === "GET") {
      const limit = parseInt(url.searchParams.get("limit") || "100");
      const requests = getRecentRequests(Math.min(limit, 1000));
      return Response.json({ requests });
    }

    if (url.pathname === "/analytics/reset" && req.method === "POST") {
      const result = resetAnalytics();
      return Response.json({ success: true, ...result });
    }

    // Budget endpoints
    if (url.pathname === "/budget" && req.method === "GET") {
      const settings = getBudgetSettings();
      return Response.json(settings);
    }

    if (url.pathname === "/budget" && req.method === "POST") {
      try {
        const body = (await req.json()) as Partial<BudgetSettings>;
        updateBudgetSettings(body);
        return Response.json({ success: true, settings: getBudgetSettings() });
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 400 });
      }
    }

    return Response.json(
      {
        type: "error",
        error: {
          type: "not_found_error",
          message: `Unknown endpoint: ${url.pathname}`,
        },
      } satisfies AnthropicError,
      { status: 404 }
    );
  },
});

console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                    Claude Code Proxy                          ║
╠═══════════════════════════════════════════════════════════════╣
║  Anthropic-compatible API that routes through Claude Code     ║
║  subscription first, then falls back to direct API.           ║
╚═══════════════════════════════════════════════════════════════╝
`);

// Initialize database
getDb();

console.log(`🚀 Server running at http://localhost:${server.port}`);
console.log(`   Anthropic:  http://localhost:${server.port}/v1/messages`);
console.log(
  `   OpenAI:     http://localhost:${server.port}/v1/chat/completions`
);
console.log(`   Analytics:  http://localhost:${server.port}/analytics`);
console.log(`   Budget:     http://localhost:${server.port}/budget\n`);

await checkCredentials();

if (isOpenAIPassthroughEnabled()) {
  console.log(`✓ OpenAI passthrough enabled → ${config.openaiBaseUrl}`);
} else {
  console.log("⚠️  No OPENAI_API_KEY (non-Claude models will fail)");
}

console.log("\n📋 Usage in Cursor/other clients:");
console.log(`   API Base URL: http://localhost:${server.port}`);
console.log("   API Key: (any value, e.g. 'proxy')");
console.log(`\n📝 Verbose logging enabled → api.log (gitignored)\n`);
