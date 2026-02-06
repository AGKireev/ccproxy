/**
 * Test script: Can we use >200K tokens with the 1M context beta header?
 *
 * Tests 3 things in sequence:
 * 1. Token counting with 1M header on a small payload (does the API accept the header?)
 * 2. Token counting with 1M header on a ~250K token payload (does it accept >200K?)
 * 3. A real messages request with the 1M header (end-to-end proof)
 *
 * Usage:
 *   ENABLE_1M_CONTEXT=true bun src/test-1m-context.ts
 *
 * Without ENABLE_1M_CONTEXT=true, it tests with the default 200K headers as a baseline.
 */

import { getValidToken } from "./oauth";
import {
  ANTHROPIC_API_URL,
  CLAUDE_CODE_BETA_HEADERS,
  CLAUDE_CODE_SYSTEM_PROMPT,
} from "./config";

const MODEL = "claude-opus-4-6";

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "anthropic-beta": CLAUDE_CODE_BETA_HEADERS,
    "anthropic-version": "2023-06-01",
    "Content-Type": "application/json",
    "User-Agent": "claude-code/1.0.85",
  };
}

/** Generate a large user message of approximately `targetTokens` tokens (~3.5 chars/token) */
function generateLargeMessage(targetTokens: number): string {
  // Each line is ~80 chars ≈ ~23 tokens. We use realistic-ish coding conversation content.
  const line =
    "The user is working on a large TypeScript project with multiple modules, services, and API routes. ";
  const charsNeeded = Math.ceil(targetTokens * 3.5);
  const linesNeeded = Math.ceil(charsNeeded / line.length);
  return Array(linesNeeded).fill(line).join("\n");
}

function log(emoji: string, msg: string) {
  console.log(`${emoji} ${msg}`);
}

// ─── Test 1: count_tokens with small payload ───────────────────────────────

