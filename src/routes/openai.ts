/**
 * /v1/chat/completions endpoint handler
 * Converts OpenAI chat completion format to Anthropic and proxies the request
 */

import {
  openaiToAnthropic,
  normalizeModelName,
  injectCompaction,
  type OpenAIChatRequest,
} from "../openai-adapter";
import { proxyRequest } from "../anthropic-client";
import { countTokens } from "../token-counter";
import {
  isOpenAIPassthroughEnabled,
  proxyOpenAIRequest,
} from "../openai-passthrough";
import { createAnthropicToOpenAIStream, handleNonStreamingResponse } from "../streaming";
import {
  logRequestDetails,
  extractHeaders,
  extractAPIKey,
  shouldPassthroughToOpenAI,
} from "../server";
import { logger } from "../logger";
import { getConfig } from "../config";

export async function handleOpenAIRequest(req: Request): Promise<Response> {
  try {
    logRequestDetails(req, "OpenAI /v1/chat/completions");
    const openaiBody = (await req.json()) as OpenAIChatRequest & { input?: unknown[] };

    // Normalize OpenAI Responses API format ("input") to Chat Completions format ("messages")
    if (!openaiBody.messages && Array.isArray(openaiBody.input)) {
      openaiBody.messages = openaiBody.input as OpenAIChatRequest["messages"];
      delete openaiBody.input;
    }

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

    // Log all messages (verbose to file)
    if (openaiBody.messages && openaiBody.messages.length > 0) {
      logger.verbose(`\n📝 [Cursor Messages]:`);
      openaiBody.messages.forEach((msg, idx) => {
        const content =
          msg.content == null
            ? ""
            : typeof msg.content === "string"
              ? msg.content
              : JSON.stringify(msg.content);

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

    // Inject server-side compaction for Opus 4.6
    const normalized = normalizeModelName(openaiBody.model);
    const compactionResult = injectCompaction(anthropicBody, normalized.minorVersion);

    const headers = extractHeaders(req);

    // Append compaction beta header if needed
    if (compactionResult.betaHeader) {
      const existing = headers["anthropic-beta"] || "";
      headers["anthropic-beta"] = existing
        ? `${existing},${compactionResult.betaHeader}`
        : compactionResult.betaHeader;
    }

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

    // Log the system prompt (verbose to file)
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

    // Log prepared request summary
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

    // Transparent passthrough — Cursor handles its own context management
    const managedBody = anthropicBody;
    const config = getConfig();
    const estimate = countTokens(anthropicBody);
    const originalTokenCount = estimate.total;
    const pctOfLimit = ((originalTokenCount / 200000) * 100).toFixed(1);
    const pctOfTrigger = ((originalTokenCount / config.compactionTriggerTokens) * 100).toFixed(1);
    console.log(`📊 [Tokens] ~${Math.round(originalTokenCount / 1000)}K estimated | ${pctOfLimit}% of 200K limit | ${pctOfTrigger}% of ${Math.round(config.compactionTriggerTokens / 1000)}K compaction trigger`);
    if (originalTokenCount > config.compactionTriggerTokens * 0.8) {
      console.log(`⚠️  [Tokens] Approaching compaction threshold! API will compact if real tokens ≥ ${Math.round(config.compactionTriggerTokens / 1000)}K`);
    }

    const proxyStartTime = Date.now();
    const response = await proxyRequest(
      "/v1/messages",
      managedBody,
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
    if (managedBody.stream && response.ok) {
      responseHeaders.set("Content-Type", "text/event-stream");
      responseHeaders.set("Cache-Control", "no-cache");
      responseHeaders.set("Connection", "keep-alive");
      responseHeaders.set("X-Accel-Buffering", "no");

      const streamId = Date.now().toString();

      logger.verbose(
        `   [Debug] Stream reader created: ${response.body !== null}`
      );

      if (!response.body) {
        return Response.json(
          { error: { message: "No response body" } },
          { status: 500 }
        );
      }

      const stream = createAnthropicToOpenAIStream(response, {
        streamId,
        openaiModel: openaiBody.model,
        anthropicModel: managedBody.model,
        originalTokenCount,
        proxyStartTime,
      });

      return new Response(stream, { headers: responseHeaders });
    }

    // Non-streaming response
    return handleNonStreamingResponse(
      response,
      openaiBody.model,
      originalTokenCount,
      responseHeaders
    );
  } catch (error) {
    console.error("OpenAI request handling error:", error);
    return Response.json(
      { error: { message: String(error), type: "invalid_request_error" } },
      { status: 400 }
    );
  }
}
