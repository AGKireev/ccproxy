import {
  CLAUDE_CREDENTIALS_PATH,
  CLAUDE_CLIENT_ID,
  ANTHROPIC_TOKEN_URL,
} from "./config";
import type {
  ClaudeCredentials,
  TokenInfo,
  TokenRefreshResponse,
} from "./types";
import { openSync, closeSync, unlinkSync, existsSync, readFileSync, writeFileSync } from "node:fs";

let cachedToken: TokenInfo | null = null;

// In-process mutex to prevent concurrent refreshes from parallel requests
let refreshInProgress: Promise<TokenInfo | null> | null = null;

// --- File locking ---
// Uses a .lock file with O_CREAT|O_EXCL for atomic creation (works cross-platform).
// If a lock is stale (>30s old), we force-remove it.

const LOCK_FILE = CLAUDE_CREDENTIALS_PATH + ".lock";
const LOCK_TIMEOUT_MS = 30_000; // stale lock threshold
const LOCK_RETRY_MS = 100;
const LOCK_MAX_RETRIES = 50; // 5s total wait

function acquireLock(): boolean {
  try {
    // O_CREAT | O_EXCL = atomic create, fails if file exists
    const fd = openSync(LOCK_FILE, "wx");
    closeSync(fd);
    // Write timestamp for stale detection (after closing the exclusive fd)
    writeFileSync(LOCK_FILE, String(Date.now()));
    return true;
  } catch {
    // Atomic create failed — lock file exists. Check if it's stale.
    try {
      const lockContent = readFileSync(LOCK_FILE, "utf-8");
      const lockTime = parseInt(lockContent, 10);
      if (!isNaN(lockTime) && Date.now() - lockTime > LOCK_TIMEOUT_MS) {
        console.log("⚠ Removing stale credentials lock file");
        try { unlinkSync(LOCK_FILE); } catch {}
        // Retry atomic create after removing stale lock
        try {
          const fd = openSync(LOCK_FILE, "wx");
          closeSync(fd);
          writeFileSync(LOCK_FILE, String(Date.now()));
          return true;
        } catch {
          return false; // Another process grabbed it between delete and create
        }
      }
    } catch {
      // Can't read lock file — another process may be writing it
    }
    return false; // lock held by another process
  }
}

function releaseLock(): void {
  try {
    unlinkSync(LOCK_FILE);
  } catch {}
}

async function withFileLock<T>(fn: () => Promise<T>): Promise<T> {
  let acquired = false;
  let retries = 0;
  while (!(acquired = acquireLock())) {
    retries++;
    if (retries >= LOCK_MAX_RETRIES) {
      throw new Error("Could not acquire credentials lock after 5s — another process may be stuck");
    }
    await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
  }

  try {
    return await fn();
  } finally {
    if (acquired) {
      releaseLock();
    }
  }
}

// --- Credential loading ---

