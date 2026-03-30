/**
 * OpenAI Codex handler using the openai-oauth library.
 *
 * Cursor sends messages in Responses API item format mixed with Chat Completions:
 *   - {role: "assistant", content: [{type: "output_text", text: "..."}]}
 *   - {type: "function_call", call_id, name, arguments}  (no role!)
 *   - {type: "function_call_output", call_id, output: [{type: "input_text", text: "..."}]}  (no role!)
 *   - {role: "user", content: [{type: "input_text", text: "..."}]}
 *
 * The openai-oauth library (Vercel AI SDK) expects PURE OpenAI Chat Completions format:
 *   - {role: "assistant", content: "text", tool_calls: [...]}
 *   - {role: "tool", content: "text", tool_call_id: "..."}
 *   - {role: "user", content: "text" | [{type: "text", text: "..."}, {type: "image_url", ...}]}
 *
 * This module normalizes Cursor's format before passing to the library.
 */

import { createOpenAIOAuthFetchHandler } from "openai-oauth";
import type { OpenAIOAuthServerOptions } from "openai-oauth";
import { getConfig } from "./config";
import { logger } from "./logger";
import {
  debugLogRequest,
  debugLogResponse,
  debugLogError,
  debugWrapStream,
} from "./openai-debug";

let handler: ((request: Request) => Promise<Response>) | null = null;

// Track the last error from openai-oauth for enriching stream errors
let lastCodexError: { message: string; durationMs: number; timestamp: number } | null = null;

function getHandler(): (request: Request) => Promise<Response> {
  if (handler) return handler;

  const options: OpenAIOAuthServerOptions = {
    requestLogger: (event) => {
      if (event.type === "chat_request") {
        console.log(`   [openai-oauth] Request: model=${event.model}, messages=${event.messageCount}, tools=${event.toolCount}, stream=${event.stream}`);
      } else if (event.type === "chat_response") {
        console.log(`   [openai-oauth] Response: status=${event.status}, stream=${event.stream}, finish=${event.finishReason}, duration=${event.durationMs}ms`);
        if (event.usage) {
          console.log(`   [openai-oauth] Usage: input=${event.usage.inputTokens ?? 0}, output=${event.usage.outputTokens ?? 0}, reasoning=${event.usage.reasoningTokens ?? 0}, cached=${event.usage.cachedInputTokens ?? 0}`);
        }
      } else if (event.type === "chat_error") {
        console.error(`   [openai-oauth] ❌ Error: ${event.message} (${event.durationMs}ms)`);
        lastCodexError = { message: event.message, durationMs: event.durationMs, timestamp: Date.now() };
      }
    },
  };

  handler = createOpenAIOAuthFetchHandler(options);
  console.log("✓ openai-oauth handler initialized");
  return handler;
}

// ── finish_reason fixer ─────────────────────────────────────────────────
// The openai-oauth library (via Vercel AI SDK) sometimes emits finish_reason: null
// even when the model returned tool calls. Cursor relies on finish_reason: "tool_calls"
// to know that tool calls need executing; without it, Cursor drops the tool_calls
// from the assistant message, never executes them, and sends the same history back,
// causing an infinite loop.
//
// This wrapper tracks tool_call deltas in the SSE stream and:
//  1. Rewrites finish_reason: null → "tool_calls" if tool call chunks were seen
//  2. Injects a finish_reason chunk if the stream ends without one

function fixToolCallFinishReason(response: Response): Response {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream") || !response.body) {
    console.log("   [finish-fix] SKIP: not SSE or no body");
    return response;
  }

  console.log("   [finish-fix] Active — wrapping SSE stream (split-safe tool detection)");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let hasToolCalls = false;
  let emittedToolCallsFinish = false;
  let lastId = "chatcmpl-proxy";
  let lastModel = "gpt-5.4";
  let readCount = 0;
  let isCancelled = false;
  // CRITICAL: TCP can split JSON mid-string. A single read may not contain the full
  // substring "tool_calls", so we keep a sliding tail and scan (carry + chunk).
  let scanCarry = "";

  const wrappedStream = new ReadableStream({
    async pull(controller) {
      if (isCancelled) return;
      try {
        const { done, value } = await reader.read();
        if (isCancelled) return; // Cursor cancelled while we were waiting for data
        readCount++;

        if (done) {
          console.log(
            `   [finish-fix] Stream done after ${readCount} reads. hasToolCalls=${hasToolCalls}, emittedFinish=${emittedToolCallsFinish}`
          );
          if (hasToolCalls && !emittedToolCallsFinish) {
            console.log("   🔧 [OpenAI Codex] Injecting finish_reason: tool_calls at stream end (split-safe fallback)");
            const finishChunk = `data: ${JSON.stringify({
              id: lastId,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: lastModel,
              choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            })}\n\n`;
            controller.enqueue(encoder.encode(finishChunk));
          }
          controller.close();
          return;
        }

        const text = decoder.decode(value, { stream: true });

        // Split-safe: "tool_calls" may span chunk boundaries (e.g. ..."tool_ | calls":...)
        const combined = scanCarry + text;
        if (combined.includes('"tool_calls"')) {
          if (!hasToolCalls) {
            console.log(`   [finish-fix] Detected tool_calls (split-safe) on read #${readCount}`);
          }
          hasToolCalls = true;
        }
        scanCarry = combined.slice(-64);

        // Real finish_reason as a quoted string (not null)
        const finishMatch = text.match(/"finish_reason"\s*:\s*"([^"]+)"/);
        if (finishMatch) {
          emittedToolCallsFinish = true;
          if (readCount <= 3) {
            console.log(`   [finish-fix] Found real finish_reason: "${finishMatch[1]}" in read #${readCount}`);
          }
        }

        if (hasToolCalls && !emittedToolCallsFinish) {
          // Inject before [DONE] when it appears whole in this chunk
          if (text.includes("data: [DONE]")) {
            console.log("   🔧 [OpenAI Codex] Injecting finish_reason: tool_calls before [DONE]");
            const finishEvent = `data: ${JSON.stringify({
              id: lastId,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: lastModel,
              choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            })}\n\n`;
            const modified = text.replace(/data: \[DONE\]/g, finishEvent + "data: [DONE]");
            emittedToolCallsFinish = true;
            controller.enqueue(encoder.encode(modified));
            return;
          }

          const emptyDeltaFinish = /"delta"\s*:\s*\{\s*\}\s*,\s*"finish_reason"\s*:\s*null/;
          if (emptyDeltaFinish.test(text)) {
            console.log("   🔧 [OpenAI Codex] Rewriting finish_reason: null → tool_calls");
            const modified = text.replace(
              emptyDeltaFinish,
              '"delta":{},"finish_reason":"tool_calls"'
            );
            emittedToolCallsFinish = true;
            controller.enqueue(encoder.encode(modified));
            return;
          }
        }

        if (readCount <= 3) {
          const idMatch = text.match(/"id"\s*:\s*"([^"]+)"/);
          if (idMatch) lastId = idMatch[1];
          const modelMatch = text.match(/"model"\s*:\s*"([^"]+)"/);
          if (modelMatch) lastModel = modelMatch[1];
        }

        controller.enqueue(value);
      } catch (error) {
        if (isCancelled) return; // Don't re-throw if Cursor cancelled
        throw error;
      }
    },
    cancel() {
      isCancelled = true;
      reader.cancel();
    },
  });

  const headers = new Headers(response.headers);
  return new Response(wrappedStream, { status: response.status, headers });
}

