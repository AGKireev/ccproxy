import {
  ANTHROPIC_API_URL,
  CLAUDE_CODE_BETA_HEADERS,
  CLAUDE_CODE_SYSTEM_PROMPT,
  CLAUDE_CODE_EXTRA_INSTRUCTION,
  mergeBetaHeaders,
  getConfig,
} from "./config";
import { getValidToken, clearCachedToken } from "./oauth";
import type { AnthropicRequest, AnthropicError, ContentBlock } from "./types";
import { logger } from "./logger";

type RequestResult =
  | { success: true; response: Response; source: "claude_code" | "api_key" }
  | { success: false; error: string; shouldFallback: boolean };

let rateLimitCache: { resetAt: number } | null = null;

function isRateLimited(): boolean {
  if (!rateLimitCache) return false;
  if (Date.now() >= rateLimitCache.resetAt) {
    rateLimitCache = null;
    return false;
  }
  return true;
}

function cacheRateLimit(resetAt: number) {
  rateLimitCache = { resetAt };
}

function getRateLimitResetMinutes(): number | null {
  if (!rateLimitCache) return null;
  const diff = rateLimitCache.resetAt - Date.now();
  return Math.ceil(diff / 1000 / 60);
}

/**
 * Prepares the request body for Claude Code:
 * 1. Adds required system prompt prefix for Claude Code identification
 * 2. Adds optional extra instruction (headless mode)
 * 3. Strips TTL from cache_control objects
 */
function prepareClaudeCodeBody(body: AnthropicRequest): AnthropicRequest {
  const prepared = { ...body };

  // Remove legacy reasoning_budget (replaced by thinking block)
  if ("reasoning_budget" in prepared) {
    delete prepared.reasoning_budget;
  }

  // Build system prompts array - required Claude Code prompt first
  const systemPrompts: ContentBlock[] = [
    { type: "text", text: CLAUDE_CODE_SYSTEM_PROMPT },
  ];

  // Add extra instruction if configured
  if (CLAUDE_CODE_EXTRA_INSTRUCTION) {
    systemPrompts.push({ type: "text", text: CLAUDE_CODE_EXTRA_INSTRUCTION });
  }

  // Merge with existing system prompt
  if (prepared.system) {
    if (typeof prepared.system === "string") {
      systemPrompts.push({ type: "text", text: prepared.system });
    } else if (Array.isArray(prepared.system)) {
      systemPrompts.push(...prepared.system);
    }
  }

  prepared.system = systemPrompts;

  // Log the final system prompt that will be sent to Claude Code (verbose to file)
  const finalSystemContent = systemPrompts
    .map((block) =>
      block.type === "text" ? block.text : JSON.stringify(block)
    )
    .join("\n\n");
  logger.verbose(
    `\n📋 [Final Claude Code System Prompt] (${finalSystemContent.length} chars):`
  );
  logger.verbose(
    finalSystemContent
      .split("\n")
      .map((l: string) => `   ${l}`)
      .join("\n")
  );

  // Strip TTL from cache_control objects (Claude Code doesn't support it)
  const stripTtl = (content: ContentBlock[] | undefined) => {
    if (!Array.isArray(content)) return;
    for (const item of content) {
      if (item && typeof item === "object" && "cache_control" in item) {
        const cc = item.cache_control as Record<string, unknown>;
        if (cc && "ttl" in cc) {
          delete cc.ttl;
        }
      }
    }
  };

  // Strip TTL from system
  if (Array.isArray(prepared.system)) {
    stripTtl(prepared.system as ContentBlock[]);
  }

  // Strip TTL from messages
  if (Array.isArray(prepared.messages)) {
    for (const message of prepared.messages) {
      if (Array.isArray(message.content)) {
        stripTtl(message.content);
      }
    }
  }

  return prepared;
}

