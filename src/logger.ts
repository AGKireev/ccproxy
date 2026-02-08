/**
 * File-based logger for verbose API request/response logging.
 * File logging is disabled by default — set VERBOSE_LOGGING=true to enable.
 */

import { existsSync, unlinkSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const LOG_FILE = join(process.cwd(), "api.log");
const VERBOSE_ENABLED = process.env.VERBOSE_LOGGING === "true";

// Clear log file on module load (server start) — only if verbose logging is enabled
if (VERBOSE_ENABLED && existsSync(LOG_FILE)) {
  unlinkSync(LOG_FILE);
}

function formatTimestamp(): string {
  const now = new Date();
  return now.toISOString();
}

function formatMessage(level: string, message: string): string {
  return `[${formatTimestamp()}] [${level}] ${message}\n`;
}

function writeToFile(level: string, message: string): void {
  if (!VERBOSE_ENABLED) return;
  const formatted = formatMessage(level, message);
  appendFileSync(LOG_FILE, formatted, "utf-8");
}

export const logger = {
  debug(message: string): void {
    writeToFile("DEBUG", message);
    console.log(message);
  },

  info(message: string): void {
    writeToFile("INFO", message);
    console.log(message);
  },

  warn(message: string): void {
    writeToFile("WARN", message);
    console.warn(message);
  },

  error(message: string): void {
    writeToFile("ERROR", message);
    console.error(message);
  },

  verbose(message: string): void {
    // Verbose logs only go to file (when enabled), never to console
    writeToFile("VERBOSE", message);
  },
};

export const isVerboseLogging = VERBOSE_ENABLED;