// ── ApplyPatch format converter (safety net) ────────────────────────────
// GPT-5.4 may generate patches in standard unified diff format (--- a/ +++ b/)
// or V4A format ({operation: {type, path, diff}}) instead of Cursor's custom
// *** Add File / *** Update File / *** Delete File format. This converter
// detects the wrong format and converts it.

/**
 * Check if a patch string needs conversion.
 *
 * INVERTED LOGIC: Instead of trying to detect every possible "wrong" format
 * (unified diff, V4A, raw hunks, etc.), we check if it's ALREADY valid Cursor
 * *** format. If it's NOT in Cursor format and looks like a diff → convert.
 *
 * This catches all non-Cursor formats GPT-5.4 might generate:
 *  - Standard unified diff with `--- a/path` / `+++ b/path`
 *  - Unified diff without prefix: `--- path/to/file` / `+++ path/to/file`
 *  - Raw @@ hunks without any file headers
 *  - Any other diff-like content with -/+ lines
 */
function needsPatchFormatConversion(patch: string): boolean {
  const trimmed = patch.trim();
  if (!trimmed) return false;

  // Already in Cursor format — no conversion needed
  if (trimmed.includes("*** Begin Patch") || trimmed.includes("*** Add File:") ||
      trimmed.includes("*** Update File:") || trimmed.includes("*** Delete File:")) {
    return false;
  }

  // Standard unified diff markers (most common GPT output)
  if (trimmed.includes("--- /dev/null") || trimmed.match(/^diff --git /m)) {
    return true;
  }

  // Unified diff with or without a/ b/ prefix:
  //   "--- a/path" OR "--- path/to/file" (but NOT "--- some prose sentence")
  // We look for --- followed by +++ within a few lines (diff header pair)
  if (/^---\s+\S/m.test(trimmed) && /^\+\+\+\s+\S/m.test(trimmed)) {
    return true;
  }

  // Raw @@ hunk markers with diff content lines — this is a diff without file headers
  if (/^@@\s/m.test(trimmed) && (/^\+[^+]/m.test(trimmed) || /^-[^-]/m.test(trimmed))) {
    return true;
  }

  return false;
}

/**
 * Convert a standard unified diff or multi-file diff into Cursor's *** format.
 *
 * Handles multiple input variations GPT-5.4 may produce:
 *
 * 1. Standard unified diff with a/b prefix:
 *    diff --git a/path b/path
 *    --- a/path  OR  --- /dev/null
 *    +++ b/path
 *    @@ -N,M +N,M @@
 *
 * 2. Unified diff WITHOUT a/b prefix:
 *    --- path/to/file
 *    +++ path/to/file
 *    @@ -N,M +N,M @@
 *
 * 3. Raw @@ hunks without any file headers:
 *    @@ ... @@
 *    -removed
 *    +added
 *     context
 *
 * Output format (Cursor):
 *   *** Begin Patch
 *   *** Add File: path         (if --- /dev/null)
 *   *** Update File: path      (if existing file)
 *   *** Delete File: path      (if +++ /dev/null or deleted file mode)
 *   @@
 *   -removed
 *   +added
 *    context
 *   *** End Patch
 */
