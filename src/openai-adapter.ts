/**
 * OpenAI to Anthropic API adapter
 * Converts OpenAI chat completion format to/from Anthropic messages format
 */

import type { AnthropicRequest, AnthropicMessage, ContentBlock } from "./types";
import { translateToolCalls, needsTranslation } from "./tool-call-translator";
import { logger } from "./logger";

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenAIContentPart[] | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface OpenAIContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
}

export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  stop?: string | string[];
  presence_penalty?: number;
  frequency_penalty?: number;
  user?: string;
  tools?: OpenAITool[];
  tool_choice?: "none" | "auto" | "required" | { type: "function"; function: { name: string } };
}

export interface OpenAIChatResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: {
    index: number;
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason: "stop" | "length" | "content_filter" | "tool_calls" | null;
  }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface OpenAIStreamChunkToolCall {
  index: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface OpenAIStreamChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: {
    index: number;
    delta: {
      role?: "assistant";
      content?: string | null;
      tool_calls?: OpenAIStreamChunkToolCall[];
    };
    finish_reason: "stop" | "length" | "content_filter" | "tool_calls" | null;
  }[];
}

/**
 * Normalize Cursor model names to Anthropic format
 * Examples:
 * - claude-4.5-opus-high → claude-opus-4-5 (with reasoning_budget: high)
 * - claude-4.5-opus-high-thinking → claude-opus-4-5 (with reasoning_budget: high)
 * - claude-4.5-sonnet-high → claude-sonnet-4-5 (with reasoning_budget: high)
 * - claude-4.5-haiku → claude-haiku-4-5
 */
export function normalizeModelName(model: string): { model: string; reasoningBudget?: string } {
  // Handle Cursor's format: claude-4.5-{model}-{budget} or claude-4.5-{model}-{budget}-thinking
  const match = model.match(/^claude-4\.5-(opus|sonnet|haiku)(?:-(high|medium|low))?(?:-thinking)?$/);
  if (match) {
    const [, modelType, budget] = match;
    return {
      model: `claude-${modelType}-4-5`,
      reasoningBudget: budget || undefined,
    };
  }
  
  // Handle Anthropic format directly (passthrough)
  if (model.startsWith("claude-")) {
    return { model };
  }
  
  // Unknown format, passthrough
  return { model };
}

function convertContent(
  content: string | OpenAIContentPart[] | ContentBlock[]
): string | ContentBlock[] {
  if (typeof content === "string") {
    return content;
  }

  const blocks: ContentBlock[] = [];
  
  for (const part of content) {
    // Pass through Anthropic-format blocks (tool_use, tool_result) directly
    // Cursor sends these in Anthropic format, not OpenAI format
    if ((part as ContentBlock).type === "tool_use") {
      const toolUse = part as ContentBlock;
      logger.verbose(`    [convertContent] Passing through tool_use block: id=${toolUse.id}, name=${toolUse.name}`);
      blocks.push(toolUse);
      continue;
    }
    
    if ((part as ContentBlock).type === "tool_result") {
      const toolResult = part as ContentBlock;
      logger.verbose(`    [convertContent] Passing through tool_result block: tool_use_id=${toolResult.tool_use_id}`);
      blocks.push(toolResult);
      continue;
    }
    
    // Handle OpenAI format parts
    const openaiPart = part as OpenAIContentPart;
    if (openaiPart.type === "text") {
      // Only add text blocks if they have non-empty content
      if (openaiPart.text && openaiPart.text.trim().length > 0) {
        blocks.push({ type: "text", text: openaiPart.text });
      }
    } else if (openaiPart.type === "image_url" && openaiPart.image_url) {
      // Handle base64 images
      const url = openaiPart.image_url.url;
      if (url.startsWith("data:")) {
        const match = url.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          blocks.push({
            type: "image",
            source: {
              type: "base64",
              media_type: match[1] as
                | "image/jpeg"
                | "image/png"
                | "image/gif"
                | "image/webp",
              data: match[2],
            },
          });
        }
      } else {
        // Handle URL images
        blocks.push({
          type: "image",
          source: {
            type: "url",
            url: url,
          },
        });
      }
    }
  }
  
  return blocks;
}

