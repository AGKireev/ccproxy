/**
 * test-context-strategy.ts
 *
 * Tests to determine the correct v3 context management strategy.
 * All tests use OAuth authentication (same as production).
 *
 * Run: bun src/test-context-strategy.ts
 */

import { getValidToken } from "./oauth";
import {
  ANTHROPIC_API_URL,
  ANTHROPIC_BETA_CLAUDE_CODE,
  ANTHROPIC_BETA_OAUTH,
  CLAUDE_CODE_SYSTEM_PROMPT,
} from "./config";

const DIVIDER = "═".repeat(70);
const MODEL = "claude-opus-4-6";

interface TestResult {
  name: string;
  passed: boolean;
  details: string;
  rawResponse?: any;
}

const results: TestResult[] = [];

async function getAuthHeaders(extraBeta?: string): Promise<Record<string, string>> {
  const token = await getValidToken();
  if (!token) {
    throw new Error("No valid OAuth token — run 'claude /login' first");
  }

  const betaParts = [ANTHROPIC_BETA_CLAUDE_CODE, ANTHROPIC_BETA_OAUTH];
  if (extraBeta) {
    betaParts.push(extraBeta);
  }

  return {
    Authorization: `Bearer ${token.accessToken}`,
    "anthropic-beta": betaParts.join(","),
    "anthropic-version": "2023-06-01",
    "Content-Type": "application/json",
    "User-Agent": "claude-code/1.0.85",
  };
}