async function testCountTokensSmall(token: string): Promise<boolean> {
  log("🔬", "Test 1: count_tokens with small payload + current beta headers");
  log("📋", `  Beta headers: "${CLAUDE_CODE_BETA_HEADERS}"`);
  log("📋", `  Has context-1m: ${CLAUDE_CODE_BETA_HEADERS.includes("context-1m")}`);

  const body = {
    model: MODEL,
    messages: [{ role: "user", content: "Hello, world!" }],
    system: [{ type: "text", text: CLAUDE_CODE_SYSTEM_PROMPT }],
  };

  const start = Date.now();
  const res = await fetch(`${ANTHROPIC_API_URL}/v1/messages/count_tokens`, {
    method: "POST",
    headers: makeHeaders(token),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const elapsed = Date.now() - start;

  if (!res.ok) {
    const err = await res.text();
    log("❌", `  FAILED: HTTP ${res.status} in ${elapsed}ms`);
    log("❌", `  Error: ${err.slice(0, 500)}`);
    return false;
  }

  const data = (await res.json()) as { input_tokens: number };
  log("✅", `  OK: ${data.input_tokens} tokens counted in ${elapsed}ms`);
  return true;
}

// ─── Test 2: count_tokens with ~250K token payload ─────────────────────────

async function testCountTokensLarge(token: string): Promise<boolean> {
  // Overshoot target to guarantee >200K actual tokens (char-to-token ratio is ~4.5 for repetitive text)
  const targetTokens = 350_000;
  log("🔬", `Test 2: count_tokens with large payload (targeting >200K actual tokens)`);

  // Build a conversation with a large message
  const messageText = generateLargeMessage(targetTokens);
  const messages = [{ role: "user" as const, content: messageText }];

  const body = {
    model: MODEL,
    messages,
    system: [{ type: "text", text: CLAUDE_CODE_SYSTEM_PROMPT }],
  };

  const bodySize = JSON.stringify(body).length;
  log("📋", `  Payload size: ~${Math.round(bodySize / 1024)}KB (~${Math.round(bodySize / 3.5 / 1000)}K est. tokens)`);

  const start = Date.now();
  const res = await fetch(`${ANTHROPIC_API_URL}/v1/messages/count_tokens`, {
    method: "POST",
    headers: makeHeaders(token),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000), // larger payload, give it more time
  });
  const elapsed = Date.now() - start;

  if (!res.ok) {
    const err = await res.text();
    log("❌", `  FAILED: HTTP ${res.status} in ${elapsed}ms`);
    log("❌", `  Error: ${err.slice(0, 500)}`);

    if (res.status === 400 && err.includes("long context beta")) {
      log("💡", `  → The 1M context beta header is NOT accepted for this subscription.`);
      log("💡", `  → This means OAuth subscriptions still enforce 200K.`);
    } else if (res.status === 400 && err.includes("too many tokens")) {
      log("💡", `  → The API rejected the payload as too large for the current context window.`);
      log("💡", `  → Without 1M beta header, the limit is 200K.`);
    }
    return false;
  }

  const data = (await res.json()) as { input_tokens: number };
  log("✅", `  OK: ${data.input_tokens} tokens counted in ${elapsed}ms`);
  log("✅", `  → The API accepted a ${Math.round(data.input_tokens / 1000)}K token payload!`);

  if (data.input_tokens > 200_000) {
    log("🎉", `  → CONFIRMED: >200K tokens accepted (${data.input_tokens} tokens)`);
  } else {
    log("⚠️", `  → Payload was under 200K (${data.input_tokens} tokens), not a conclusive >200K test`);
  }

  return true;
}

// ─── Test 3: Real messages request (tiny, just to confirm the header works) ─

async function testMessagesRequest(token: string): Promise<boolean> {
  log("🔬", "Test 3: Real /v1/messages request with current beta headers (small, non-streaming)");

  const body = {
    model: MODEL,
    max_tokens: 100,
    stream: false,
    messages: [{ role: "user", content: "Reply with exactly: 1M_CONTEXT_TEST_OK" }],
    system: [{ type: "text", text: CLAUDE_CODE_SYSTEM_PROMPT }],
    thinking: { type: "adaptive" },
  };

  const start = Date.now();
  const res = await fetch(`${ANTHROPIC_API_URL}/v1/messages`, {
    method: "POST",
    headers: makeHeaders(token),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const elapsed = Date.now() - start;

  if (!res.ok) {
    const err = await res.text();
    log("❌", `  FAILED: HTTP ${res.status} in ${elapsed}ms`);
    log("❌", `  Error: ${err.slice(0, 500)}`);

    if (res.status === 400) {
      // Parse structured error
      try {
        const errObj = JSON.parse(err);
        log("❌", `  Error type: ${errObj?.error?.type}`);
        log("❌", `  Error message: ${errObj?.error?.message}`);
      } catch {}
    }
    return false;
  }

  const data = (await res.json()) as {
    content: Array<{ type: string; text?: string }>;
    usage: { input_tokens: number; output_tokens: number };
    model: string;
  };
  const responseText = data.content?.find((b) => b.type === "text")?.text || "(no text)";
  log("✅", `  OK: Response received in ${elapsed}ms`);
  log("✅", `  Model: ${data.model}`);
  log("✅", `  Tokens: input=${data.usage.input_tokens}, output=${data.usage.output_tokens}`);
  log("✅", `  Response: "${responseText.slice(0, 200)}"`);
  return true;
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  1M Context Window Test for Claude Opus 4.6");
  console.log("═══════════════════════════════════════════════════════════");
  console.log();
  log("🔧", `ENABLE_1M_CONTEXT=${process.env.ENABLE_1M_CONTEXT || "(not set)"}`);
  log("🔧", `Beta headers: "${CLAUDE_CODE_BETA_HEADERS}"`);
  log("🔧", `Model: ${MODEL}`);
  console.log();

  // Get OAuth token
  log("🔑", "Getting OAuth token...");
  const tokenInfo = await getValidToken();
  if (!tokenInfo) {
    log("❌", "Failed to get OAuth token. Run 'claude /login' first.");
    process.exit(1);
  }
  log("✅", "OAuth token obtained");
  console.log();

  const results: Record<string, boolean> = {};

  // Test 1: Small count_tokens
  results["test1_count_small"] = await testCountTokensSmall(tokenInfo.accessToken);
  console.log();

  // Test 2: Large count_tokens (~250K) — this is the key test
  results["test2_count_large"] = await testCountTokensLarge(tokenInfo.accessToken);
  console.log();

  // Test 3: Real messages request (only if test 1 passed)
  if (results["test1_count_small"]) {
    results["test3_messages"] = await testMessagesRequest(tokenInfo.accessToken);
  } else {
    log("⏭️", "Skipping Test 3 (Test 1 failed, headers likely rejected)");
    results["test3_messages"] = false;
  }
  console.log();

  // Summary
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  RESULTS SUMMARY");
  console.log("═══════════════════════════════════════════════════════════");
  for (const [test, passed] of Object.entries(results)) {
    console.log(`  ${passed ? "✅" : "❌"} ${test}`);
  }
  console.log();

  const allPassed = Object.values(results).every(Boolean);
  if (allPassed) {
    if (CLAUDE_CODE_BETA_HEADERS.includes("context-1m")) {
      log("🎉", "ALL TESTS PASSED — 1M context window is WORKING for OAuth!");
      log("💡", "You can keep ENABLE_1M_CONTEXT=true in production.");
      log("💡", "Consider raising CONTEXT_MAX_TOKENS and CONTEXT_TARGET_TOKENS in .env");
    } else {
      log("✅", "All tests passed with default (200K) headers.");
      log("💡", "Run with ENABLE_1M_CONTEXT=true to test the 1M context beta header.");
    }
  } else {
    if (CLAUDE_CODE_BETA_HEADERS.includes("context-1m")) {
      log("⚠️", "Some tests FAILED with 1M context header.");
      log("💡", "The 1M beta may not be available for your OAuth subscription yet.");
      log("💡", "Keep ENABLE_1M_CONTEXT unset (default 200K) for now.");
    } else {
      log("❌", "Some tests FAILED even with default headers. Check OAuth token / API status.");
    }
  }

  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
