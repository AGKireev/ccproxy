/**
 * Anthropic SSE → OpenAI SSE streaming transformation
 * Converts Anthropic streaming events to OpenAI chat.completion.chunk format
 */

import {
  createOpenAIStreamChunk,
  createOpenAIStreamStart,
  createOpenAIStreamUsageChunk,
  createOpenAIToolCallChunk,
  parseXMLToolCalls,
  anthropicToOpenai,
} from "./openai-adapter";
import {
  needsTranslation,
  translateToolCalls,
} from "./tool-call-translator";
import { logger } from "./logger";

export interface StreamOptions {
  streamId: string;
  openaiModel: string;
  anthropicModel: string;
  originalTokenCount: number;
  proxyStartTime: number;
}

/**
 * Create a ReadableStream that transforms Anthropic SSE events to OpenAI SSE format.
 */
export function createAnthropicToOpenAIStream(
  response: Response,
  options: StreamOptions
): ReadableStream {
  const { streamId, openaiModel, originalTokenCount } = options;
  const reader = response.body?.getReader();

  if (!reader) {
    throw new Error("No response body");
  }

  let cancelled = false;
  let totalCharsSent = 0;

  const stream = new ReadableStream({
    async start(controller) {
      const decoder = new TextDecoder();
      let buffer = "";
      let sentStart = false;
      let toolCallBuffer = "";
      let inToolCall = false;
      let lastChunkTime = Date.now();
      const HEARTBEAT_INTERVAL = 5000;
      const KEEPALIVE_INTERVAL = 25000;
      let toolCallIndex = 0;
      let streamInputTokens = 0;
      let streamOutputTokens = 0;
      let currentToolCall: {
        id: string;
        name: string;
        inputJson: string;
      } | null = null;

      // Keepalive timer to prevent Cloudflare tunnel idle timeout
      let lastActivityTime = Date.now();
      const keepaliveTimer = setInterval(() => {
        if (cancelled) return;
        const silentMs = Date.now() - lastActivityTime;
        if (silentMs >= KEEPALIVE_INTERVAL) {
          try {
            controller.enqueue(new TextEncoder().encode(": keepalive\n\n"));
            logger.verbose(`   [Debug] Sent keepalive after ${Math.round(silentMs / 1000)}s silence`);
          } catch {
            // Controller closed
          }
        }
      }, KEEPALIVE_INTERVAL);

      const safeEnqueue = (data: Uint8Array) => {
        try {
          if (!cancelled) {
            controller.enqueue(data);
            lastActivityTime = Date.now();
            totalCharsSent += data.length;
          }
        } catch {
          cancelled = true;
        }
      };

      try {
        logger.verbose(`   [Debug] Starting to read stream...`);
        let chunkCount = 0;
        while (true) {
          if (cancelled) {
            logger.verbose(`   [Debug] Stream cancelled by client`);
            break;
          }

          const { done, value } = await reader.read();
          if (done) {
            console.log(
              `   [Debug] Stream ended after ${chunkCount} chunks`
            );
            break;
          }

          if (cancelled) break;

          chunkCount++;
          if (chunkCount === 1) {
            console.log(
              `   [Debug] First chunk received, length: ${value.length}`
            );
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (cancelled) break;
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6);
            if (data === "[DONE]") {
              safeEnqueue(new TextEncoder().encode("data: [DONE]\n\n"));
              continue;
            }

            try {
              const event = JSON.parse(data);
              if (chunkCount === 1) {
                console.log(
                  `   [Debug] First event type: ${
                    event.type
                  }, full event: ${JSON.stringify(event).substring(0, 200)}`
                );
              }

              // Handle message_start
              if (event.type === "message_start" && !sentStart) {
                if (event.message?.usage?.input_tokens) {
                  streamInputTokens = event.message.usage.input_tokens;
                  console.log(`   [Debug] Captured input_tokens from message_start: ${streamInputTokens}`);
                }

                safeEnqueue(
                  new TextEncoder().encode(
                    createOpenAIStreamStart(streamId, openaiModel)
                  )
                );
                sentStart = true;
                console.log(`   [Debug] Sent OpenAI stream start chunk`);
              }

              // Handle content_block_start
              if (event.type === "content_block_start") {
                if (!sentStart) {
                  safeEnqueue(
                    new TextEncoder().encode(
                      createOpenAIStreamStart(streamId, openaiModel)
                    )
                  );
                  sentStart = true;
                }

                const block = event.content_block;
                logger.verbose(
                  `   [Debug] content_block_start: type=${block?.type}, block=${JSON.stringify(block)}`
                );

                if (block?.type === "text" && block.text) {
                  logger.verbose(
                    `   [Debug] content_block_start text block (${block.text.length} chars): ${block.text}`
                  );
                }

                // Skip thinking blocks
                if (block?.type === "thinking" || block?.type === "redacted_thinking") {
                  console.log(`   [Debug] ${block.type} block started (not forwarded to client)`);
                  continue;
                }

                // Handle compaction blocks — Cursor's native context management
                if (block?.type === "compaction") {
                  console.log(`   [Debug] Compaction block received — forwarding to client`);
                  const content = block.content || block.text || "";
                  if (content) {
                    safeEnqueue(
                      new TextEncoder().encode(
                        createOpenAIStreamChunk(streamId, openaiModel, content)
                      )
                    );
                  }
                  continue;
                }

                // Handle tool_use blocks
                if (block?.type === "tool_use") {
                  logger.verbose(
                    `   [Debug] tool_use block started: id=${block.id}, name=${block.name}`
                  );

                  currentToolCall = {
                    id: block.id,
                    name: block.name,
                    inputJson: "",
                  };

                  safeEnqueue(
                    new TextEncoder().encode(
                      createOpenAIToolCallChunk(
                        streamId,
                        openaiModel,
                        toolCallIndex,
                        block.id,
                        block.name,
                        undefined,
                        null
                      )
                    )
                  );
                }
              }

              // Handle content_block_stop
              if (event.type === "content_block_stop") {
                logger.verbose(
                  `   [Debug] content_block_stop for index ${event.index}`
                );

                if (currentToolCall) {
                  logger.verbose(
                    `   [Debug] Finalizing tool call: ${currentToolCall.name} with args: ${currentToolCall.inputJson}`
                  );

                  if (!currentToolCall.inputJson) {
                    safeEnqueue(
                      new TextEncoder().encode(
                        createOpenAIToolCallChunk(
                          streamId,
                          openaiModel,
                          toolCallIndex,
                          undefined,
                          undefined,
                          "{}",
                          null
                        )
                      )
                    );
                  }

                  toolCallIndex++;
                  currentToolCall = null;
                }
              }

              // Handle input_json_delta for tool_use blocks
              if (
                event.type === "content_block_delta" &&
                event.delta?.type === "input_json_delta" &&
                currentToolCall
              ) {
                const jsonChunk = event.delta.partial_json || "";
                currentToolCall.inputJson += jsonChunk;
                logger.verbose(
                  `   [Debug] input_json_delta: "${jsonChunk}" (total: ${currentToolCall.inputJson.length} chars)`
                );
                if (jsonChunk) {
                  safeEnqueue(
                    new TextEncoder().encode(
                      createOpenAIToolCallChunk(
                        streamId,
                        openaiModel,
                        toolCallIndex,
                        undefined,
                        undefined,
                        jsonChunk,
                        null
                      )
                    )
                  );
                }
                continue;
              }

              // Handle compaction_delta — forward to client
              if (
                event.type === "content_block_delta" &&
                event.delta?.type === "compaction_delta"
              ) {
                const content = event.delta.content || "";
                if (content) {
                  safeEnqueue(
                    new TextEncoder().encode(
                      createOpenAIStreamChunk(streamId, openaiModel, content)
                    )
                  );
                }
                continue;
              }

              // Handle thinking_delta (log only)
              if (
                event.type === "content_block_delta" &&
                event.delta?.type === "thinking_delta"
              ) {
                logger.verbose(
                  `   [Thinking] ${event.delta.thinking?.slice(0, 200) || ""}`
                );
                continue;
              }

              // Handle signature_delta (skip)
              if (
                event.type === "content_block_delta" &&
                event.delta?.type === "signature_delta"
              ) {
                continue;
              }

              // Handle content_block_delta with text
              if (
                event.type === "content_block_delta" &&
                event.delta?.text
              ) {
                if (!sentStart) {
                  safeEnqueue(
                    new TextEncoder().encode(
                      createOpenAIStreamStart(streamId, openaiModel)
                    )
                  );
                  sentStart = true;
                }

                let text = event.delta.text;

                logger.verbose(
                  `   [Debug] content_block_delta chunk (${text.length} chars): ${JSON.stringify(text)}`
                );

                // Check for tool call markers (full tags)
                const hasToolCallMarkers =
                  /<function_calls/i.test(text) ||
                  /<invoke/i.test(text) ||
                  /<\/invoke>/i.test(text) ||
                  /<\/function_calls>/i.test(text) ||
                  /<search_files/i.test(text) ||
                  /<read_file/i.test(text) ||
                  /<\/search_files>/i.test(text) ||
                  /<\/read_file>/i.test(text) ||
                  /<grep>/i.test(text) ||
                  /<\/grep>/i.test(text);

                // Detect potential tool call starts (partial tags) — Issue #7 fix:
                // Use specific prefixes to avoid false positives with HTML tags
                const mightStartToolCall =
                  !inToolCall &&
                  (/<search_f/i.test(text) ||  // <search_files
                    /<read_f/i.test(text) ||    // <read_file
                    /<grep/i.test(text) ||      // <grep
                    /<invoke/i.test(text) ||    // <invoke
                    /<function_c/i.test(text)); // <function_calls

                if (hasToolCallMarkers) {
                  logger.verbose(
                    `   [Debug] Detected tool call markers in chunk!`
                  );
                }

                if (mightStartToolCall) {
                  logger.verbose(
                    `   [Debug] Detected potential tool call start in chunk!`
                  );
                }

                if (
                  hasToolCallMarkers ||
                  inToolCall ||
                  mightStartToolCall
                ) {
                  if (
                    !inToolCall &&
                    (mightStartToolCall || hasToolCallMarkers)
                  ) {
                    const toolCallStartMatch = text.match(/<[a-z]/i);
                    if (
                      toolCallStartMatch &&
                      toolCallStartMatch.index !== undefined
                    ) {
                      const beforeToolCall = text.substring(
                        0,
                        toolCallStartMatch.index
                      );
                      const toolCallPart = text.substring(
                        toolCallStartMatch.index
                      );

                      if (beforeToolCall) {
                        safeEnqueue(
                          new TextEncoder().encode(
                            createOpenAIStreamChunk(
                              streamId,
                              openaiModel,
                              beforeToolCall
                            )
                          )
                        );
                        logger.verbose(
                          `   [Debug] Sent text before tool call: "${beforeToolCall}"`
                        );
                      }

                      inToolCall = true;
                      toolCallBuffer = toolCallPart;
                      logger.verbose(
                        `   [Debug] Started buffering tool call: "${toolCallPart.substring(0, 50)}..."`
                      );
                    } else {
                      inToolCall = true;
                      toolCallBuffer += text;
                      logger.verbose(
                        `   [Debug] Buffering entire chunk (no split point found)`
                      );
                    }
                  } else if (inToolCall) {
                    toolCallBuffer += text;
                    logger.verbose(
                      `   [Debug] Continuing to buffer tool call, total: ${toolCallBuffer.length} chars`
                    );
                  } else {
                    inToolCall = true;
                    toolCallBuffer += text;
                  }

                  // Check if we have a complete tool call
                  let completeToolCall = "";
                  let remainingBuffer = "";

                  const openMatch = toolCallBuffer.match(
                    /<(search_files|read_file|grep|invoke|function_calls)/i
                  );
                  if (
                    openMatch &&
                    openMatch.index !== undefined &&
                    openMatch[1]
                  ) {
                    const tagName = openMatch[1];
                    const closeTag = `</${tagName}>`;

                    const closeIndex = toolCallBuffer.indexOf(
                      closeTag,
                      openMatch.index
                    );
                    if (closeIndex !== -1) {
                      completeToolCall = toolCallBuffer.substring(
                        openMatch.index,
                        closeIndex + closeTag.length
                      );
                      remainingBuffer = toolCallBuffer.substring(
                        closeIndex + closeTag.length
                      );
                    }
                  }

                  if (completeToolCall) {
                    const parsedToolCalls =
                      parseXMLToolCalls(completeToolCall);

                    toolCallBuffer = remainingBuffer;
                    if (!toolCallBuffer) {
                      inToolCall = false;
                    }

                    if (parsedToolCalls.length > 0) {
                      logger.verbose(
                        `   [Debug] Parsed ${
                          parsedToolCalls.length
                        } tool call(s) from XML:\n${JSON.stringify(
                          parsedToolCalls,
                          null,
                          2
                        )}`
                      );

                      for (const [i, tc] of parsedToolCalls.entries()) {
                        const toolCallId = `call_${Date.now()}_${i}`;

                        safeEnqueue(
                          new TextEncoder().encode(
                            createOpenAIToolCallChunk(
                              streamId,
                              openaiModel,
                              toolCallIndex,
                              toolCallId,
                              tc.name,
                              undefined,
                              null
                            )
                          )
                        );

                        safeEnqueue(
                          new TextEncoder().encode(
                            createOpenAIToolCallChunk(
                              streamId,
                              openaiModel,
                              toolCallIndex,
                              undefined,
                              undefined,
                              JSON.stringify(tc.arguments),
                              null
                            )
                          )
                        );

                        toolCallIndex++;
                      }
                    } else {
                      logger.verbose(
                        `   [Debug] Could not parse tool call, sending as text: ${completeToolCall.substring(0, 100)}...`
                      );
                      safeEnqueue(
                        new TextEncoder().encode(
                          createOpenAIStreamChunk(
                            streamId,
                            openaiModel,
                            completeToolCall
                          )
                        )
                      );
                    }
                    continue;
                  } else {
                    const timeSinceLastChunk = Date.now() - lastChunkTime;
                    if (timeSinceLastChunk > HEARTBEAT_INTERVAL) {
                      safeEnqueue(
                        new TextEncoder().encode(
                          createOpenAIStreamChunk(
                            streamId,
                            openaiModel,
                            ""
                          )
                        )
                      );
                      lastChunkTime = Date.now();
                    }
                    continue;
                  }
                }

                // Translate tool calls in text (safety check)
                if (needsTranslation(text)) {
                  const originalText = text;
                  text = translateToolCalls(text);
                  if (text !== originalText) {
                    logger.verbose(
                      `   [Debug] Translated tool call format in chunk:\n     Original (${
                        originalText.length
                      } chars):\n${originalText
                        .split("\n")
                        .map((l: string) => `       ${l}`)
                        .join("\n")}\n     Translated (${
                        text.length
                      } chars):\n${text
                        .split("\n")
                        .map((l: string) => `       ${l}`)
                        .join("\n")}`
                    );
                  }
                }

                safeEnqueue(
                  new TextEncoder().encode(
                    createOpenAIStreamChunk(streamId, openaiModel, text)
                  )
                );
                lastChunkTime = Date.now();
              }

              // Handle message_delta
              if (event.type === "message_delta") {
                if (event.usage?.output_tokens) {
                  streamOutputTokens = event.usage.output_tokens;
                  console.log(`   [Debug] Captured output_tokens from message_delta: ${streamOutputTokens}`);
                }
                continue;
              }

              // Handle message_stop
              if (event.type === "message_stop") {
                // Flush remaining tool call buffer
                if (toolCallBuffer) {
                  const parsedToolCalls = parseXMLToolCalls(toolCallBuffer);
                  if (parsedToolCalls.length > 0) {
                    for (const [i, tc] of parsedToolCalls.entries()) {
                      const toolCallId = `call_${Date.now()}_${i}`;

                      safeEnqueue(
                        new TextEncoder().encode(
                          createOpenAIToolCallChunk(
                            streamId,
                            openaiModel,
                            toolCallIndex,
                            toolCallId,
                            tc.name,
                            undefined,
                            null
                          )
                        )
                      );

                      safeEnqueue(
                        new TextEncoder().encode(
                          createOpenAIToolCallChunk(
                            streamId,
                            openaiModel,
                            toolCallIndex,
                            undefined,
                            undefined,
                            JSON.stringify(tc.arguments),
                            null
                          )
                        )
                      );

                      toolCallIndex++;
                    }
                    logger.verbose(
                      `   [Debug] Flushed final tool call buffer: ${parsedToolCalls.length} tool calls`
                    );
                  } else {
                    safeEnqueue(
                      new TextEncoder().encode(
                        createOpenAIStreamChunk(
                          streamId,
                          openaiModel,
                          toolCallBuffer
                        )
                      )
                    );
                  }
                  toolCallBuffer = "";
                  inToolCall = false;
                }

                const finishReason = toolCallIndex > 0 ? "tool_calls" : "stop";

                safeEnqueue(
                  new TextEncoder().encode(
                    createOpenAIStreamChunk(
                      streamId,
                      openaiModel,
                      undefined,
                      finishReason as "stop" | "length" | "tool_calls"
                    )
                  )
                );

                // Emit usage chunk
                const reportedPromptTokens = originalTokenCount > 0 ? originalTokenCount : streamInputTokens;
                safeEnqueue(
                  new TextEncoder().encode(
                    createOpenAIStreamUsageChunk(
                      streamId,
                      openaiModel,
                      reportedPromptTokens,
                      streamOutputTokens
                    )
                  )
                );
                console.log(`   [Usage] Streaming usage: prompt_tokens=${reportedPromptTokens} (original=${originalTokenCount}, anthropic=${streamInputTokens}), completion_tokens=${streamOutputTokens}`);

                safeEnqueue(
                  new TextEncoder().encode("data: [DONE]\n\n")
                );
                logger.verbose(
                  `   [Debug] Sent [DONE] chunk with finish_reason: ${finishReason}`
                );
              }
            } catch (parseError) {
              if (!cancelled) {
                console.log(
                  `   [Debug] Failed to parse event: ${parseError}`
                );
              }
            }
          }
        }
      } catch (streamError) {
        if (!cancelled) {
          console.error(
            `   [Error] Stream processing failed: ${streamError}`
          );
          try {
            controller.error(streamError);
          } catch {
            // Controller already closed
          }
        }
      } finally {
        clearInterval(keepaliveTimer);

        try {
          if (!cancelled) {
            reader.cancel().catch(() => {});
          }
        } catch {
          // Reader already released
        }

        try {
          if (!cancelled) {
            controller.close();
          }
        } catch {
          // Controller already closed
        }
      }
    },
    cancel(reason) {
      logger.verbose(
        `   [Debug] Stream cancelled by client: ${reason} (sent ${totalCharsSent} chars so far)`
      );
      cancelled = true;
      reader.cancel(reason).catch(() => {});
    },
  });

  return stream;
}