export function openaiToAnthropic(request: OpenAIChatRequest): AnthropicRequest {
  const messages: AnthropicMessage[] = [];
  let system: string | ContentBlock[] | undefined;

  // Log incoming message summary for debugging
  logger.verbose(`\n=== OPENAI TO ANTHROPIC CONVERSION ===`);
  logger.verbose(`Total incoming messages: ${request.messages.length}`);
  for (let i = 0; i < request.messages.length; i++) {
    const msg = request.messages[i];
    const hasToolCalls = (msg as OpenAIMessage).tool_calls?.length || 0;
    const hasToolCallId = (msg as OpenAIMessage).tool_call_id || null;
    const contentPreview = typeof msg.content === "string" 
      ? msg.content.slice(0, 100) 
      : Array.isArray(msg.content) 
        ? `[${msg.content.length} parts]` 
        : String(msg.content).slice(0, 100);
    logger.verbose(`  [${i}] role=${msg.role}, tool_calls=${hasToolCalls}, tool_call_id=${hasToolCallId}, content=${contentPreview}...`);
  }

  for (const msg of request.messages) {
    if (msg.role === "system") {
      // Collect system messages
      const content =
        typeof msg.content === "string" ? msg.content : (msg.content || []).map((p) => p.text || "").join("\n");
      if (system) {
        system = typeof system === "string" ? `${system}\n${content}` : system;
      } else {
        system = content;
      }
    } else if (msg.role === "assistant") {
      // Handle assistant messages - may have tool_calls
      const contentBlocks: ContentBlock[] = [];
      
      // Add text content if present
      if (msg.content) {
        const convertedContent = convertContent(msg.content);
        if (typeof convertedContent === "string" && convertedContent.trim().length > 0) {
          contentBlocks.push({ type: "text", text: convertedContent });
        } else if (Array.isArray(convertedContent)) {
          contentBlocks.push(...convertedContent);
        }
      }
      
      // Convert tool_calls to Anthropic tool_use blocks
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        logger.verbose(`  Converting ${msg.tool_calls.length} tool_calls to tool_use blocks`);
        for (const toolCall of msg.tool_calls) {
          let input = {};
          try {
            input = JSON.parse(toolCall.function.arguments);
          } catch {
            // If arguments aren't valid JSON, wrap in object
            input = { raw: toolCall.function.arguments };
          }
          logger.verbose(`    -> tool_use: id=${toolCall.id}, name=${toolCall.function.name}, input=${JSON.stringify(input).slice(0, 200)}`);
          contentBlocks.push({
            type: "tool_use",
            id: toolCall.id,
            name: toolCall.function.name,
            input,
          });
        }
      }
      
      if (contentBlocks.length > 0) {
        messages.push({
          role: "assistant",
          content: contentBlocks,
        });
      }
    } else if (msg.role === "tool") {
      // Convert tool results to Anthropic tool_result blocks
      logger.verbose(`  Converting tool result: tool_call_id=${msg.tool_call_id}`);
      const resultContent = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      logger.verbose(`    -> tool_result content (first 500 chars): ${resultContent.slice(0, 500)}`);
      
      const toolResultContent: ContentBlock[] = [{
        type: "tool_result",
        tool_use_id: msg.tool_call_id || "",
        content: resultContent,
      }];
      
      // Check if the last message is a user message - if so, append to it
      const lastMsg = messages[messages.length - 1];
      if (lastMsg && lastMsg.role === "user" && Array.isArray(lastMsg.content)) {
        logger.verbose(`    -> Appending to existing user message`);
        lastMsg.content.push(...toolResultContent);
      } else {
        logger.verbose(`    -> Creating new user message for tool_result`);
        messages.push({
          role: "user",
          content: toolResultContent,
        });
      }
    } else if (msg.role === "user") {
      const convertedContent = convertContent(msg.content || "");
      // Skip messages with no valid content blocks
      if (typeof convertedContent === "string") {
        // String content: skip if empty
        if (convertedContent.trim().length === 0) {
          continue;
        }
      } else {
        // Array content: skip if empty after filtering
        if (convertedContent.length === 0) {
          continue;
        }
      }
      messages.push({
        role: "user",
        content: convertedContent,
      });
    }
  }
  
  // Log converted messages summary
  logger.verbose(`\nConverted to ${messages.length} Anthropic messages:`);
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (Array.isArray(msg.content)) {
      const types = msg.content.map((b: ContentBlock) => b.type).join(", ");
      logger.verbose(`  [${i}] role=${msg.role}, content=[${types}]`);
    } else {
      logger.verbose(`  [${i}] role=${msg.role}, content=${String(msg.content).slice(0, 100)}...`);
    }
  }

  // Ensure messages alternate properly (Anthropic requirement)
  // If first message isn't user, prepend an empty user message
  if (messages.length > 0 && messages[0].role !== "user") {
    messages.unshift({ role: "user", content: "Continue." });
  }

  // Normalize model name from Cursor format
  const normalized = normalizeModelName(request.model);
  
  // Determine max_tokens: use Cursor's value or default to 4096
  const maxTokens = request.max_tokens || request.max_completion_tokens || 4096;
  const maxTokensSource = request.max_tokens 
    ? "Cursor (max_tokens)" 
    : request.max_completion_tokens 
    ? "Cursor (max_completion_tokens)" 
    : "Default (4096)";
  
  console.log(`   [Debug] Normalized model: "${request.model}" → "${normalized.model}"${normalized.reasoningBudget ? ` (reasoning_budget: ${normalized.reasoningBudget})` : ""}`);
  console.log(`   [Debug] Max tokens: ${maxTokens} (${maxTokensSource})`);

  const result: AnthropicRequest = {
    model: normalized.model,
    messages,
    system,
    max_tokens: maxTokens,
    temperature: request.temperature,
    top_p: request.top_p,
    stream: request.stream,
    stop_sequences: request.stop
      ? Array.isArray(request.stop)
        ? request.stop
        : [request.stop]
      : undefined,
  };
  
  // Pass through tools - Cursor already sends them in Anthropic format
  // (name, description, input_schema) not OpenAI format (type: "function", function: {...})
  if (request.tools && request.tools.length > 0) {
    // Check if it's OpenAI format (has type: "function") or Anthropic format (has name directly)
    const firstTool = request.tools[0] as Record<string, unknown>;
    if (firstTool.type === "function" && firstTool.function) {
      // OpenAI format - convert to Anthropic
      result.tools = request.tools.map((tool) => {
        const t = tool as { type: string; function: { name: string; description?: string; parameters?: Record<string, unknown> } };
        return {
          name: t.function.name,
          description: t.function.description || "",
          input_schema: t.function.parameters || { type: "object", properties: {} },
        };
      });
    } else {
      // Already Anthropic format - pass through directly
      result.tools = request.tools as unknown as typeof result.tools;
    }
    console.log(`   [Debug] Passing ${request.tools.length} tools to Anthropic`);
  }
  
  // Pass through tool_choice - Cursor sends it in Anthropic format
  if (request.tool_choice) {
    result.tool_choice = request.tool_choice as unknown as typeof result.tool_choice;
  }
  
  // Add reasoning_budget if present (Anthropic expects it as a number or specific string)
  if (normalized.reasoningBudget) {
    result.reasoning_budget = normalized.reasoningBudget;
  }
  
  return result;
}