function convertUnifiedDiffToCursorFormat(diff: string): string {
  const lines = diff.split("\n");
  const outputSections: string[] = [];
  let currentPath = "";
  let currentIsNew = false;
  let currentIsDelete = false;
  let currentHunkLines: string[] = [];
  let inHunk = false;
  let hasFileHeaders = false;  // Track if we found --- / +++ headers

  function flushSection(): void {
    if (!currentPath && currentHunkLines.length === 0) return;

    if (currentIsDelete) {
      outputSections.push(`*** Delete File: ${currentPath || "unknown"}`);
    } else if (currentIsNew) {
      outputSections.push(`*** Add File: ${currentPath || "unknown"}`);
      for (const hl of currentHunkLines) {
        outputSections.push(hl);
      }
    } else {
      outputSections.push(`*** Update File: ${currentPath || "unknown"}`);
      for (const hl of currentHunkLines) {
        outputSections.push(hl);
      }
    }
    currentPath = "";
    currentIsNew = false;
    currentIsDelete = false;
    currentHunkLines = [];
    inHunk = false;
  }

  for (const line of lines) {
    // Skip "diff --git" headers, but extract path from them
    if (line.startsWith("diff --git ")) {
      flushSection();
      // Extract path from "diff --git a/path b/path"
      const match = line.match(/diff --git\s+(?:a\/)?(\S+)\s+(?:b\/)?(\S+)/);
      if (match) {
        currentPath = match[2] || match[1] || "";
      }
      continue;
    }

    // Detect deleted file mode
    if (line.startsWith("deleted file mode")) {
      currentIsDelete = true;
      continue;
    }

    // New file mode
    if (line.startsWith("new file mode")) {
      currentIsNew = true;
      continue;
    }

    // --- line: old file path
    if (line.startsWith("--- ")) {
      flushSection();
      hasFileHeaders = true;
      const path = line.substring(4).trim();
      if (path === "/dev/null" || path === "a//dev/null") {
        currentIsNew = true;
      } else {
        // Strip "a/" prefix if present (handles both "--- a/path" and "--- path")
        currentPath = path.replace(/^a\//, "");
      }
      continue;
    }

    // +++ line: new file path
    if (line.startsWith("+++ ")) {
      hasFileHeaders = true;
      const path = line.substring(4).trim();
      if (path === "/dev/null" || path === "b//dev/null") {
        currentIsDelete = true;
        // Use old path if we have it
      } else {
        // Strip "b/" prefix if present, use this as the canonical path
        currentPath = path.replace(/^b\//, "");
      }
      continue;
    }

    // @@ hunk header — simplify to just @@
    if (line.startsWith("@@ ")) {
      // If we have @@ hunks but no file headers, this is a raw diff
      // We need at least a placeholder path (will be resolved later)
      if (!hasFileHeaders && !currentPath && currentHunkLines.length === 0) {
        // Mark that we're in a headerless diff; path stays empty for now
      }
      currentHunkLines.push("@@");
      inHunk = true;
      continue;
    }

    // Bare @@ without trailing content (some models emit just "@@")
    if (line.trim() === "@@") {
      currentHunkLines.push("@@");
      inHunk = true;
      continue;
    }

    // Content lines within a hunk (or new file content)
    if (inHunk || currentIsNew) {
      if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ") || line === "") {
        currentHunkLines.push(line);
      } else if (line.startsWith("\\")) {
        // "\ No newline at end of file" — skip
        continue;
      }
      continue;
    }

    // Skip other metadata lines (index, similarity, etc.)
  }

  flushSection();

  if (outputSections.length === 0) {
    // Nothing was converted — return original
    return diff;
  }

  return "*** Begin Patch\n" + outputSections.join("\n") + "\n*** End Patch";
}

/**
 * Try to convert V4A operation JSON format to Cursor format.
 * V4A format: {callId: "...", operation: {type: "create_file"|"update_file"|"delete_file", path: "...", diff: "..."}}
 */
function convertV4AToCursorFormat(argsJson: Record<string, unknown>): string | null {
  const op = argsJson.operation as Record<string, unknown> | undefined;
  if (!op || typeof op.type !== "string") return null;

  const path = (op.path || "") as string;
  const diff = (op.diff || "") as string;

  const sections: string[] = [];

  switch (op.type) {
    case "create_file":
      sections.push(`*** Add File: ${path}`);
      // V4A create diffs have all lines starting with +
      for (const line of diff.split("\n")) {
        if (line.startsWith("@@")) {
          // Skip V4A @@ headers for create files
          continue;
        }
        sections.push(line);
      }
      break;
    case "update_file":
      sections.push(`*** Update File: ${path}`);
      for (const line of diff.split("\n")) {
        sections.push(line);
      }
      break;
    case "delete_file":
      sections.push(`*** Delete File: ${path}`);
      break;
    default:
      return null;
  }

  return "*** Begin Patch\n" + sections.join("\n") + "\n*** End Patch";
}

/**
 * Attempt to fix the ApplyPatch tool call arguments if they use the wrong format.
 * Returns the fixed arguments JSON string, or the original if no fix needed.
 */
function fixApplyPatchArgs(argsStr: string): { fixed: string; converted: boolean } {
  try {
    const args = JSON.parse(argsStr);

    // Case 1: V4A operation format from native apply_patch
    // {callId: "...", operation: {type: "create_file"|"update_file"|"delete_file", path: "...", diff: "..."}}
    if (args.operation && typeof args.operation === "object") {
      const converted = convertV4AToCursorFormat(args);
      if (converted) {
        console.log(`   [patch-fix] Converted V4A operation format → Cursor *** format`);
        return { fixed: JSON.stringify({ patch: converted }), converted: true };
      }
    }

    // Case 2: Has a "patch" field — check if it needs conversion
    if (typeof args.patch === "string" && needsPatchFormatConversion(args.patch)) {
      const converted = convertUnifiedDiffToCursorFormat(args.patch);
      console.log(`   [patch-fix] Converted non-Cursor diff (patch field) → Cursor *** format`);
      return { fixed: JSON.stringify({ ...args, patch: converted }), converted: true };
    }

    // Case 3: Has an "input" field (OpenClaw/Codex style)
    if (typeof args.input === "string" && needsPatchFormatConversion(args.input)) {
      const converted = convertUnifiedDiffToCursorFormat(args.input);
      console.log(`   [patch-fix] Converted non-Cursor diff (input field) → Cursor *** format`);
      return { fixed: JSON.stringify({ ...args, patch: converted }), converted: true };
    }

    // Case 4: Has a "diff" field (some models use this instead of "patch")
    if (typeof args.diff === "string" && needsPatchFormatConversion(args.diff)) {
      const converted = convertUnifiedDiffToCursorFormat(args.diff);
      console.log(`   [patch-fix] Converted non-Cursor diff (diff field) → Cursor *** format`);
      return { fixed: JSON.stringify({ ...args, patch: converted }), converted: true };
    }

    // Case 5: Has a "content" field (another common variant)
    if (typeof args.content === "string" && needsPatchFormatConversion(args.content)) {
      const converted = convertUnifiedDiffToCursorFormat(args.content);
      console.log(`   [patch-fix] Converted non-Cursor diff (content field) → Cursor *** format`);
      return { fixed: JSON.stringify({ ...args, patch: converted }), converted: true };
    }

  } catch (parseErr) {
    // argsStr isn't valid JSON — might be raw diff text
    console.warn(`   ⚠️  [patch-fix] ApplyPatch args are not valid JSON (${parseErr instanceof Error ? parseErr.message : "parse error"}). Length: ${argsStr.length}c. Preview: ${argsStr.substring(0, 200)}`);
    if (needsPatchFormatConversion(argsStr)) {
      const converted = convertUnifiedDiffToCursorFormat(argsStr);
      console.log(`   [patch-fix] Converted raw diff text → Cursor *** format`);
      return { fixed: JSON.stringify({ patch: converted }), converted: true };
    }
  }

  return { fixed: argsStr, converted: false };
}

// ── ApplyPatch format stream fixer ──────────────────────────────────────
// This wrapper intercepts the SSE stream and fixes ApplyPatch tool call arguments
// that use the wrong diff format before they reach Cursor.

function fixApplyPatchFormat(response: Response): Response {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream") || !response.body) {
    return response;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  // Track ongoing ApplyPatch tool calls by index
  // Key: tool call index, Value: accumulated arguments string
  const applyPatchArgs = new Map<number, string>();
  let hasApplyPatch = false;
  let readCount = 0;
  let isCancelled = false;

  // Buffer for chunks while we're accumulating ApplyPatch args
  // Once we see finish_reason, we can emit all buffered chunks (possibly modified)
  let bufferedChunks: Uint8Array[] = [];
  let bufferedTexts: string[] = [];
  let isBuffering = false;

  const wrappedStream = new ReadableStream({
    async pull(controller) {
      if (isCancelled) return;
      try {
        const { done, value } = await reader.read();
        if (isCancelled) return;
        readCount++;

        if (done) {
          // Flush any remaining buffered chunks
          if (isBuffering && bufferedChunks.length > 0) {
            emitBufferedChunks(controller);
          }
          controller.close();
          return;
        }

        const text = decoder.decode(value, { stream: true });

        // Parse SSE events to detect ApplyPatch tool calls
        const sseLines = text.split("\n");
        for (const line of sseLines) {
          if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
          try {
            const data = JSON.parse(line.substring(6));
            const delta = data?.choices?.[0]?.delta;

            // Detect tool call start with name "ApplyPatch"
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (tc.function?.name === "ApplyPatch" && tc.index != null) {
                  applyPatchArgs.set(tc.index, "");
                  hasApplyPatch = true;
                  isBuffering = true;
                  console.log(`   [patch-fix] Detected ApplyPatch tool call start (index=${tc.index})`);
                }
                // Accumulate arguments for tracked ApplyPatch calls
                if (tc.index != null && applyPatchArgs.has(tc.index) && tc.function?.arguments) {
                  applyPatchArgs.set(
                    tc.index,
                    (applyPatchArgs.get(tc.index) || "") + tc.function.arguments
                  );
                }
              }
            }

            // Check for finish_reason — time to potentially fix and emit
            const choice0 = data?.choices?.[0];
            if (choice0 && "finish_reason" in choice0 && choice0.finish_reason != null) {
              if (hasApplyPatch) {
                // Check if any accumulated args need conversion
                let needsConversion = false;
                for (const [idx, args] of applyPatchArgs) {
                  if (args.length > 0) {
                    const { converted } = fixApplyPatchArgs(args);
                    if (converted) {
                      needsConversion = true;
                      break;
                    }
                  }
                }

                if (needsConversion) {
                  // Re-emit the buffered stream with fixed args
                  console.log(`   [patch-fix] Converting ApplyPatch args in buffered stream (${bufferedChunks.length} chunks buffered)`);
                  emitFixedChunks(controller);
                  // Also emit this final chunk
                  controller.enqueue(value);
                  isBuffering = false;
                  return;
                } else if (applyPatchArgs.size > 0) {
                  // Had ApplyPatch but no conversion needed — verify format is actually correct
                  for (const [idx, args] of applyPatchArgs) {
                    if (args.length > 0) {
                      try {
                        const parsed = JSON.parse(args);
                        const patchStr = parsed.patch || parsed.input || parsed.diff || "";
                        if (typeof patchStr === "string" && patchStr.length > 0) {
                          const hasCursorFmt = patchStr.includes("*** Begin Patch") || patchStr.includes("*** Add File:") || patchStr.includes("*** Update File:");
                          if (!hasCursorFmt) {
                            console.warn(`   ⚠️  [patch-fix] ApplyPatch args (index=${idx}) passed through WITHOUT Cursor *** format and WITHOUT conversion. Patch preview: ${patchStr.substring(0, 200)}`);
                          } else {
                            console.log(`   [patch-fix] ApplyPatch args (index=${idx}) already in Cursor *** format ✓`);
                          }
                        }
                      } catch {
                        console.warn(`   ⚠️  [patch-fix] ApplyPatch args (index=${idx}) are not valid JSON — passed through raw. Preview: ${args.substring(0, 200)}`);
                      }
                    }
                  }
                }
              }
              // No conversion needed — flush buffered chunks as-is
              if (isBuffering) {
                for (const chunk of bufferedChunks) {
                  controller.enqueue(chunk);
                }
                bufferedChunks = [];
                bufferedTexts = [];
                isBuffering = false;
              }
            }
          } catch (sseParseErr) {
            // SSE line wasn't valid JSON — this is normal for partial chunks split across TCP reads
            // but we should log if we're in buffering mode as it might indicate data issues
            if (isBuffering && line.length > 10) {
              console.warn(`   ⚠️  [patch-fix] Failed to parse SSE line while buffering ApplyPatch (${line.length}c): ${line.substring(0, 100)}`);
            }
          }
        }

        if (isBuffering) {
          bufferedChunks.push(value);
          bufferedTexts.push(text);
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        if (isCancelled) return;
        // Flush any buffered chunks before re-throwing
        if (isBuffering) {
          for (const chunk of bufferedChunks) {
            controller.enqueue(chunk);
          }
        }
        throw error;
      }
    },
    cancel() {
      isCancelled = true;
      reader.cancel();
    },
  });

  function emitBufferedChunks(controller: ReadableStreamDefaultController): void {
    for (const chunk of bufferedChunks) {
      controller.enqueue(chunk);
    }
    bufferedChunks = [];
    bufferedTexts = [];
  }

  function emitFixedChunks(controller: ReadableStreamDefaultController): void {
    // Build the fixed argument strings
    const fixedArgs = new Map<number, string>();
    for (const [idx, args] of applyPatchArgs) {
      if (args.length > 0) {
        const { fixed, converted } = fixApplyPatchArgs(args);
        fixedArgs.set(idx, converted ? fixed : args);
      }
    }

    // Re-emit all buffered chunks, replacing ApplyPatch argument deltas
    const fullText = bufferedTexts.join("");
    const events = fullText.split("\n\n").filter((e) => e.trim());
    const fixedEvents: string[] = [];

    // Track how much of the fixed args we've emitted per index
    const emittedArgsForIndex = new Map<number, boolean>();

    for (const event of events) {
      if (!event.startsWith("data: ") || event === "data: [DONE]") {
        fixedEvents.push(event);
        continue;
      }

      try {
        const data = JSON.parse(event.substring(6));
        const delta = data?.choices?.[0]?.delta;

        if (delta?.tool_calls) {
          let modified = false;
          for (const tc of delta.tool_calls) {
            if (tc.index != null && fixedArgs.has(tc.index)) {
              if (tc.function?.name === "ApplyPatch" && !emittedArgsForIndex.get(tc.index)) {
                // First chunk for this tool call — emit with complete fixed args
                tc.function.arguments = fixedArgs.get(tc.index) || "";
                emittedArgsForIndex.set(tc.index, true);
                modified = true;
              } else if (tc.function?.arguments && emittedArgsForIndex.get(tc.index)) {
                // Subsequent argument delta chunks — emit with empty args (already sent)
                tc.function.arguments = "";
                modified = true;
              }
            }
          }
          if (modified) {
            fixedEvents.push("data: " + JSON.stringify(data));
            continue;
          }
        }
      } catch (fixParseErr) {
        // SSE event wasn't parseable — log it since we're actively fixing a stream
        console.warn(`   ⚠️  [patch-fix] Failed to parse SSE event during fix-up (${event.length}c): ${event.substring(0, 100)}`);
      }

      fixedEvents.push(event);
    }

    const fixedText = fixedEvents.join("\n\n") + "\n\n";
    controller.enqueue(encoder.encode(fixedText));

    bufferedChunks = [];
    bufferedTexts = [];
    console.log(`   [patch-fix] Emitted stream with fixed ApplyPatch arguments`);
  }

  const headers = new Headers(response.headers);
  return new Response(wrappedStream, { status: response.status, headers });
}