/**
 * Handle non-streaming OpenAI response conversion
 */
export async function handleNonStreamingResponse(
  response: Response,
  openaiModel: string,
  originalTokenCount: number,
  responseHeaders: Headers
): Promise<Response> {
  if (!response.ok) {
    const error = (await response.json()) as {
      error?: { message?: string; type?: string };
    };
    let errorMessage = error?.error?.message || "Unknown error";
    if (errorMessage.includes("model:")) {
      errorMessage = errorMessage.replace(
        /model:\s*x-([^\s,]+)/g,
        (_match, modelName) => `model: ${modelName}`
      );
    }
    return Response.json(
      {
        error: {
          message: errorMessage,
          type: error?.error?.type,
        },
      },
      { status: response.status, headers: responseHeaders }
    );
  }

  const anthropicResponse = await response.json();
  const openaiResponse = anthropicToOpenai(anthropicResponse, openaiModel);

  // Override prompt_tokens with pre-summarization count so Cursor sees actual context size
  if (originalTokenCount > 0 && openaiResponse.usage) {
    openaiResponse.usage.prompt_tokens = originalTokenCount;
    openaiResponse.usage.total_tokens = originalTokenCount + openaiResponse.usage.completion_tokens;
    console.log(`   [Usage] Non-streaming usage override: prompt_tokens=${originalTokenCount}, completion_tokens=${openaiResponse.usage.completion_tokens}`);
  }

  return Response.json(openaiResponse, { headers: responseHeaders });
}