async function makeClaudeCodeRequestWithOAuth(
  endpoint: string,
  body: AnthropicRequest,
  headers: Record<string, string>
): Promise<RequestResult> {
  if (isRateLimited()) {
    const minutes = getRateLimitResetMinutes();
    console.log(
      `Claude Code rate limited (cached), skipping request (resets in ${minutes}m)`
    );
    return {
      success: false,
      error: "Rate limited (cached)",
      shouldFallback: true,
    };
  }

  const token = await getValidToken();
  if (!token) {
    return {
      success: false,
      error: "No valid OAuth token",
      shouldFallback: true,
    };
  }

  try {
    // Prepare the body with required Claude Code modifications
    const preparedBody = prepareClaudeCodeBody(body);

    // Verify reasoning_budget was removed
    if ("reasoning_budget" in preparedBody) {
      logger.verbose(
        `   [WARN] reasoning_budget still present after prepareClaudeCodeBody! Removing now.`
      );
      delete preparedBody.reasoning_budget;
    }

    // Debug: log the model name being sent
    logger.verbose(
      `   [Debug] Sending model to Claude Code: "${preparedBody.model}"`
    );
    logger.verbose(
      `   [Debug] Request body keys: ${Object.keys(preparedBody).join(", ")}`
    );

    // Merge Cursor's beta headers with Claude Code required headers
    // Cursor sends context-management, fine-grained-tool-streaming, effort, etc.
    const mergedBeta = mergeBetaHeaders(headers["anthropic-beta"] || null);
    console.log(
      `   [Debug] Merged beta headers: "${mergedBeta}"`
    );

    const response = await fetch(`${ANTHROPIC_API_URL}${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        "anthropic-beta": mergedBeta,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
        "User-Agent": "claude-code/1.0.85",
      },
      body: JSON.stringify(preparedBody),
    });

    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      const rateLimitReset = response.headers.get("x-ratelimit-reset");

      let resetInfo = "";
      let resetAt: number | null = null;

      if (retryAfter) {
        const seconds = parseInt(retryAfter);
        if (!Number.isNaN(seconds)) {
          resetAt = Date.now() + seconds * 1000;
          const minutes = Math.ceil(seconds / 60);
          resetInfo = ` (resets in ${minutes}m)`;
        }
      } else if (rateLimitReset) {
        const resetTime = new Date(rateLimitReset);
        if (!Number.isNaN(resetTime.getTime())) {
          resetAt = resetTime.getTime();
          const diff = resetAt - Date.now();
          const minutes = Math.ceil(diff / 1000 / 60);
          resetInfo = ` (resets in ${minutes}m)`;
        }
      }

      if (resetAt) {
        cacheRateLimit(resetAt);
      }

      console.log(
        `Claude Code rate limited, will fallback to API key${resetInfo}`
      );
      return { success: false, error: "Rate limited", shouldFallback: true };
    }

    if (response.status === 401) {
      console.log("OAuth token expired or invalid, clearing cache");
      clearCachedToken();
      return {
        success: false,
        error: "OAuth token invalid",
        shouldFallback: true,
      };
    }

    if (response.status === 403) {
      const errorBody = await response.text();
      console.log("Claude Code 403 error:", errorBody);
      return {
        success: false,
        error: "Permission denied",
        shouldFallback: true,
      };
    }

    // Check for API errors in the response body (can happen even with 200 status)
    if (response.status === 400) {
      const errorBody = (await response
        .json()
        .catch(() => ({}))) as { error?: { message?: string } };
      const errorMessage = errorBody?.error?.message || "";

      if (errorMessage.includes("only authorized for use with Claude Code")) {
        console.log("OAuth token not authorized for direct API use");
        return {
          success: false,
          error: "OAuth not authorized for API",
          shouldFallback: true,
        };
      }

      console.log("Claude Code 400 error:", JSON.stringify(errorBody));
      return {
        success: false,
        error: errorMessage || "Bad request",
        shouldFallback: true,
      };
    }

    return { success: true, response, source: "claude_code" };
  } catch (error) {
    console.error("Claude Code OAuth request failed:", error);
    return { success: false, error: String(error), shouldFallback: true };
  }
}

async function makeClaudeCodeRequest(
  endpoint: string,
  body: AnthropicRequest,
  headers: Record<string, string>
): Promise<RequestResult> {
  return makeClaudeCodeRequestWithOAuth(endpoint, body, headers);
}

async function makeDirectApiRequest(
  endpoint: string,
  body: AnthropicRequest,
  headers: Record<string, string>,
  apiKey: string
): Promise<RequestResult> {
  try {
    const preparedBody = { ...body };
    // Remove legacy reasoning_budget (replaced by thinking block)
    if ("reasoning_budget" in preparedBody) {
      delete preparedBody.reasoning_budget;
    }

    const response = await fetch(`${ANTHROPIC_API_URL}${endpoint}`, {
      method: "POST",
      headers: {
        ...headers,
        "x-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(preparedBody),
    });

    return { success: true, response, source: "api_key" };
  } catch (error) {
    console.error("Direct API request failed:", error);
    return { success: false, error: String(error), shouldFallback: false };
  }
}

export async function proxyRequest(
  endpoint: string,
  body: AnthropicRequest,
  headers: Record<string, string>,
  userAPIKey?: string
): Promise<Response> {
  const config = getConfig();

  // Always try Claude Code first (if enabled), then fall back to API key
  if (config.claudeCodeFirst) {
    const claudeResult = await makeClaudeCodeRequest(endpoint, body, headers);

    if (claudeResult.success) {
      console.log(`✓ Request served via Claude Code`);
      return claudeResult.response;
    }

    if (!claudeResult.shouldFallback) {
      return new Response(
        JSON.stringify({
          type: "error",
          error: {
            type: "api_error",
            message: claudeResult.error,
          },
        } satisfies AnthropicError),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    // Fallback to API key (Claude Code failed)
    // Prefer user-provided API key, then fall back to config API key
    const fallbackApiKey = userAPIKey || config.anthropicApiKey;
    if (fallbackApiKey) {
      const apiKeySource = userAPIKey ? "user-provided" : "configured";
      console.log(
        `↓ Falling back to direct Anthropic API (${apiKeySource} key)`
      );
      const apiResult = await makeDirectApiRequest(
        endpoint,
        body,
        headers,
        fallbackApiKey
      );

      if (apiResult.success) {
        console.log(
          `✓ Request served via direct Anthropic API (${apiKeySource} key)`
        );
        return apiResult.response;
      }

      return new Response(
        JSON.stringify({
          type: "error",
          error: { type: "api_error", message: apiResult.error },
        } satisfies AnthropicError),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    // No API key available and Claude Code failed
    return new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "authentication_error",
          message: "Claude Code request failed (no fallback API key available)",
        },
      } satisfies AnthropicError),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  if (config.anthropicApiKey) {
    const apiResult = await makeDirectApiRequest(
      endpoint,
      body,
      headers,
      config.anthropicApiKey
    );
    if (apiResult.success) {
      return apiResult.response;
    }

    return new Response(
      JSON.stringify({
        type: "error",
        error: { type: "api_error", message: apiResult.error },
      } satisfies AnthropicError),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({
      type: "error",
      error: {
        type: "authentication_error",
        message: "No authentication method available",
      },
    } satisfies AnthropicError),
    { status: 401, headers: { "Content-Type": "application/json" } }
  );
}