export function anthropicToOpenai(
  anthropicResponse: any,
  model: string
): OpenAIChatResponse {
  let content = anthropicResponse.content
    ?.map((block: any) => {
      if (block.type === "text") return block.text;
      if (block.type === "tool_use")
        return `[Tool: ${block.name}]`;
      return "";
    })
    .join("") || "";

  // Translate tool calls if present in non-streaming response
  if (needsTranslation(content)) {
    content = translateToolCalls(content);
  }

  return {
    id: `chatcmpl-${anthropicResponse.id || Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
        },
        finish_reason:
          anthropicResponse.stop_reason === "end_turn"
            ? "stop"
            : anthropicResponse.stop_reason === "max_tokens"
              ? "length"
              : "stop",
      },
    ],
    usage: {
      prompt_tokens: anthropicResponse.usage?.input_tokens || 0,
      completion_tokens: anthropicResponse.usage?.output_tokens || 0,
      total_tokens:
        (anthropicResponse.usage?.input_tokens || 0) +
        (anthropicResponse.usage?.output_tokens || 0),
    },
  };
}

export function createOpenAIStreamChunk(
  id: string,
  model: string,
  content?: string,
  finishReason?: "stop" | "length" | null
): string {
  const chunk: OpenAIStreamChunk = {
    id: `chatcmpl-${id}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: content !== undefined ? { content } : {},
        finish_reason: finishReason || null,
      },
    ],
  };

  return `data: ${JSON.stringify(chunk)}\n\n`;
}

export function createOpenAIStreamStart(id: string, model: string): string {
  const chunk: OpenAIStreamChunk = {
    id: `chatcmpl-${id}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: { role: "assistant" },
        finish_reason: null,
      },
    ],
  };

  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/**
 * Create an OpenAI tool call stream chunk
 * OpenAI streams tool calls in multiple chunks:
 * 1. First chunk has id, type, and function.name
 * 2. Subsequent chunks have function.arguments (can be streamed in parts)
 */
export function createOpenAIToolCallChunk(
  id: string,
  model: string,
  toolCallIndex: number,
  toolCallId?: string,
  functionName?: string,
  functionArgs?: string,
  finishReason?: "tool_calls" | null
): string {
  const toolCall: OpenAIStreamChunkToolCall = {
    index: toolCallIndex,
  };
  
  if (toolCallId) {
    toolCall.id = toolCallId;
    toolCall.type = "function";
  }
  
  if (functionName || functionArgs) {
    toolCall.function = {};
    if (functionName) toolCall.function.name = functionName;
    if (functionArgs) toolCall.function.arguments = functionArgs;
  }

  const chunk: OpenAIStreamChunk = {
    id: `chatcmpl-${id}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [toolCall],
        },
        finish_reason: finishReason || null,
      },
    ],
  };

  const result = `data: ${JSON.stringify(chunk)}\n\n`;
  logger.verbose(`   [EMIT TOOL CALL CHUNK] index=${toolCallIndex}, id=${toolCallId || '-'}, name=${functionName || '-'}, args=${functionArgs ? functionArgs.slice(0, 200) : '-'}, finish=${finishReason || '-'}`);
  return result;
}

export interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Parse XML tool calls from Claude Code output into structured format
 * Handles formats like:
 * - <invoke name="read_file"><parameter name="target_file">...</parameter></invoke>
 * - <search_files><path>...</path><regex>...</regex></search_files>
 * - <read_file><path>...</path></read_file>
 */
export function parseXMLToolCalls(text: string): ParsedToolCall[] {
  const toolCalls: ParsedToolCall[] = [];
  
  // Match <invoke name="...">...</invoke> format
  const invokeMatches = text.matchAll(/<invoke\s+name=["']([^"']+)["']>([\s\S]*?)<\/invoke>/gi);
  for (const match of invokeMatches) {
    const name = match[1];
    const content = match[2];
    const args: Record<string, unknown> = {};
    
    // Extract parameters
    const paramMatches = content.matchAll(/<parameter\s+name=["']([^"']+)["']>([^<]*)<\/parameter>/gi);
    for (const paramMatch of paramMatches) {
      const paramName = paramMatch[1];
      let paramValue: unknown = paramMatch[2];
      
      // Try to parse JSON values (arrays, objects)
      try {
        if (paramValue.startsWith("[") || paramValue.startsWith("{")) {
          paramValue = JSON.parse(paramValue);
        }
      } catch {
        // Keep as string
      }
      
      args[paramName] = paramValue;
    }
    
    toolCalls.push({ name, arguments: args });
  }
  
  // Match <search_files>...</search_files> format
  const searchFilesMatches = text.matchAll(/<search_files>([\s\S]*?)<\/search_files>/gi);
  for (const match of searchFilesMatches) {
    const content = match[1];
    const args: Record<string, unknown> = {};
    
    const pathMatch = content.match(/<path>([^<]*)<\/path>/i);
    const regexMatch = content.match(/<regex>([^<]*)<\/regex>/i);
    const patternMatch = content.match(/<file_pattern>([^<]*)<\/file_pattern>/i);
    
    if (pathMatch) args.path = pathMatch[1].trim();
    if (regexMatch) args.pattern = regexMatch[1].trim();
    if (patternMatch) args.glob = patternMatch[1].trim();
    
    toolCalls.push({ name: "grep", arguments: args });
  }
  
  // Match <read_file>...</read_file> format
  const readFileMatches = text.matchAll(/<read_file>([\s\S]*?)<\/read_file>/gi);
  for (const match of readFileMatches) {
    const content = match[1];
    const args: Record<string, unknown> = {};
    
    const pathMatch = content.match(/<path>([^<]*)<\/path>/i);
    const startMatch = content.match(/<start_line>(\d+)<\/start_line>/i);
    const endMatch = content.match(/<end_line>(\d+)<\/end_line>/i);
    
    if (pathMatch) args.target_file = pathMatch[1].trim();
    if (startMatch) args.offset = parseInt(startMatch[1]);
    if (endMatch && startMatch) {
      args.limit = parseInt(endMatch[1]) - parseInt(startMatch[1]) + 1;
    }
    
    toolCalls.push({ name: "read_file", arguments: args });
  }
  
  // Match <grep>...</grep> format
  const grepMatches = text.matchAll(/<grep>([\s\S]*?)<\/grep>/gi);
  for (const match of grepMatches) {
    const content = match[1];
    const args: Record<string, unknown> = {};
    
    const patternMatch = content.match(/<pattern>([^<]*)<\/pattern>/i);
    const pathMatch = content.match(/<path>([^<]*)<\/path>/i);
    
    if (patternMatch) args.pattern = patternMatch[1].trim();
    if (pathMatch) args.path = pathMatch[1].trim();
    
    toolCalls.push({ name: "grep", arguments: args });
  }
  
  return toolCalls;
}

/**
 * Check if text contains XML tool calls
 */
export function hasXMLToolCalls(text: string): boolean {
  return (
    /<invoke\s+name=/i.test(text) ||
    /<search_files>/i.test(text) ||
    /<read_file>/i.test(text) ||
    /<grep>/i.test(text)
  );
}