async function loadFromKeychain(): Promise<ClaudeCredentials | null> {
  try {
    const proc = Bun.spawn(
      [
        "security",
        "find-generic-password",
        "-a",
        Bun.env.USER || "",
        "-s",
        "Claude Code-credentials",
        "-w",
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0 || !output.trim()) {
      return null;
    }

    return JSON.parse(output.trim());
  } catch {
    return null;
  }
}

async function loadFromFile(): Promise<ClaudeCredentials | null> {
  try {
    const file = Bun.file(CLAUDE_CREDENTIALS_PATH);
    if (!(await file.exists())) {
      return null;
    }
    return await file.json();
  } catch {
    return null;
  }
}

/**
 * Save credentials back to the file after a successful token refresh.
 * Reads the existing file first to preserve any extra fields, then
 * updates only the OAuth token fields.
 * MUST be called within withFileLock.
 */
async function saveCredentials(tokenInfo: TokenInfo): Promise<void> {
  try {
    let existing: any = {};
    const file = Bun.file(CLAUDE_CREDENTIALS_PATH);
    if (await file.exists()) {
      existing = await file.json();
    }

    existing.claudeAiOauth = {
      ...existing.claudeAiOauth,
      accessToken: tokenInfo.accessToken,
      refreshToken: tokenInfo.refreshToken,
      expiresAt: tokenInfo.expiresAt,
    };

    await Bun.write(CLAUDE_CREDENTIALS_PATH, JSON.stringify(existing));
    console.log("✓ Credentials saved to file");
  } catch (error) {
    console.error("Failed to save credentials:", error);
  }
}

export async function loadCredentials(): Promise<ClaudeCredentials | null> {
  // Try Keychain first (macOS), then file fallback
  const keychainCreds = await loadFromKeychain();
  if (keychainCreds?.claudeAiOauth) {
    console.log("✓ Loaded credentials from macOS Keychain");
    return keychainCreds;
  }

  const fileCreds = await loadFromFile();
  if (fileCreds?.claudeAiOauth) {
    console.log("✓ Loaded credentials from file");
    return fileCreds;
  }

  console.error(
    `Credentials not found in Keychain or ${CLAUDE_CREDENTIALS_PATH}`
  );
  console.error("Please run 'claude /login' first to authenticate.");
  return null;
}

export function isTokenExpired(expiresAt: number): boolean {
  const bufferMs = 5 * 60 * 1000; // 5 minute buffer
  return Date.now() >= expiresAt - bufferMs;
}

/**
 * Core refresh logic — called within file lock and in-process mutex.
 */
async function doRefreshToken(
  refreshTokenValue: string
): Promise<TokenInfo | null> {
  // Re-read credentials fresh from file (inside lock),
  // in case another process just refreshed
  const freshCreds = await loadFromFile();
  if (freshCreds?.claudeAiOauth) {
    const fresh = freshCreds.claudeAiOauth;
    // If the file has a newer, non-expired token, use it directly
    if (!isTokenExpired(fresh.expiresAt)) {
      console.log("✓ Found fresh token in credentials file (updated by another process)");
      const tokenInfo: TokenInfo = {
        accessToken: fresh.accessToken,
        refreshToken: fresh.refreshToken,
        expiresAt: fresh.expiresAt,
        isExpired: false,
      };
      cachedToken = tokenInfo;
      return tokenInfo;
    }
    // If the file has a different refresh token, use that instead
    if (fresh.refreshToken !== refreshTokenValue) {
      console.log("✓ Using updated refresh token from credentials file");
      refreshTokenValue = fresh.refreshToken;
    }
  }

  console.log("Refreshing OAuth token...");

  const response = await fetch(ANTHROPIC_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshTokenValue,
      client_id: CLAUDE_CLIENT_ID,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("Token refresh failed:", response.status, errorText);
    return null;
  }

  const data: TokenRefreshResponse = await response.json();
  const expiresAt = Date.now() + data.expires_in * 1000;

  const tokenInfo: TokenInfo = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt,
    isExpired: false,
  };

  cachedToken = tokenInfo;

  // Persist the new tokens back to the credentials file
  await saveCredentials(tokenInfo);

  console.log("✓ Token refreshed successfully");
  return tokenInfo;
}

/**
 * Refresh the OAuth token with:
 * 1. In-process mutex (prevents concurrent refreshes from parallel requests)
 * 2. File lock (prevents races with Claude CLI or other processes)
 */
export async function refreshToken(
  refreshTokenValue: string
): Promise<TokenInfo | null> {
  // If a refresh is already in progress in this process, wait for it
  if (refreshInProgress) {
    console.log("Token refresh already in progress, waiting...");
    return refreshInProgress;
  }

  refreshInProgress = withFileLock(() => doRefreshToken(refreshTokenValue))
    .catch((error) => {
      console.error("Failed to refresh token:", error);
      return null;
    })
    .finally(() => {
      refreshInProgress = null;
    });

  return refreshInProgress;
}

export async function getValidToken(): Promise<TokenInfo | null> {
  if (cachedToken && !isTokenExpired(cachedToken.expiresAt)) {
    return cachedToken;
  }

  const credentials = await loadCredentials();
  if (!credentials?.claudeAiOauth) {
    return null;
  }

  const {
    accessToken,
    refreshToken: storedRefreshToken,
    expiresAt,
  } = credentials.claudeAiOauth;

  if (isTokenExpired(expiresAt)) {
    return await refreshToken(storedRefreshToken);
  }

  cachedToken = {
    accessToken,
    refreshToken: storedRefreshToken,
    expiresAt,
    isExpired: false,
  };

  return cachedToken;
}

export function clearCachedToken(): void {
  cachedToken = null;
}
