/**
 * Main HTTP server module
 * Handles routing, CORS, IP whitelist, and request dispatch
 */

import { getConfig, CLAUDE_CREDENTIALS_PATH } from "./config";
import { loadCredentials, getValidToken } from "./oauth";
import { isOpenAIPassthroughEnabled } from "./openai-passthrough";
import { handleAnthropicRequest } from "./routes/anthropic";
import { handleOpenAIRequest } from "./routes/openai";
import { handleModelsRequest } from "./routes/models";
import type { AnthropicError } from "./types";

const config = getConfig();

// --- Utility functions (exported for route handlers) ---

export function shouldPassthroughToOpenAI(model: string): boolean {
  if (!isOpenAIPassthroughEnabled()) return false;
  const normalized = model.toLowerCase();
  return !normalized.includes("claude");
}

export function logRequestDetails(req: Request, endpoint: string) {
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

  const allHeaders: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    allHeaders[key] = value;
  });
  console.log(`   All Headers: ${JSON.stringify(allHeaders, null, 2)}`);
}

export function extractHeaders(req: Request): Record<string, string> {
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

export function extractAPIKey(req: Request): string | null {
  // Check Authorization header (Bearer token)
  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const apiKey = authHeader.substring(7).trim();
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

/**
 * Extract the Bearer token from the request (any value, not just sk-ant-*).
 * Cursor sends the "API Key" field as `Authorization: Bearer <key>`.
 */
function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.substring(7).trim() || null;
  }
  // Also check x-api-key header as fallback
  return req.headers.get("x-api-key") || null;
}

/**
 * Validate the proxy secret key.
 * When PROXY_SECRET_KEY is set, all /v1/* requests must include it as a Bearer token.
 * Uses constant-time comparison to prevent timing attacks.
 */
function checkProxySecretKey(req: Request): { allowed: boolean; reason?: string } {
  if (!config.proxySecretKey) {
    // No secret key configured — allow all requests (rely on IP whitelist only)
    return { allowed: true };
  }

  const token = extractBearerToken(req);
  if (!token) {
    return { allowed: false, reason: "Missing API key" };
  }

  // Constant-time comparison to prevent timing attacks
  const expected = config.proxySecretKey;
  if (token.length !== expected.length) {
    return { allowed: false, reason: "Invalid API key" };
  }

  // Bun supports crypto.timingSafeEqual
  const a = new TextEncoder().encode(token);
  const b = new TextEncoder().encode(expected);
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a[i]! ^ b[i]!;
  }

  if (mismatch !== 0) {
    return { allowed: false, reason: "Invalid API key" };
  }

  return { allowed: true };
}

function checkIPWhitelist(req: Request): {
  allowed: boolean;
  ip?: string;
  reason?: string;
} {
  // If no IPs configured (ALLOWED_IPS not set or "*"), skip IP check entirely
  if (config.allowedIPs.length === 0) {
    return { allowed: true, ip: "disabled" };
  }

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

// --- Server ---

export function startServer() {
  const server = Bun.serve({
    port: config.port,
    idleTimeout: 255,

    async fetch(req) {
      const url = new URL(req.url);

      // CORS pre-flight
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

      // Security checks for API endpoints
      if (url.pathname.startsWith("/v1/")) {
        // Layer 1: Proxy secret key (when configured)
        const secretCheck = checkProxySecretKey(req);
        if (!secretCheck.allowed) {
          console.log(`\n🚫 [SECURITY] Blocked request: ${secretCheck.reason}`);
          return Response.json(
            {
              error: {
                type: "authentication_error",
                message: "Unauthorized",
              },
            },
            { status: 401 }
          );
        }

        // Layer 2: IP whitelist (when request comes through Cloudflare tunnel)
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

      // Health check
      if (url.pathname === "/health" || url.pathname === "/") {
        return new Response("OK", { status: 200 });
      }

      // Anthropic-compatible endpoint
      if (url.pathname === "/v1/messages" && req.method === "POST") {
        return handleAnthropicRequest(req);
      }

      // OpenAI-compatible endpoint
      if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
        return handleOpenAIRequest(req);
      }

      // Models endpoint
      if (url.pathname === "/v1/models" && req.method === "GET") {
        return handleModelsRequest();
      }

      // 404
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

  return server;
}

export async function checkCredentials(): Promise<boolean> {
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
