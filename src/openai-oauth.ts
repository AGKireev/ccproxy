/**
 * OpenAI Codex credential detection.
 *
 * Lightweight module that checks if Codex CLI credentials exist.
 * The actual OAuth auth, token refresh, and API calls are handled
 * by the openai-oauth npm package.
 *
 * This module is only used for:
 * - Startup credential check (display status in console)
 * - /auth/openai/status endpoint
 * - /auth/openai/login instructions page
 * - /auth/openai/manual endpoint
 */

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import type { OpenAICredentials } from "./types";

// --- Auth file paths ---
const CCPROXY_CREDS_PATH = join(homedir(), ".ccproxy", "openai-credentials.json");

const AUTH_FILE_CANDIDATES = [
  CCPROXY_CREDS_PATH,
  join(homedir(), ".codex", "auth.json"),
  join(homedir(), ".chatgpt-local", "auth.json"),
];

if (process.env.CODEX_HOME) {
  AUTH_FILE_CANDIDATES.splice(1, 0, join(process.env.CODEX_HOME, "auth.json"));
}
if (process.env.CHATGPT_LOCAL_HOME) {
  AUTH_FILE_CANDIDATES.splice(1, 0, join(process.env.CHATGPT_LOCAL_HOME, "auth.json"));
}

// --- JWT helpers ---

function decodeBase64Url(value: string): string | undefined {
  try {
    const padded = value + "=".repeat(((-value.length % 4) + 4) % 4);
    return atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return undefined;
  }
}

function parseJwtClaims(token: string | undefined): Record<string, unknown> | undefined {
  if (!token || !token.includes(".")) return undefined;
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return undefined;
  const payload = decodeBase64Url(parts[1]);
  if (!payload) return undefined;
  try {
    const parsed = JSON.parse(payload);
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function deriveAccountId(idToken: string | undefined, accessToken?: string): string | null {
  for (const token of [idToken, accessToken]) {
    const claims = parseJwtClaims(token);
    if (claims) {
      const authClaim = claims["https://api.openai.com/auth"];
      if (authClaim && typeof authClaim === "object" && authClaim !== null) {
        const accountId = (authClaim as Record<string, unknown>).chatgpt_account_id;
        if (typeof accountId === "string" && accountId.length > 0) return accountId;
      }
      const directClaim = claims["https://api.openai.com/auth.chatgpt_account_id"];
      if (typeof directClaim === "string" && directClaim.length > 0) return directClaim;
    }
  }
  return null;
}

// --- Codex auth file format ---

interface CodexAuthFile {
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
  // CCProxy's own format
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  accountId?: string;
}

interface CredentialInfo {
  accessToken: string;
  accountId: string;
  expiresAt?: number;
  sourcePath: string;
}

/**
 * Load credentials from the first available auth file.
 */
async function findCredentials(): Promise<CredentialInfo | null> {
  for (const candidate of AUTH_FILE_CANDIDATES) {
    try {
      const file = Bun.file(candidate);
      if (!(await file.exists())) continue;

      const raw = await file.json() as CodexAuthFile;

      // CCProxy format
      if (raw.accessToken && raw.accountId) {
        return { accessToken: raw.accessToken, accountId: raw.accountId, expiresAt: raw.expiresAt, sourcePath: candidate };
      }

      // Codex CLI format
      if (raw.tokens?.access_token) {
        const accountId = raw.tokens.account_id || deriveAccountId(raw.tokens.id_token, raw.tokens.access_token);
        if (!accountId) continue;

        const claims = parseJwtClaims(raw.tokens.access_token);
        const jwtExp = claims && typeof claims.exp === "number" ? claims.exp * 1000 : undefined;

        return { accessToken: raw.tokens.access_token, accountId, expiresAt: jwtExp, sourcePath: candidate };
      }
    } catch {
      // Can't read this file
    }
  }
  return null;
}

// --- Public API ---

/**
 * Check if OpenAI Codex credentials exist somewhere on disk.
 */
let credentialsAvailable: boolean | null = null;

export async function isOpenAICodexAvailable(): Promise<boolean> {
  if (credentialsAvailable !== null) return credentialsAvailable;
  const creds = await findCredentials();
  credentialsAvailable = creds !== null;
  return credentialsAvailable;
}

export function resetCodexAvailabilityCache(): void {
  credentialsAvailable = null;
}

/**
 * Load credentials for display purposes (startup check, status endpoint).
 * Does NOT manage token refresh — that's handled by the openai-oauth library.
 */
export async function loadOpenAICredentials(): Promise<OpenAICredentials | null> {
  const info = await findCredentials();
  if (!info) return null;
  console.log(`✓ Loaded OpenAI credentials from ${info.sourcePath}`);
  return {
    accessToken: info.accessToken,
    refreshToken: "",
    accountId: info.accountId,
    expiresAt: info.expiresAt || Date.now() + 3600 * 1000,
  };
}

/**
 * Get a valid token for display purposes (status endpoint).
 */
export async function getValidOpenAIToken(): Promise<{ accountId: string; expiresAt: number } | null> {
  const info = await findCredentials();
  if (!info) return null;
  return { accountId: info.accountId, expiresAt: info.expiresAt || Date.now() + 3600 * 1000 };
}

/**
 * Manual login: save credentials directly to CCProxy's own file.
 */
export async function manualOpenAILogin(
  accessToken: string,
  refreshToken: string,
  accountId?: string,
  idToken?: string
): Promise<OpenAICredentials | null> {
  const resolvedAccountId = accountId || deriveAccountId(idToken, accessToken);
  if (!resolvedAccountId) {
    console.error("Could not determine account ID. Provide it explicitly.");
    return null;
  }

  const creds: OpenAICredentials = {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + 3600 * 1000,
    accountId: resolvedAccountId,
  };

  try {
    const dir = dirname(CCPROXY_CREDS_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    await Bun.write(CCPROXY_CREDS_PATH, JSON.stringify(creds, null, 2));
    console.log(`✓ OpenAI credentials saved (Account ID: ${resolvedAccountId})`);
  } catch (error) {
    console.error("Failed to save credentials:", error);
    return null;
  }

  credentialsAvailable = true;
  return creds;
}

/**
 * Get auth file locations for display.
 */
export function getAuthFileLocations(): string[] {
  return [...AUTH_FILE_CANDIDATES];
}