// ── Stream error wrapper ────────────────────────────────────────────────
// The openai-oauth library returns streaming responses with status 200 immediately.
// If the Codex backend returns an error (e.g., usage_limit_reached), the library
// calls controller.error() on the ReadableStream — which just abruptly kills the
// stream. Cursor sees the stream stop but gets no error message, so it looks like
// the model just silently stopped responding.
//
// This wrapper intercepts stream aborts and converts them into a proper OpenAI-format
// error response that Cursor can display to the user.

function wrapStreamWithErrorHandling(response: Response, model: string): Response {
  const contentType = response.headers.get("content-type") || "";
  const isSSE = contentType.includes("text/event-stream");

  // Only wrap SSE streaming responses
  if (!isSSE || !response.body) return response;

  const reader = response.body.getReader();
  const encoder = new TextEncoder();

  let hasReceivedData = false;
  let isClosed = false; // Guard against double-close race condition

  // Stream stall detection: if the upstream doesn't send any data for STALL_TIMEOUT_MS,
  // we close the stream with a helpful error rather than letting Cursor hang for minutes.
  const STALL_TIMEOUT_MS = 90_000; // 90 seconds — generous, but catches the 2-min hangs
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  let chunkCount = 0;

  function clearStallTimer() {
    if (stallTimer) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
  }

  function resetStallTimer(controller: ReadableStreamDefaultController) {
    clearStallTimer();
    stallTimer = setTimeout(() => {
      if (isClosed) return;
      const msg = `OpenAI stream stalled — no data received for ${STALL_TIMEOUT_MS / 1000}s after ${chunkCount} chunks. The model may be overloaded. Please retry.`;
      console.error(`\n❌ [OpenAI Codex] ${msg}`);
      const errorPayload = {
        error: { message: msg, type: "stream_timeout", code: "stream_timeout" },
      };
      try {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorPayload)}\n\ndata: [DONE]\n\n`));
        controller.close();
      } catch { /* controller may already be closed */ }
      isClosed = true;
      reader.cancel().catch(() => {});
    }, STALL_TIMEOUT_MS);
  }

  const wrappedStream = new ReadableStream({
    async pull(controller) {
      if (isClosed) return;
      try {
        // Start/reset stall timer on each pull
        resetStallTimer(controller);

        const { done, value } = await reader.read();

        clearStallTimer();

        if (done) {
          if (!isClosed) {
            isClosed = true;
            controller.close();
          }
          return;
        }
        hasReceivedData = true;
        chunkCount++;
        controller.enqueue(value);
      } catch (error: any) {
        clearStallTimer();

        // If the controller is already closed (Cursor cancelled), just log and exit
        if (isClosed) {
          console.warn(`   ⚠️  [stream-error] Stream error after controller already closed: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }

        // Stream was aborted by the library — this is where usage_limit_reached etc. end up
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`\n❌ [OpenAI Codex] Stream error intercepted: ${errorMessage}`);

        // Try to extract structured error info using multiple sources:
        // 1. The error's responseBody (Vercel AI SDK APICallError)
        // 2. The error message text
        // 3. The lastCodexError from the logger callback
        let userFacingMessage = `OpenAI error: ${errorMessage}`;
        let errorType = "api_error";

        // Source 1: Vercel AI SDK APICallError carries responseBody
        if (error?.responseBody) {
          console.error(`   responseBody: ${error.responseBody}`);
          const enhanced = parseAndEnhanceCodexError(error.responseBody, error.statusCode || 500);
          if (enhanced) {
            userFacingMessage = enhanced.message;
            errorType = enhanced.type;
          }
        }

        // Source 2: Check error message for embedded JSON or known patterns
        if (errorType === "api_error") {
          const jsonMatch = errorMessage.match(/\{[\s\S]*"error"[\s\S]*\}/);
          if (jsonMatch) {
            const enhanced = parseAndEnhanceCodexError(jsonMatch[0], 500);
            if (enhanced) {
              userFacingMessage = enhanced.message;
              errorType = enhanced.type;
            }
          } else if (errorMessage.includes("usage_limit") || errorMessage.includes("usage limit")) {
            userFacingMessage = "OpenAI usage limit reached. Switch to a Claude model or wait for the limit to reset.";
            errorType = "usage_limit_reached";
          } else if (errorMessage.includes("rate_limit")) {
            userFacingMessage = "OpenAI rate limit hit. Please wait a moment and try again.";
            errorType = "rate_limit_error";
          }
        }

        // Source 3: Recent error from the logger callback
        if (errorType === "api_error" && lastCodexError && (Date.now() - lastCodexError.timestamp) < 5000) {
          const errMsg = lastCodexError.message;
          if (errMsg.includes("usage_limit") || errMsg.includes("usage limit")) {
            userFacingMessage = "OpenAI usage limit reached. Switch to a Claude model or wait for the limit to reset.";
            errorType = "usage_limit_reached";
          }
        }

        // Build an OpenAI-format error SSE event so Cursor can display it
        const errorPayload = {
          error: {
            message: userFacingMessage,
            type: errorType,
            code: errorType,
          },
        };

        const errorSSE = `data: ${JSON.stringify(errorPayload)}\n\ndata: [DONE]\n\n`;
        try {
          if (!isClosed) {
            controller.enqueue(encoder.encode(errorSSE));
            controller.close();
            isClosed = true;
          }
        } catch (closeErr) {
          console.warn(`   ⚠️  [stream-error] Could not enqueue error SSE (controller may be closed): ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`);
        }
      }
    },
    cancel() {
      clearStallTimer();
      isClosed = true;
      reader.cancel();
    },
  });

  const headers = new Headers(response.headers);
  return new Response(wrappedStream, {
    status: response.status,
    headers,
  });
}

