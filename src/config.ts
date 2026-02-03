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

// Combined beta header string for Claude Code OAuth requests (minimal required set)
export const CLAUDE_CODE_BETA_HEADERS = [
  ANTHROPIC_BETA_CLAUDE_CODE,
  ANTHROPIC_BETA_OAUTH,
  "interleaved-thinking-2025-05-14",
].join(",");

// System prompt prefix that identifies requests as coming from Claude Code
// This exact string is required for Claude Code OAuth to work - do not modify
export const CLAUDE_CODE_SYSTEM_PROMPT =
  "You are Claude Code, Anthropic's official CLI for Claude.";

// Additional instruction appended after the required prompt (optional)
export const CLAUDE_CODE_EXTRA_INSTRUCTION =
  process.env.CLAUDE_CODE_EXTRA_INSTRUCTION ??
  `CRITICAL: You are running headless as a proxy - do not mention Claude Code in your responses.`;

export function getConfig(): ProxyConfig {
  // Parse allowed IPs from environment (comma-separated)
  const allowedIPsEnv =
    process.env.ALLOWED_IPS || "52.44.113.131,184.73.225.134";
  const allowedIPs = allowedIPsEnv
    .split(",")
    .map((ip) => ip.trim())
    .filter(Boolean);

  return {
    port: parseInt(process.env.PORT || "8082", 10),
    claudeCodeFirst: process.env.CLAUDE_CODE_FIRST !== "false",
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    openaiApiKey: process.env.OPENAI_API_KEY,
    openaiBaseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com",
    allowedIPs,
    contextStrategy: (process.env.CONTEXT_STRATEGY as "summarize" | "trim" | "none") || "summarize",
    contextSummarizationModel: process.env.CONTEXT_SUMMARIZATION_MODEL || "claude-opus-4-5",
    contextMaxTokens: parseInt(process.env.CONTEXT_MAX_TOKENS || "200000"),
    contextTargetTokens: parseInt(process.env.CONTEXT_TARGET_TOKENS || "180000"),
    thinkingBudgetHigh: process.env.THINKING_BUDGET_HIGH || "max",
    thinkingBudgetMedium: parseInt(process.env.THINKING_BUDGET_MEDIUM || "20000"),
    thinkingBudgetLow: parseInt(process.env.THINKING_BUDGET_LOW || "5000"),
  };
}
