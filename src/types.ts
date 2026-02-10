export interface ClaudeCredentials {
  claudeAiOauth: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes: string[];
  };
}

export interface TokenInfo {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  isExpired: boolean;
}

export interface TokenRefreshResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface ContentBlock {
  type: "text" | "image" | "tool_use" | "tool_result" | "compaction";
  text?: string;
  source?: ImageSource;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | ContentBlock[];
  cache_control?: { type: string; ttl?: number };
}

export interface ImageSource {
  type: "base64" | "url";
  media_type?: string;
  data?: string;
  url?: string;
}

export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string | ContentBlock[];
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stream?: boolean;
  stop_sequences?: string[];
  metadata?: { user_id?: string };
  tools?: Tool[];
  tool_choice?: ToolChoice;
  reasoning_budget?: number | string;
  thinking?:
    | { type: "enabled"; budget_tokens: number }
    | { type: "adaptive" };
  context_management?: {
    edits: Array<{
      type: string;
      trigger?: { type: string; value: number };
      keep?: { type: string; value: number } | string;
      pause_after_compaction?: boolean;
      instructions?: string;
      clear_at_least?: { type: string; value: number };
      exclude_tools?: string[];
      clear_tool_inputs?: boolean;
    }>;
  };
  effort?: string;
}

export interface Tool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolChoice {
  type: "auto" | "any" | "tool";
  name?: string;
}

export interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: ContentBlock[];
  model: string;
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface AnthropicError {
  type: "error";
  error: {
    type: string;
    message: string;
  };
}

export interface ProxyConfig {
  port: number;
  claudeCodeFirst: boolean;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  openaiBaseUrl: string;
  allowedIPs: string[];
  compactionEnabled: boolean;
  compactionTriggerTokens: number;
  tokenInflationEnabled: boolean;
}
