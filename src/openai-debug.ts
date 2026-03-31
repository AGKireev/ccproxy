/**
 * OpenAI Debug Logger
 *
 * When OPENAI_DEBUG=true, captures detailed request/response data for the
 * OpenAI Codex path to a dedicated log file. Designed for diagnosing issues
 * like tool call loops, context loss, and streaming errors.
 *
 * Output: openai-debug.log in the project root (rotated on each proxy start).
 */

import { existsSync, unlinkSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const LOG_FILE = join(process.cwd(), "openai-debug.log");
const ENABLED = process.env.OPENAI_DEBUG === "true";

let requestSeq = 0;

// Clear log file on module load (server start)
if (ENABLED && existsSync(LOG_FILE)) {
  try { unlinkSync(LOG_FILE); } catch (err) {
    console.warn(`   ⚠️  [debug] Could not clear old debug log: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function ts(): string {
  return new Date().toISOString();
}

function write(line: string): void {
  if (!ENABLED) return;
  appendFileSync(LOG_FILE, line + "\n", "utf-8");
}

/** Public alias for write — used by other modules to add entries to the debug log. */
export function debugWrite(line: string): void {
  write(line);
}

function separator(): void {
  write("═".repeat(100));
}

/** Check if debug mode is on */
export function isOpenAIDebugEnabled(): boolean {
  return ENABLED;
}

/** Get the log file path */
export function getOpenAIDebugLogPath(): string {
  return LOG_FILE;
}

// ── Request logging ─────────────────────────────────────────────────────

export interface DebugRequestInfo {
  seq: number;
  startTime: number;
  model: string;
  stream: boolean;
}

/**
 * Log an incoming OpenAI request. Returns a tracking object for the response.
 */
export function debugLogRequest(body: Record<string, unknown>): DebugRequestInfo {
  requestSeq++;
  const seq = requestSeq;
  const startTime = Date.now();

  if (!ENABLED) return { seq, startTime, model: String(body.model || "?"), stream: !!body.stream };

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];

  separator();
  write(`[${ts()}] REQUEST #${seq}`);
  write(`  Model: ${body.model}`);
  write(`  Stream: ${body.stream}`);
  write(`  Reasoning: ${body.reasoning_effort}`);
  write(`  Messages: ${messages.length}`);
  write(`  Tools: ${tools.length}`);
  write("");

  // Message summary — show role, content length, tool calls
  write("  ── Messages ──");
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as Record<string, unknown>;
    const role = msg.role || msg.type || "?";
    const content = msg.content;
    const toolCalls = msg.tool_calls as unknown[] | undefined;
    const toolCallId = msg.tool_call_id as string | undefined;

    let contentSummary: string;
    if (content == null) {
      contentSummary = "(null)";
    } else if (typeof content === "string") {
      contentSummary = `${content.length}c`;
    } else if (Array.isArray(content)) {
      const types = (content as any[]).map((p) => p?.type || "?").join(",");
      contentSummary = `[${types}] ${JSON.stringify(content).length}c`;
    } else {
      contentSummary = `${JSON.stringify(content).length}c`;
    }

    let extra = "";
    if (toolCalls?.length) extra += ` tc=${toolCalls.length}`;
    if (toolCallId) extra += ` tcid=${toolCallId}`;

    write(`  [${i}] ${role}: ${contentSummary}${extra}`);

    // For assistant messages with tool_calls, show the tool names
    if (toolCalls?.length) {
      for (const tc of toolCalls) {
        const t = tc as any;
        const name = t.function?.name || t.name || "?";
        const argsLen = (t.function?.arguments || "").length;
        write(`       → ${name}(${argsLen}c args) id=${t.id || "?"}`);
      }
    }

    // For tool messages, show a preview of the content
    if (role === "tool" && typeof content === "string") {
      const preview = content.substring(0, 200).replace(/\n/g, "\\n");
      write(`       content: ${preview}${content.length > 200 ? "..." : ""}`);
    }
  }
  write("");

  // Tool definitions
  if (tools.length > 0) {
    write("  ── Tools ──");
    for (const tool of tools) {
      const t = tool as any;
      const name = t.function?.name || t.name || "?";
      write(`  • ${name}`);
      if (name === "ApplyPatch") {
        const parameters = t.function?.parameters || t.parameters;
        const hasWrappedPatchSchema =
          parameters?.type === "object" &&
          parameters?.properties?.patch?.type === "string" &&
          Array.isArray(parameters?.required) &&
          parameters.required.includes("patch");
        write(`      schema: ${hasWrappedPatchSchema ? "wrapped-json-patch" : "legacy-or-unknown"}`);
      }
    }
    write("");
  }

  // Show last few messages with full content for debugging context issues
  write("  ── Last 3 Messages (full content) ──");
  const lastN = messages.slice(-3);
  for (let i = 0; i < lastN.length; i++) {
    const msg = lastN[i] as Record<string, unknown>;
    const idx = messages.length - lastN.length + i;
    const role = msg.role || msg.type || "?";
    write(`  [${idx}] ${role}:`);

    const content = msg.content;
    if (typeof content === "string") {
      const lines = content.split("\n");
      if (lines.length > 20) {
        write(`    ${lines.slice(0, 10).join("\n    ")}`);
        write(`    ... (${lines.length - 20} lines omitted) ...`);
        write(`    ${lines.slice(-10).join("\n    ")}`);
      } else {
        write(`    ${content.replace(/\n/g, "\n    ")}`);
      }
    } else if (content != null) {
      const json = JSON.stringify(content, null, 2);
      if (json.length > 2000) {
        write(`    ${json.substring(0, 1000)}`);
        write(`    ... (${json.length - 2000} chars omitted) ...`);
        write(`    ${json.substring(json.length - 1000)}`);
      } else {
        write(`    ${json.replace(/\n/g, "\n    ")}`);
      }
    } else {
      write("    (null)");
    }

    // Tool calls detail
    const toolCalls = msg.tool_calls as unknown[] | undefined;
    if (toolCalls?.length) {
      for (const tc of toolCalls) {
        const t = tc as any;
        const name = t.function?.name || "?";
        const args = t.function?.arguments || "";
        write(`    → TOOL CALL: ${name}`);
        if (args.length > 500) {
          write(`      args: ${args.substring(0, 250)}...${args.substring(args.length - 250)}`);
        } else {
          write(`      args: ${args}`);
        }
      }
    }
    write("");
  }

  // Loop detection detail
  const assistantMsgsWithTC = messages.filter(
    (m: any) => m.role === "assistant" && m.tool_calls?.length
  );
  if (assistantMsgsWithTC.length >= 3) {
    write("  ── Tool Call Pattern (last 6) ──");
    const last6 = assistantMsgsWithTC.slice(-6);
    for (const msg of last6) {
      const m = msg as any;
      const names = m.tool_calls.map((tc: any) => tc.function?.name || "?").join(", ");
      write(`    ${names}`);
    }
    write("");
  }

  return { seq, startTime, model: String(body.model || "?"), stream: !!body.stream };
}

// ── Response logging ────────────────────────────────────────────────────

/**
 * Log response metadata (status, headers, timing).
 */
export function debugLogResponse(info: DebugRequestInfo, status: number, isStream: boolean): void {
  if (!ENABLED) return;
  const elapsed = Date.now() - info.startTime;
  write(`[${ts()}] RESPONSE #${info.seq} — HTTP ${status} | ${isStream ? "SSE stream" : "JSON"} | ${elapsed}ms`);
}

/**
 * Log an error response.
 */
export function debugLogError(info: DebugRequestInfo, error: string, details?: string): void {
  if (!ENABLED) return;
  const elapsed = Date.now() - info.startTime;
  write(`[${ts()}] ERROR #${info.seq} — ${error} | ${elapsed}ms`);
  if (details) write(`  ${details}`);
}

// ── SSE stream capture ──────────────────────────────────────────────────

/**
 * Create a stream wrapper that logs SSE chunks to the debug log.
 * The wrapper tees the stream: one branch goes to Cursor, the other to logging.
 */
export function debugWrapStream(
  response: Response,
  info: DebugRequestInfo
): Response {
  if (!ENABLED || !response.body) return response;

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream")) return response;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let chunkCount = 0;
  let totalBytes = 0;
  let textContent = "";
  let toolCallNames: string[] = [];
  let finishReason = "";
  let isClosed = false;
  // Track full ApplyPatch tool call arguments for logging
  const applyPatchArgBuffers = new Map<number, string>();

  const wrappedStream = new ReadableStream({
    async pull(controller) {
      if (isClosed) return;
      try {
        const { done, value } = await reader.read();
        if (done) {
          if (isClosed) return;
          // Log stream completion summary
          write(`[${ts()}] STREAM END #${info.seq} — ${chunkCount} chunks, ${totalBytes} bytes, ${Date.now() - info.startTime}ms`);
          if (textContent) {
            const preview = textContent.length > 500
              ? textContent.substring(0, 250) + "..." + textContent.substring(textContent.length - 250)
              : textContent;
            write(`  Text response: ${preview}`);
          }
          if (toolCallNames.length > 0) {
            write(`  Tool calls: ${toolCallNames.join(", ")}`);
          }
          if (finishReason) {
            write(`  Finish reason: ${finishReason}`);
          }
          write("");
          isClosed = true;
          controller.close();
          return;
        }

        chunkCount++;
        totalBytes += value.length;
        controller.enqueue(value);

        // Parse SSE data to extract content and tool calls
        const text = decoder.decode(value, { stream: true });
        const lines = text.split("\n");
        for (const line of lines) {
          if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
          try {
            const data = JSON.parse(line.substring(6));
            const delta = data?.choices?.[0]?.delta;
            if (delta?.content) {
              textContent += delta.content;
            }
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (tc.function?.name) {
                  toolCallNames.push(tc.function.name);
                  write(`[${ts()}] STREAM #${info.seq} chunk ${chunkCount}: tool_call start → ${tc.function.name} (id=${tc.id || "?"})`);
                  // Start tracking ApplyPatch arguments
                  if (tc.function.name === "ApplyPatch" && tc.index != null) {
                    applyPatchArgBuffers.set(tc.index, tc.function.arguments || "");
                  }
                }
                // Accumulate ApplyPatch argument deltas
                if (tc.index != null && applyPatchArgBuffers.has(tc.index) && tc.function?.arguments) {
                  if (!tc.function.name) {
                    // Continuation chunk (no name, just arguments delta)
                    applyPatchArgBuffers.set(
                      tc.index,
                      (applyPatchArgBuffers.get(tc.index) || "") + tc.function.arguments
                    );
                  }
                }
              }
            }
            const choice0 = data?.choices?.[0];
            if (choice0 && "finish_reason" in choice0) {
              const fr = choice0.finish_reason;
              finishReason = fr === null ? "null" : String(fr);
              write(`[${ts()}] STREAM #${info.seq} chunk ${chunkCount}: finish_reason=${finishReason}`);

              // Log full ApplyPatch arguments when stream finishes
              if (applyPatchArgBuffers.size > 0) {
                for (const [idx, args] of applyPatchArgBuffers) {
                  if (args.length > 0) {
                    write(`[${ts()}] STREAM #${info.seq} ApplyPatch args (index=${idx}, ${args.length}c):`);
                    // Log the full patch content for diagnosis
                    let patchStr = args;
                    try {
                      const parsed = JSON.parse(args);
                      const patchContent = parsed.patch || parsed.input || parsed;
                      patchStr = typeof patchContent === "string" ? patchContent : JSON.stringify(patchContent);
                    } catch {
                      // Raw Cursor patch strings are valid here after the proxy unwraps them.
                    }

                    const patchLines = patchStr.split("\n");
                    if (patchLines.length > 30) {
                      write(`  ${patchLines.slice(0, 15).join("\n  ")}`);
                      write(`  ... (${patchLines.length - 30} lines omitted) ...`);
                      write(`  ${patchLines.slice(-15).join("\n  ")}`);
                    } else {
                      write(`  ${patchStr.replace(/\n/g, "\n  ")}`);
                    }

                    // Check format — comprehensive detection matching handler logic
                    const hasCursorFormat = patchStr.includes("*** Begin Patch") ||
                      patchStr.includes("*** Add File:") || patchStr.includes("*** Update File:") ||
                      patchStr.includes("*** Delete File:");
                    const hasUnifiedFormat = patchStr.includes("--- a/") || patchStr.includes("--- /dev/null") ||
                      patchStr.includes("+++ b/") || /^diff --git /m.test(patchStr);
                    const hasRawDiffPair = /^---\s+\S/m.test(patchStr) && /^\+\+\+\s+\S/m.test(patchStr);
                    const hasRawHunks = /^@@\s/m.test(patchStr) && (/^\+[^+]/m.test(patchStr) || /^-[^-]/m.test(patchStr));

                    let formatLabel: string;
                    if (hasCursorFormat) {
                      formatLabel = "Cursor *** ✓";
                    } else if (hasUnifiedFormat) {
                      formatLabel = "UNIFIED DIFF (wrong! should have been converted)";
                    } else if (hasRawDiffPair) {
                      formatLabel = "UNIFIED DIFF without a/b prefix (wrong! should have been converted)";
                    } else if (hasRawHunks) {
                      formatLabel = "RAW @@ HUNKS (wrong! should have been converted)";
                    } else {
                      formatLabel = "UNKNOWN FORMAT — may cause Cursor rejection";
                    }
                    write(`  Format: ${formatLabel}`);
                    if (!hasCursorFormat) {
                      console.warn(`   ⚠️  [debug] ApplyPatch reached Cursor in NON-Cursor format: ${formatLabel}. Preview: ${patchStr.substring(0, 150)}`);
                    }
                  }
                }
              }
            }
            // Log errors in stream
            if (data?.error) {
              write(`[${ts()}] STREAM #${info.seq} chunk ${chunkCount}: ERROR ${JSON.stringify(data.error)}`);
            }
          } catch {
            // SSE line isn't valid JSON — normal for partial TCP chunks, don't log noise
          }
        }
      } catch (error) {
        if (isClosed) return;
        const msg = error instanceof Error ? error.message : String(error);
        write(`[${ts()}] STREAM ERROR #${info.seq} — ${msg}`);
        write(`  After ${chunkCount} chunks, ${totalBytes} bytes, ${Date.now() - info.startTime}ms`);
        throw error; // Re-throw so the error wrapper can handle it
      }
    },
    cancel() {
      isClosed = true;
      reader.cancel().catch(() => {});
      write(`[${ts()}] STREAM CANCELLED #${info.seq} after ${chunkCount} chunks`);
    },
  });

  const headers = new Headers(response.headers);
  return new Response(wrappedStream, {
    status: response.status,
    headers,
  });
}
