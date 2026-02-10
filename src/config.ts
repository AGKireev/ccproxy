import { homedir } from "node:os";
import { join } from "node:path";
import type { ProxyConfig } from "./types";

export const CLAUDE_CREDENTIALS_PATH = join(
  homedir(),
  ".claude",
  ".credentials.json"
);
export const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const ANTHROPIC_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
export const ANTHROPIC_API_URL = "https://api.anthropic.com";
// Required beta headers for Claude Code OAuth
export const ANTHROPIC_BETA_OAUTH = "oauth-2025-04-20";
export const ANTHROPIC_BETA_CLAUDE_CODE = "claude-code-20250219";
export const ANTHROPIC_BETA_COMPACTION = "compact-2026-01-12";

// Combined beta header string for Claude Code OAuth requests
// - interleaved-thinking-2025-05-14: deprecated on Opus 4.6 (auto-enabled), still needed for 4.5
const BETA_HEADERS_LIST = [
  ANTHROPIC_BETA_CLAUDE_CODE,
  ANTHROPIC_BETA_OAUTH,
  "interleaved-thinking-2025-05-14",
];
export const CLAUDE_CODE_BETA_HEADERS = BETA_HEADERS_LIST.join(",");

// Required Claude Code OAuth headers (always added for authentication)
const CLAUDE_CODE_REQUIRED_BETAS = [
  ANTHROPIC_BETA_CLAUDE_CODE,   // "claude-code-20250219"
  ANTHROPIC_BETA_OAUTH,         // "oauth-2025-04-20"
];

// Beta headers that are NOT available on OAuth subscriptions.
// Cursor may send these, but the API will reject the entire request with 400.
const BLOCKED_BETAS = new Set([
  "context-1m-2025-08-07",  // Requires API Usage Tier 4, not available on OAuth
]);

/**
 * Merge Cursor's beta headers with Claude Code required headers.
 * Cursor's headers are preserved (except blocked ones); Claude Code auth headers are added on top.
 */
export function mergeBetaHeaders(cursorBetaHeader: string | null): string {
  const headers = new Set<string>();
  // Always add Claude Code required headers
  for (const h of CLAUDE_CODE_REQUIRED_BETAS) headers.add(h);
  // Add Cursor's headers (filtering out blocked ones)
  if (cursorBetaHeader) {
    for (const h of cursorBetaHeader.split(",").map(s => s.trim()).filter(Boolean)) {
      if (BLOCKED_BETAS.has(h)) {
        console.log(`   [Beta] Stripped "${h}" (not available on OAuth)`);
        continue;
      }
      headers.add(h);
    }
  } else {
    // No Cursor headers — add defaults (backwards compat)
    headers.add("interleaved-thinking-2025-05-14");
  }
  return Array.from(headers).join(",");
}

// System prompt prefix that identifies requests as coming from Claude Code
// This exact string is required for Claude Code OAuth to work - do not modify
export const CLAUDE_CODE_SYSTEM_PROMPT =
  "You are Claude Code, Anthropic's official CLI for Claude.";

// Additional instruction appended after the required prompt (optional)
export const CLAUDE_CODE_EXTRA_INSTRUCTION =
  process.env.CLAUDE_CODE_EXTRA_INSTRUCTION ??
  `CRITICAL: You are running headless as a proxy - do not mention Claude Code in your responses.`;

let cachedConfig: ProxyConfig | null = null;

export function getConfig(): ProxyConfig {
  if (cachedConfig) return cachedConfig;

  // Parse allowed IPs from environment (comma-separated)
  const allowedIPsEnv =
    process.env.ALLOWED_IPS || "52.44.113.131,184.73.225.134";
  const allowedIPs = allowedIPsEnv
    .split(",")
    .map((ip) => ip.trim())
    .filter(Boolean);

  cachedConfig = {
    port: parseInt(process.env.PORT || "8082", 10),
    claudeCodeFirst: process.env.CLAUDE_CODE_FIRST !== "false",
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    openaiApiKey: process.env.OPENAI_API_KEY,
    openaiBaseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com",
    allowedIPs,
    compactionEnabled: process.env.COMPACTION_ENABLED === "true",
    compactionTriggerTokens: Math.max(50000, parseInt(process.env.COMPACTION_TRIGGER_TOKENS || "150000", 10)),
    // Token inflation: only needed when Cursor shows 872K denominator (MAX Mode ON).
    // With MAX Mode OFF (200K denominator), raw tokens are already truthful — disable inflation.
    tokenInflationEnabled: process.env.TOKEN_INFLATION === "true",
  };

  return cachedConfig;
}