// ── Error parsing helper ────────────────────────────────────────────────

/**
 * Parse error bodies from the Codex backend or openai-oauth library and return
 * an enhanced, user-friendly error. Returns null if the error isn't recognized.
 *
 * Handles these scenarios:
 * 1. Direct Codex backend error: {error: {type: "usage_limit_reached", message: "...", resets_at: ...}}
 * 2. Library-wrapped error: {error: {message: "...", type: "server_error"}} where message contains the original error
 * 3. Vercel AI SDK error message with embedded responseBody
 */
function parseAndEnhanceCodexError(
  errorBody: string,
  httpStatus: number
): { message: string; type: string; status: number } | null {
  if (!errorBody) return null;

  try {
    const parsed = JSON.parse(errorBody);
    const err = parsed?.error;
    if (!err) return null;

    // Direct usage_limit_reached from Codex backend
    if (err.type === "usage_limit_reached" || err.message?.includes("usage limit")) {
      const resetsAt = err.resets_at;
      const resetTime = resetsAt ? new Date(resetsAt * 1000) : null;
      const planType = err.plan_type || "Plus";
      const message = `OpenAI usage limit reached (${planType} plan).${resetTime ? ` Resets at: ${resetTime.toLocaleString()}` : ""} Switch to a Claude model or wait for the limit to reset.`;
      console.error(`⚠️  [OpenAI Codex] Usage limit reached!${resetTime ? ` Resets at: ${resetTime.toLocaleString()}` : ""}`);
      return { message, type: "usage_limit_reached", status: 429 };
    }

    // Rate limit errors
    if (err.type === "rate_limit_error" || err.message?.includes("rate limit")) {
      return { message: `OpenAI rate limit hit. Please wait a moment and try again.`, type: "rate_limit_error", status: 429 };
    }

    // Auth errors
    if (err.type === "authentication_error" || err.message?.includes("auth") || err.message?.includes("token")) {
      return { message: `OpenAI authentication error: ${err.message}. Try running 'codex login' again.`, type: "authentication_error", status: 401 };
    }

    // Library-wrapped error: the message may contain a serialized upstream response
    if (err.type === "server_error" && typeof err.message === "string") {
      // Check if the message contains an embedded JSON error from the Codex backend
      const jsonMatch = err.message.match(/\{[\s\S]*"error"[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const innerParsed = JSON.parse(jsonMatch[0]);
          return parseAndEnhanceCodexError(JSON.stringify(innerParsed), httpStatus);
        } catch (innerParseErr) {
          console.warn(`   ⚠️  [error-parse] Failed to parse embedded error JSON: ${innerParseErr instanceof Error ? innerParseErr.message : "parse error"}`);
        }
      }

      // Check for known error strings in the message text
      if (err.message.includes("usage_limit_reached") || err.message.includes("usage limit")) {
        const resetMatch = err.message.match(/resets_at["\s:]+(\d{10,})/);
        const resetTime = resetMatch ? new Date(parseInt(resetMatch[1]) * 1000) : null;
        const planMatch = err.message.match(/plan_type["\s:]+["']?(\w+)/);
        const planType = planMatch?.[1] || "Plus";
        return {
          message: `OpenAI usage limit reached (${planType} plan).${resetTime ? ` Resets at: ${resetTime.toLocaleString()}` : ""} Switch to a Claude model or wait for the limit to reset.`,
          type: "usage_limit_reached",
          status: 429,
        };
      }

      // Pass through non-recognized library errors with the original message
      return { message: `OpenAI error: ${err.message}`, type: err.type, status: httpStatus };
    }
  } catch {
    // Not JSON — check for known patterns in raw text
    if (errorBody.includes("usage_limit_reached") || errorBody.includes("usage limit")) {
      return {
        message: "OpenAI usage limit reached. Switch to a Claude model or wait for the limit to reset.",
        type: "usage_limit_reached",
        status: 429,
      };
    }
  }

  return null;
}

// ── Text extraction helpers ─────────────────────────────────────────────

/** Extract plain text from any content format Cursor might send. */
function extractText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p: any) => p?.type === "text" || p?.type === "input_text" || p?.type === "output_text")
      .map((p: any) => p.text || "")
      .join("\n");
  }
  return String(content);
}

/** Extract user content, preserving images as structured parts. */
function extractUserContent(content: unknown): string | Array<{ type: string; text?: string; image_url?: unknown }> {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content);

  const hasImages = content.some((p: any) => p?.type === "image_url");
  if (hasImages) {
    return content.map((p: any) => {
      if (p?.type === "input_text") return { type: "text", text: p.text || "" };
      return p;
    });
  }

  // Text-only → join into string
  return content
    .filter((p: any) => p?.type === "text" || p?.type === "input_text" || p?.type === "output_text")
    .map((p: any) => p.text || "")
    .join("\n");
}

