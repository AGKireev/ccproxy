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
import { loadOpenAICredentials, getValidOpenAIToken, manualOpenAILogin, getAuthFileLocations, resetCodexAvailabilityCache } from "./openai-oauth";

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

      // --- OpenAI auth endpoints (no proxy auth required) ---

      // Login instructions
      if (url.pathname === "/auth/openai/login" && req.method === "GET") {
        const locations = getAuthFileLocations();
        return new Response(
          `<html><body style="font-family: system-ui; max-width: 700px; margin: 40px auto; padding: 0 20px;">
<h1>OpenAI Codex Login</h1>
<p>CCProxy reads credentials from the <strong>official Codex CLI</strong>. To authenticate:</p>

<h2>Step 1: Install OpenAI Codex CLI</h2>
<pre style="background:#f5f5f5;padding:12px;border-radius:6px;">npm install -g @openai/codex</pre>

<h2>Step 2: Login</h2>
<pre style="background:#f5f5f5;padding:12px;border-radius:6px;">codex login</pre>
<p>This opens your browser, you sign in with your ChatGPT account, and tokens are saved automatically.</p>

<h2>Step 3: Restart CCProxy</h2>
<p>CCProxy will automatically pick up the credentials from:</p>
<ul>${locations.map(l => `<li><code>${l}</code></li>`).join("\n")}</ul>

<h2>Alternative: Manual Token Input</h2>
<p>POST to <code>/auth/openai/manual</code> with:</p>
<pre style="background:#f5f5f5;padding:12px;border-radius:6px;">curl -X POST http://localhost:${config.port}/auth/openai/manual \\
  -H "Content-Type: application/json" \\
  -d '{"access_token": "...", "refresh_token": "...", "account_id": "..."}'</pre>

<h2>Current Status</h2>
<p>Check: <a href="/auth/openai/status">/auth/openai/status</a></p>
</body></html>`,
          { headers: { "Content-Type": "text/html" } }
        );
      }

      // Manual token login
      if (url.pathname === "/auth/openai/manual" && req.method === "POST") {
        try {
          const body = await req.json() as {
            access_token: string;
            refresh_token: string;
            account_id?: string;
            id_token?: string;
          };

          if (!body.access_token || !body.refresh_token) {
            return Response.json(
              { error: "access_token and refresh_token are required" },
              { status: 400 }
            );
          }

          const creds = await manualOpenAILogin(
            body.access_token,
            body.refresh_token,
            body.account_id,
            body.id_token
          );

          if (creds) {
            resetCodexAvailabilityCache();
            return Response.json({
              status: "ok",
              message: "OpenAI credentials saved — GPT models are now available",
              account_id: creds.accountId,
            });
          }

          return Response.json(
            { error: "Failed to save credentials. Could not determine account ID. Provide account_id explicitly." },
            { status: 400 }
          );
        } catch (error) {
          return Response.json(
            { error: `Invalid request: ${error}` },
            { status: 400 }
          );
        }
      }

      // Check OpenAI auth status
      if (url.pathname === "/auth/openai/status" && req.method === "GET") {
        const token = await getValidOpenAIToken();
        if (token) {
          const expiresIn = Math.round((token.expiresAt - Date.now()) / 1000 / 60);
          return Response.json({
            authenticated: true,
            account_id: token.accountId,
            expires_in_minutes: expiresIn,
          });
        }
        return Response.json({
          authenticated: false,
          message: "Not authenticated. Run 'codex login' or POST to /auth/openai/manual",
          auth_file_locations: getAuthFileLocations(),
        });
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
  let hasAnyCreds = false;

  // --- Check Claude Code credentials ---
  const creds = await loadCredentials();
  if (!creds?.claudeAiOauth) {
    console.log("\n⚠️  No Claude Code credentials found.");
    console.log(`   Expected at: ${CLAUDE_CREDENTIALS_PATH}`);
    console.log("   Run 'claude /login' to authenticate.\n");

    if (config.anthropicApiKey) {
      console.log("✓ Fallback ANTHROPIC_API_KEY is configured");
      hasAnyCreds = true;
    } else {
      console.log("⚠️  No ANTHROPIC_API_KEY fallback configured either.");
    }
  } else {
    console.log("✓ Claude Code credentials loaded");
    hasAnyCreds = true;

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
  }

  // --- Check OpenAI Codex credentials (auto-detected) ---
  const openaiCreds = await loadOpenAICredentials();
  if (openaiCreds) {
    hasAnyCreds = true;
    console.log("✓ OpenAI Codex credentials found — GPT models will use your ChatGPT subscription");
    const openaiToken = await getValidOpenAIToken();
    if (openaiToken) {
      const expiresIn = Math.round((openaiToken.expiresAt - Date.now()) / 1000 / 60);
      console.log(`  OpenAI token expires in ${expiresIn} minutes`);
      console.log(`  Account ID: ${openaiToken.accountId}`);
    }
  } else {
    console.log("\nℹ️  No OpenAI Codex credentials found (GPT models won't work until you authenticate)");
    console.log("   To enable GPT models, run: codex login");
    console.log("   Or set OPENAI_API_KEY in .env for API key access");

    if (config.openaiApiKey) {
      console.log("✓ OPENAI_API_KEY configured — GPT models will use API key");
      hasAnyCreds = true;
    }
  }

  return hasAnyCreds;
}