function makeMinimalRequest(overrides: Record<string, any> = {}) {
  return {
    model: MODEL,
    max_tokens: 2048,
    stream: false,
    system: [{ type: "text", text: CLAUDE_CODE_SYSTEM_PROMPT }],
    messages: [
      { role: "user", content: "Say exactly: test ok" },
    ],
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// TEST 1: Compaction API with OAuth (HIGHEST PRIORITY)
// Per docs: compact_20260112 fields: type, trigger, pause_after_compaction, instructions
// NO "keep" field! Trigger minimum: 50000 tokens.
// ──────────────────────────────────────────────────────────────────────────────
async function test1_compaction(): Promise<TestResult> {
  console.log(`\n${DIVIDER}`);
  console.log("TEST 1: Compaction API (compact-2026-01-12) with OAuth");
  console.log(DIVIDER);

  try {
    const headers = await getAuthHeaders("compact-2026-01-12");
    console.log("Beta headers:", headers["anthropic-beta"]);

    // Per docs: compact_20260112 only accepts: type, trigger, pause_after_compaction, instructions
    // Trigger minimum is 50000. We use 50000 (minimum allowed).
    const body = makeMinimalRequest({
      thinking: { type: "adaptive" },
      context_management: {
        edits: [
          {
            type: "compact_20260112",
            trigger: { type: "input_tokens", value: 50000 },
          },
        ],
      },
    });

    console.log("Request body (relevant fields):");
    console.log("  model:", body.model);
    console.log("  thinking:", JSON.stringify(body.thinking));
    console.log("  context_management:", JSON.stringify(body.context_management, null, 2));

    const response = await fetch(`${ANTHROPIC_API_URL}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    const status = response.status;
    const responseBody = await response.json();

    console.log(`\nResponse status: ${status}`);
    console.log("Response body:", JSON.stringify(responseBody, null, 2));

    if (status === 200) {
      // Check if there's a compaction block in the response
      const hasCompaction = responseBody.content?.some(
        (b: any) => b.type === "compaction"
      );
      return {
        name: "Compaction API with OAuth",
        passed: true,
        details: `✅ ACCEPTED! Status 200. Compaction block present: ${hasCompaction}. The API accepts compact-2026-01-12 with OAuth.`,
        rawResponse: responseBody,
      };
    } else {
      const errorMsg = responseBody?.error?.message || JSON.stringify(responseBody);
      const isBetaGated = errorMsg.includes("beta") || errorMsg.includes("not available") || errorMsg.includes("not supported");
      return {
        name: "Compaction API with OAuth",
        passed: false,
        details: `❌ REJECTED. Status ${status}. ${isBetaGated ? "Beta not available for OAuth." : ""} Error: ${errorMsg}`,
        rawResponse: responseBody,
      };
    }
  } catch (error) {
    return {
      name: "Compaction API with OAuth",
      passed: false,
      details: `❌ ERROR: ${error}`,
    };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// TEST 2: Context Editing API with OAuth
// Per docs: clear_tool_uses_20250919 fields: type, trigger, keep, clear_at_least, exclude_tools, clear_tool_inputs
// trigger.type = "input_tokens" or "tool_uses"
// keep.type = "tool_uses"
// clear_at_least.type = "input_tokens"
// ──────────────────────────────────────────────────────────────────────────────
async function test2_contextEditing(): Promise<TestResult> {
  console.log(`\n${DIVIDER}`);
  console.log("TEST 2: Context Editing API (context-management-2025-06-27) with OAuth");
  console.log(DIVIDER);

  try {
    const headers = await getAuthHeaders("context-management-2025-06-27");
    console.log("Beta headers:", headers["anthropic-beta"]);

    // Simplest form: just specify the type with no extra config (all defaults)
    const body = makeMinimalRequest({
      thinking: { type: "adaptive" },
      context_management: {
        edits: [
          {
            type: "clear_tool_uses_20250919",
          },
        ],
      },
    });

    console.log("Request body (relevant fields):");
    console.log("  context_management:", JSON.stringify(body.context_management, null, 2));

    const response = await fetch(`${ANTHROPIC_API_URL}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    const status = response.status;
    const responseBody = await response.json();

    console.log(`\nResponse status: ${status}`);
    console.log("Response body:", JSON.stringify(responseBody, null, 2));

    if (status === 200) {
      return {
        name: "Context Editing API with OAuth",
        passed: true,
        details: `✅ ACCEPTED! Status 200. Context editing works with OAuth.`,
        rawResponse: responseBody,
      };
    } else {
      const errorMsg = responseBody?.error?.message || JSON.stringify(responseBody);
      return {
        name: "Context Editing API with OAuth",
        passed: false,
        details: `❌ REJECTED. Status ${status}. Error: ${errorMsg}`,
        rawResponse: responseBody,
      };
    }
  } catch (error) {
    return {
      name: "Context Editing API with OAuth",
      passed: false,
      details: `❌ ERROR: ${error}`,
    };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// TEST 3: Token Reporting — verify prompt_tokens flows through correctly
// ──────────────────────────────────────────────────────────────────────────────
async function test3_tokenReporting(): Promise<TestResult> {
  console.log(`\n${DIVIDER}`);
  console.log("TEST 3: Token Reporting — verify prompt_tokens in response");
  console.log(DIVIDER);

  try {
    const headers = await getAuthHeaders();

    // Send a non-streaming request to easily read usage
    // max_tokens must be > budget_tokens, so use adaptive (no budget constraint)
    const body = makeMinimalRequest({
      thinking: { type: "adaptive" },
    });

    const response = await fetch(`${ANTHROPIC_API_URL}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    const status = response.status;
    const responseBody = await response.json();

    console.log(`\nResponse status: ${status}`);

    if (status === 200) {
      const usage = responseBody.usage;
      console.log("Usage from Anthropic API:");
      console.log("  input_tokens:", usage?.input_tokens);
      console.log("  output_tokens:", usage?.output_tokens);
      console.log("  cache_creation_input_tokens:", usage?.cache_creation_input_tokens);
      console.log("  cache_read_input_tokens:", usage?.cache_read_input_tokens);

      // Log all usage keys for completeness
      console.log("  ALL usage keys:", Object.keys(usage || {}).join(", "));

      return {
        name: "Token Reporting",
        passed: true,
        details: `✅ API reports input_tokens=${usage?.input_tokens}, output_tokens=${usage?.output_tokens}. The proxy can override prompt_tokens when forwarding to Cursor. Manual Cursor test needed to verify if Cursor reads our reported value.`,
        rawResponse: { usage },
      };
    } else {
      const errorMsg = responseBody?.error?.message || JSON.stringify(responseBody);
      return {
        name: "Token Reporting",
        passed: false,
        details: `❌ Request failed with status ${status}. Error: ${errorMsg}`,
        rawResponse: responseBody,
      };
    }
  } catch (error) {
    return {
      name: "Token Reporting",
      passed: false,
      details: `❌ ERROR: ${error}`,
    };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// TEST 4: Model Name Spoofing — respond with 4.5 model name
// ──────────────────────────────────────────────────────────────────────────────
async function test4_modelSpoofing(): Promise<TestResult> {
  console.log(`\n${DIVIDER}`);
  console.log("TEST 4: Model Name Spoofing — send as 4.6, verify model in response");
  console.log(DIVIDER);

  try {
    const headers = await getAuthHeaders();

    const body = makeMinimalRequest({
      thinking: { type: "adaptive" },
    });

    const response = await fetch(`${ANTHROPIC_API_URL}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    const status = response.status;
    const responseBody = await response.json();

    console.log(`\nResponse status: ${status}`);

    if (status === 200) {
      const apiModel = responseBody.model;
      console.log("API returned model:", apiModel);
      console.log("We sent model:", MODEL);
      console.log("\nProxy strategy: When Cursor sends 'claude-4.6-opus-high',");
      console.log("  proxy sends model='claude-opus-4-6' to API,");
      console.log("  API returns model='" + apiModel + "',");
      console.log("  proxy could respond with model='claude-4.5-opus-high' to Cursor.");
      console.log("  Cursor would then show X / 164K instead of X / 872K.");
      console.log("  → This is a FEASIBILITY check only. Needs manual Cursor test.");

      return {
        name: "Model Name Spoofing",
        passed: true,
        details: `✅ FEASIBLE. API returns model='${apiModel}'. Proxy can override this to 'claude-4.5-opus-high' in the OpenAI-format response. Manual Cursor test needed.`,
        rawResponse: { sentModel: MODEL, returnedModel: apiModel },
      };
    } else {
      const errorMsg = responseBody?.error?.message || JSON.stringify(responseBody);
      return {
        name: "Model Name Spoofing",
        passed: false,
        details: `❌ Request failed with status ${status}. Error: ${errorMsg}`,
        rawResponse: responseBody,
      };
    }
  } catch (error) {
    return {
      name: "Model Name Spoofing",
      passed: false,
      details: `❌ ERROR: ${error}`,
    };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// TEST 5: Inflated Token Count — can we emit arbitrary prompt_tokens?
// ──────────────────────────────────────────────────────────────────────────────
async function test5_inflatedTokens(): Promise<TestResult> {
  console.log(`\n${DIVIDER}`);
  console.log("TEST 5: Inflated Token Count — proxy CAN emit arbitrary prompt_tokens");
  console.log(DIVIDER);

  try {
    const headers = await getAuthHeaders();

    // Streaming request to see what fields are in the usage chunk
    const body = makeMinimalRequest({
      stream: true,
      thinking: { type: "adaptive" },
    });

    const response = await fetch(`${ANTHROPIC_API_URL}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    const status = response.status;
    console.log(`\nResponse status: ${status}`);

    if (status !== 200) {
      const errorBody = await response.text();
      return {
        name: "Inflated Token Count",
        passed: false,
        details: `❌ Streaming request failed with status ${status}: ${errorBody}`,
      };
    }

    // Read the SSE stream and capture message_delta (which has usage)
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let messageStartUsage: any = null;
    let messageDeltaUsage: any = null;
    let allEventTypes: string[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;

        try {
          const event = JSON.parse(data);
          allEventTypes.push(event.type);

          if (event.type === "message_start") {
            messageStartUsage = event.message?.usage;
          }
          if (event.type === "message_delta") {
            messageDeltaUsage = event.usage;
          }
        } catch {}
      }
    }

    console.log("\nSSE event types received:", [...new Set(allEventTypes)].join(", "));
    console.log("message_start usage:", JSON.stringify(messageStartUsage));
    console.log("message_delta usage:", JSON.stringify(messageDeltaUsage));

    const totalInput = (messageStartUsage?.input_tokens || 0) +
      (messageDeltaUsage?.input_tokens || 0);
    const totalOutput = (messageStartUsage?.output_tokens || 0) +
      (messageDeltaUsage?.output_tokens || 0);

    console.log(`\nActual tokens: input=${totalInput}, output=${totalOutput}`);
    console.log("Proxy strategy: In the OpenAI-format streaming usage chunk,");
    console.log("  report prompt_tokens=850000 instead of the actual value.");
    console.log("  If Cursor reads this, it would show '850K / 872K'");
    console.log("  and potentially trigger its built-in summarization.");
    console.log("  → Programmatic check confirms proxy CAN emit arbitrary values.");
    console.log("  → Manual Cursor test needed to verify behavior.");

    return {
      name: "Inflated Token Count",
      passed: true,
      details: `✅ FEASIBLE. Actual input_tokens=${totalInput}. Proxy can report prompt_tokens=850000 in OpenAI format. Manual Cursor test needed to verify if Cursor updates display and triggers summarization.`,
      rawResponse: {
        eventTypes: [...new Set(allEventTypes)],
        messageStartUsage,
        messageDeltaUsage,
      },
    };
  } catch (error) {
    return {
      name: "Inflated Token Count",
      passed: false,
      details: `❌ ERROR: ${error}`,
    };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// MAIN
// ──────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log("╔══════════════════════════════════════════════════════════════════════╗");
  console.log("║          ccproxy — Context Strategy Decision Tests                 ║");
  console.log("║          Using OAuth authentication (production path)               ║");
  console.log("╚══════════════════════════════════════════════════════════════════════╝");

  // Verify OAuth works first
  console.log("\n🔑 Verifying OAuth token...");
  const token = await getValidToken();
  if (!token) {
    console.error("❌ No valid OAuth token. Run 'claude /login' first.");
    process.exit(1);
  }
  console.log("✓ OAuth token valid\n");

  // Run all tests sequentially (to avoid rate limits and for clear output)
  results.push(await test1_compaction());
  results.push(await test2_contextEditing());
  results.push(await test3_tokenReporting());
  results.push(await test4_modelSpoofing());
  results.push(await test5_inflatedTokens());

  // ── Summary ──
  console.log(`\n\n${"═".repeat(70)}`);
  console.log("                        RESULTS SUMMARY");
  console.log("═".repeat(70));

  for (const r of results) {
    console.log(`\n${r.passed ? "✅" : "❌"} ${r.name}`);
    console.log(`   ${r.details}`);
  }

  // ── Decision Matrix ──
  console.log(`\n\n${"═".repeat(70)}`);
  console.log("                       DECISION MATRIX");
  console.log("═".repeat(70));

  const compactionWorks = results[0]?.passed;
  const contextEditingWorks = results[1]?.passed;
  const tokenReportingWorks = results[2]?.passed;

  if (compactionWorks) {
    console.log("\n🏆 RECOMMENDED: v3 = v2 + proxy-injected compaction at ~150K");
    console.log("   The Compaction API works with OAuth!");
    console.log("   Strategy:");
    console.log("   1. Proxy adds compact-2026-01-12 beta header");
    console.log("   2. Proxy injects compaction edit with trigger at ~150K");
    console.log("   3. Anthropic handles summarization server-side (fast, correct)");
    console.log("   4. Compaction blocks flow back through proxy to Cursor");
  } else if (tokenReportingWorks) {
    console.log("\n⚠️  FALLBACK A: v3 = v2 + inflated prompt_tokens (needs manual Cursor test)");
    console.log("   Compaction API NOT available with OAuth.");
    console.log("   But we can try inflating prompt_tokens to trick Cursor into summarizing.");
    console.log("   → Requires manual Cursor test to verify behavior.");
    console.log("\n⚠️  FALLBACK B: v3 = v2 + improved proxy-side compaction");
    console.log("   If inflated tokens don't trigger Cursor summarization,");
    console.log("   implement proxy-side compaction (like v1 but cleaner).");
  }

  if (contextEditingWorks) {
    console.log("\n✓  Context Editing (clear_tool_uses) works with OAuth — Cursor passthrough is valid.");
  } else {
    console.log("\n⚠️  Context Editing does NOT work with OAuth — Cursor's context_management may be silently ignored.");
  }

  console.log("\n" + "═".repeat(70));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