/** Extract text from function_call_output's output field. */
function extractToolOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    const text = output
      .filter((p: any) => p?.type === "input_text" || p?.type === "output_text" || p?.type === "text")
      .map((p: any) => p.text || "")
      .join("\n");
    return text || JSON.stringify(output);
  }
  return JSON.stringify(output || "");
}

// ── Normalizer ──────────────────────────────────────────────────────────

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface NormalizedMessage {
  role: string;
  content?: string | unknown[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

function normalizeCursorMessages(messages: unknown[]): NormalizedMessage[] {
  const result: NormalizedMessage[] = [];

  // We iterate through the Cursor items and merge consecutive function_call items
  // into the preceding assistant message's tool_calls array.
  // Pattern from Cursor:
  //   {role: "assistant", content: [{type: "output_text", ...}]}  ← preamble
  //   {type: "function_call", call_id, name, arguments}           ← merge into above
  //   {type: "function_call", call_id, name, arguments}           ← merge into above
  //   {type: "function_call_output", call_id, output}             ← becomes tool message
  //   {type: "function_call_output", call_id, output}             ← becomes tool message

  for (const rawMsg of messages) {
    const msg = rawMsg as Record<string, unknown>;
    const role = msg.role as string || "";
    const itemType = msg.type as string || "";

    // ── Responses API: function_call / custom_tool_call (no role) ──
    // Cursor sends both "function_call" (standard) and "custom_tool_call" (for custom tools).
    // Structure is the same except custom_tool_call uses "input" instead of "arguments".
    if (itemType === "function_call" || itemType === "custom_tool_call") {
      const tc: ToolCall = {
        id: (msg.call_id || msg.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`) as string,
        type: "function",
        function: {
          name: (msg.name || "") as string,
          arguments: typeof msg.arguments === "string"
            ? msg.arguments
            : typeof msg.input === "string"
              ? msg.input
              : JSON.stringify(msg.arguments || msg.input || {}),
        },
      };

      // Try to merge into the last assistant message
      const lastMsg = result[result.length - 1];
      if (lastMsg && lastMsg.role === "assistant") {
        if (!lastMsg.tool_calls) lastMsg.tool_calls = [];
        lastMsg.tool_calls.push(tc);
      } else {
        // No preceding assistant message — create one
        result.push({ role: "assistant", content: null, tool_calls: [tc] });
      }
      continue;
    }

    // ── Responses API: function_call_output / custom_tool_call_output (no role) ──
    // Same pattern — Cursor sends both variants.
    if (itemType === "function_call_output" || itemType === "custom_tool_call_output") {
      result.push({
        role: "tool",
        content: extractToolOutput(msg.output),
        tool_call_id: (msg.call_id || "unknown") as string,
      });
      continue;
    }

    // ── Tool messages (already OpenAI format) ──
    if (role === "tool") {
      result.push({
        role: "tool",
        content: typeof msg.content === "string" ? msg.content : extractToolOutput(msg.content),
        tool_call_id: msg.tool_call_id as string || undefined,
      });
      continue;
    }

    // ── System / developer ──
    if (role === "system" || role === "developer") {
      result.push({ role, content: extractText(msg.content) });
      continue;
    }

    // ── User messages ──
    if (role === "user") {
      const content = msg.content;

      if (Array.isArray(content)) {
        // Check for Anthropic-style tool_result blocks
        const hasToolResults = content.some((p: any) => p?.type === "tool_result");
        if (hasToolResults) {
          const textParts = content.filter((p: any) => p?.type !== "tool_result");
          const toolResultParts = content.filter((p: any) => p?.type === "tool_result");

          for (const tr of toolResultParts) {
            const trObj = tr as Record<string, unknown>;
            result.push({
              role: "tool",
              content: extractToolOutput(trObj.content),
              tool_call_id: (trObj.tool_use_id || "unknown") as string,
            });
          }

          const text = extractText(textParts);
          if (text.trim()) {
            result.push({ role: "user", content: text });
          }
        } else {
          result.push({ role: "user", content: extractUserContent(content) });
        }
      } else {
        result.push({ role: "user", content: extractText(content) });
      }
      continue;
    }

    // ── Assistant messages ──
    if (role === "assistant") {
      const content = msg.content;
      const toolCalls = msg.tool_calls as unknown[] | undefined;

      const normalizedMsg: NormalizedMessage = { role: "assistant" };
      normalizedMsg.content = extractText(content) || null;

      // Convert tool_calls if present
      if (toolCalls && Array.isArray(toolCalls) && toolCalls.length > 0) {
        normalizedMsg.tool_calls = toolCalls.map((tc: any) => ({
          id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          type: "function" as const,
          function: {
            name: tc.function?.name || tc.name || "",
            arguments: tc.function?.arguments || JSON.stringify(tc.input || {}),
          },
        }));
      }

      // Check for Anthropic-style tool_use blocks in content
      if (Array.isArray(content)) {
        const toolUseParts = content.filter((p: any) => p?.type === "tool_use");
        if (toolUseParts.length > 0) {
          if (!normalizedMsg.tool_calls) normalizedMsg.tool_calls = [];
          for (const tu of toolUseParts) {
            const tuObj = tu as Record<string, unknown>;
            normalizedMsg.tool_calls.push({
              id: (tuObj.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`) as string,
              type: "function",
              function: {
                name: (tuObj.name || "") as string,
                arguments: typeof tuObj.input === "string" ? tuObj.input : JSON.stringify(tuObj.input || {}),
              },
            });
          }
        }
      }

      result.push(normalizedMsg);
      continue;
    }

    // ── Unknown: FAIL FAST — log so we know what we're dropping ──
    if (role) {
      console.warn(`   ⚠️  [normalize] Unrecognized role="${role}" (type="${itemType}") — passing through as-is. Content preview: ${JSON.stringify(msg.content).substring(0, 200)}`);
      result.push({ role, content: extractText(msg.content) });
    } else if (itemType) {
      // Has a type but no role and didn't match function_call/function_call_output above
      console.error(`   ❌ [normalize] DROPPED message: unknown type="${itemType}" with no role. Keys: [${Object.keys(msg).join(", ")}]. This message will NOT reach the model!`);
    } else {
      // Neither role nor type — completely unrecognized
      console.error(`   ❌ [normalize] DROPPED message: no role, no type. Keys: [${Object.keys(msg).join(", ")}]. Content preview: ${JSON.stringify(msg).substring(0, 300)}. This message will NOT reach the model!`);
    }
  }

  // Sanity check: warn if normalization produced empty result from non-empty input
  if (messages.length > 0 && result.length === 0) {
    console.error(`   ❌ [normalize] CRITICAL: ${messages.length} input messages produced 0 normalized messages! The model will have NO context.`);
  }

  // Warn on suspicious patterns
  const roleStats: Record<string, number> = {};
  for (const m of result) {
    roleStats[m.role] = (roleStats[m.role] || 0) + 1;
  }
  if (result.length > 3 && !roleStats["user"] && !roleStats["tool"]) {
    console.warn(`   ⚠️  [normalize] No user or tool messages in ${result.length} normalized messages — model may lack context. Roles: ${JSON.stringify(roleStats)}`);
  }

  return result;
}

// ── ApplyPatch format instructions for GPT models ───────────────────────
// Claude models know Cursor's custom patch format natively, but GPT models don't.
// We append explicit format instructions to the ApplyPatch tool description so
// GPT-5.4 generates patches in the correct *** Add/Update/Delete File format
// that Cursor can actually apply.

const APPLY_PATCH_FORMAT_INSTRUCTIONS = `

CRITICAL: You MUST use this EXACT patch format. Do NOT use standard unified diff format (--- a/ +++ b/).

Format:
\`\`\`
*** Begin Patch
*** Add File: path/to/new_file.py
+first line of new file
+second line of new file

*** Update File: path/to/existing_file.py
@@
 context line (unchanged)
-line to remove
+line to add
 context line (unchanged)

*** Delete File: path/to/obsolete_file.py
*** End Patch
\`\`\`

Rules:
- Always wrap patches in *** Begin Patch / *** End Patch
- Use *** Add File: <path> for new files (every line starts with +)
- Use *** Update File: <path> for modifying files (use @@ hunks with - and + lines)
- Use *** Delete File: <path> for removing files
- Use @@ to start each change hunk in Update File sections
- Include a few context lines (starting with space) around changes for matching
- NEVER use --- a/path or +++ b/path headers
- Multiple files can appear in a single patch`;

/** Normalize Cursor's tool definitions to OpenAI format. */
function normalizeCursorTools(tools: unknown[], model?: string): unknown[] {
  const isGPT = model ? isOpenAIModel(model) : false;

  return tools.map((tool: any, idx: number) => {
    let normalized: any;

    if (tool.type === "function" && tool.function) {
      normalized = tool;
    } else if (tool.name) {
      normalized = {
        type: "function",
        function: {
          name: tool.name,
          description: tool.description || "",
          parameters: tool.input_schema || tool.parameters || { type: "object", properties: {} },
        },
      };
    } else {
      // FAIL FAST: unrecognized tool format — log it so we can fix
      console.error(`   ❌ [tools] Tool #${idx} has unrecognized format — passing through raw. Keys: [${Object.keys(tool).join(", ")}], type="${tool.type || "none"}". Preview: ${JSON.stringify(tool).substring(0, 300)}`);
      return tool;
    }

    // For GPT models, enhance ApplyPatch description with explicit format instructions
    if (isGPT && normalized.function?.name === "ApplyPatch") {
      normalized = {
        ...normalized,
        function: {
          ...normalized.function,
          description: (normalized.function.description || "") + APPLY_PATCH_FORMAT_INSTRUCTIONS,
        },
      };
      console.log("   [patch-fix] Enhanced ApplyPatch tool description for GPT model");
    }

    return normalized;
  });
}

// ── Main handler ────────────────────────────────────────────────────────

export async function handleOpenAICodexRequest(req: Request): Promise<Response> {
  const config = getConfig();
  const body = (await req.json()) as Record<string, unknown>;

  // Normalize messages and tools
  if (Array.isArray(body.messages)) {
    body.messages = normalizeCursorMessages(body.messages);
  }
  if (Array.isArray(body.tools)) {
    body.tools = normalizeCursorTools(body.tools, String(body.model || ""));
  }

  // Inject default reasoning_effort
  // The openai-oauth library's Zod schema only allows: "none"|"minimal"|"low"|"medium"|"high"
  // "xhigh" is NOT supported by the library — it would cause a validation error.
  // We map "xhigh" → "high" (the maximum supported value).
  const VALID_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high"]);
  const rawEffort = (body.reasoning_effort as string) || config.openaiCodexReasoningEffort || "high";
  if (!VALID_REASONING_EFFORTS.has(rawEffort)) {
    console.warn(`   ⚠️  [OpenAI Codex] reasoning_effort "${rawEffort}" not supported by openai-oauth library — mapping to "high"`);
    body.reasoning_effort = "high";
  } else {
    body.reasoning_effort = rawEffort;
  }

  // Ensure max_tokens is set — without it, the model may have a very low default output limit.
  // Cursor doesn't send max_tokens for GPT models, but the model needs headroom for tool calls
  // and extended reasoning. The Codex backend maps this to max_output_tokens in the Responses API.
  if (!body.max_tokens) {
    body.max_tokens = 16384; // Generous default for agentic tool-calling workflows
    console.log(`   [OpenAI Codex] Set max_tokens=${body.max_tokens} (Cursor didn't send one)`);
  }

  // For GPT models: if ApplyPatch tool is present, inject a developer message
  // reinforcing the correct patch format. GPT-5.4 gives high weight to developer
  // messages, making this the most reliable way to teach the format.
  if (isOpenAIModel(String(body.model || ""))) {
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const hasApplyPatch = tools.some(
      (t: any) => t.function?.name === "ApplyPatch" || t.name === "ApplyPatch"
    );
    if (hasApplyPatch && Array.isArray(body.messages)) {
      const formatMsg = {
        role: "developer",
        content:
          "IMPORTANT: When using the ApplyPatch tool, you MUST format patches with " +
          "*** Begin Patch / *** Add File: <path> / *** Update File: <path> / " +
          "*** Delete File: <path> / *** End Patch headers. " +
          "Use @@ to start each change hunk. " +
          "NEVER use standard unified diff format (--- a/ +++ b/ headers). " +
          "The patch will be REJECTED if you use the wrong format.",
      };
      // Insert after the first system/developer message, or at position 0
      const firstNonSystemIdx = body.messages.findIndex(
        (m: any) => m.role !== "system" && m.role !== "developer"
      );
      if (firstNonSystemIdx > 0) {
        (body.messages as any[]).splice(firstNonSystemIdx, 0, formatMsg);
      } else {
        (body.messages as any[]).unshift(formatMsg);
      }
      console.log("   [patch-fix] Injected developer message for ApplyPatch format");
    }
  }

  // Strip Cursor-specific fields that openai-oauth / Codex backend don't understand
  delete body.prompt_cache_retention;
  delete body.include;
  delete body.metadata;
  delete body.reasoning;
  delete body.user;

  // Log summary — always show enough to diagnose issues
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const roleCounts: Record<string, number> = {};
  for (const m of messages) {
    const r = (m as any).role || "?";
    roleCounts[r] = (roleCounts[r] || 0) + 1;
  }

  // Count tool_calls in assistant messages for loop detection
  let totalToolCalls = 0;
  const toolCallNames: Record<string, number> = {};
  for (const m of messages) {
    const msg = m as any;
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        totalToolCalls++;
        const name = tc.function?.name || "?";
        toolCallNames[name] = (toolCallNames[name] || 0) + 1;
      }
    }
  }

  console.log(`   [OpenAI Codex] Model: ${body.model}, reasoning: ${body.reasoning_effort}, stream: ${body.stream}, messages: ${messages.length} (${Object.entries(roleCounts).map(([r, c]) => `${r}:${c}`).join(" ")}), tools: ${tools.length}`);
  if (totalToolCalls > 0) {
    console.log(`   [OpenAI Codex] Tool calls in history: ${totalToolCalls} (${Object.entries(toolCallNames).map(([n, c]) => `${n}:${c}`).join(" ")})`);
  }

  // Detect potential tool call loops — if the last N tool calls are the same tool with similar args
  if (totalToolCalls >= 4) {
    const lastAssistantMsgs = messages.filter((m: any) => m.role === "assistant" && m.tool_calls?.length > 0).slice(-4);
    const lastToolNames = lastAssistantMsgs.flatMap((m: any) => m.tool_calls?.map((tc: any) => tc.function?.name) || []);
    const uniqueNames = new Set(lastToolNames);
    if (uniqueNames.size === 1 && lastToolNames.length >= 4) {
      console.warn(`   ⚠️  [OpenAI Codex] POSSIBLE TOOL CALL LOOP DETECTED: Last ${lastToolNames.length} tool calls are all "${lastToolNames[0]}". The model may be stuck.`);
    }
  }

  logger.verbose(`   [OpenAI Codex] Normalized request body:\n${JSON.stringify(body, null, 2)}`);

  // Debug logging — writes detailed request data to openai-debug.log
  const debugInfo = debugLogRequest(body);

  // Build a Request for the openai-oauth handler
  const internalRequest = new Request("http://internal/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const oauthHandler = getHandler();
  let response: Response;

  try {
    response = await oauthHandler(internalRequest);
  } catch (handlerError: any) {
    // The handler itself threw — this should be rare since createOpenAIOAuthFetchHandler
    // has its own catch, but handle it defensively.
    const msg = handlerError instanceof Error ? handlerError.message : String(handlerError);
    console.error(`\n❌ [OpenAI Codex] Handler error: ${msg}`);
    debugLogError(debugInfo, msg, handlerError?.responseBody);

    // Check if it's a Vercel AI SDK APICallError (has statusCode and responseBody)
    const statusCode = handlerError?.statusCode;
    const respBody = handlerError?.responseBody;

    if (respBody) {
      console.error(`   responseBody: ${respBody}`);
      // Try to parse and enhance known error types
      try {
        const parsed = JSON.parse(respBody);
        if (parsed?.error?.type === "usage_limit_reached") {
          const resetsAt = parsed.error.resets_at;
          const resetTime = resetsAt ? new Date(resetsAt * 1000) : null;
          const enhanced = `OpenAI usage limit reached (${parsed.error.plan_type || "Plus"} plan).${resetTime ? ` Resets at: ${resetTime.toLocaleString()}` : ""} Switch to a Claude model or wait for the limit to reset.`;
          console.error(`⚠️  [OpenAI Codex] Usage limit reached!${resetTime ? ` Resets at: ${resetTime.toLocaleString()}` : ""}`);
          return Response.json(
            { error: { message: enhanced, type: "usage_limit_reached" } },
            { status: statusCode || 429, headers: { "Access-Control-Allow-Origin": "*" } }
          );
        }
      } catch (respParseErr) {
        console.warn(`   ⚠️  [handler-error] Could not parse responseBody as JSON: ${respParseErr instanceof Error ? respParseErr.message : "parse error"}`);
      }
    }

    return Response.json(
      { error: { message: `OpenAI Codex error: ${msg}`, type: "api_error" } },
      { status: statusCode || 502, headers: { "Access-Control-Allow-Origin": "*" } }
    );
  }

  // Log non-200 responses clearly so they're visible in the proxy console
  if (!response.ok) {
    let errorBody = "";
    try {
      errorBody = await response.clone().text();
    } catch (cloneErr) {
      console.warn(`   ⚠️  [handler] Could not read error response body: ${cloneErr instanceof Error ? cloneErr.message : "read error"}`);
    }
    console.error(`\n❌ [OpenAI Codex] HTTP ${response.status} error from openai-oauth:`);
    console.error(`   responseBody: ${JSON.stringify(errorBody)}`);
    debugLogError(debugInfo, `HTTP ${response.status}`, errorBody);

    // Parse and enhance known error types for better Cursor display
    const enhanced = parseAndEnhanceCodexError(errorBody, response.status);
    if (enhanced) {
      return Response.json(
        { error: { message: enhanced.message, type: enhanced.type } },
        { status: enhanced.status, headers: { "Access-Control-Allow-Origin": "*" } }
      );
    }

    const responseHeaders = new Headers(response.headers);
    responseHeaders.set("Access-Control-Allow-Origin", "*");

    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders,
    });
  }

  debugLogResponse(debugInfo, response.status, !!body.stream);

  // Pipeline: fix finish_reason → fix ApplyPatch format → debug log → error handling
  // Each wrapper passes the stream through, potentially modifying it.

  // 1. Cursor must see finish_reason: "tool_calls" or it drops tool_calls and loops.
  let processedResponse = fixToolCallFinishReason(response);

  // 2. Convert wrong-format ApplyPatch arguments (unified diff → Cursor *** format).
  processedResponse = fixApplyPatchFormat(processedResponse);

  // 3. Debug logger sees the same bytes as Cursor (post-fix), so openai-debug.log matches reality.
  processedResponse = debugWrapStream(processedResponse, debugInfo);

  // 4. Wrap streaming responses to catch mid-stream errors (usage_limit_reached, etc.)
  processedResponse = wrapStreamWithErrorHandling(processedResponse, String(body.model));

  const responseHeaders = new Headers(processedResponse.headers);
  responseHeaders.set("Access-Control-Allow-Origin", "*");

  return new Response(processedResponse.body, {
    status: processedResponse.status,
    headers: responseHeaders,
  });
}

/**
 * Check if a model name is an OpenAI model (not Claude).
 */
export function isOpenAIModel(model: string): boolean {
  const lower = model.toLowerCase();
  return (
    lower.startsWith("gpt-") ||
    lower.startsWith("o1") ||
    lower.startsWith("o3") ||
    lower.startsWith("o4") ||
    lower.startsWith("chatgpt-")
  );
}
