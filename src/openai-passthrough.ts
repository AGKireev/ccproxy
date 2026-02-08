/**
 * OpenAI/OpenRouter passthrough client
 * Minimal wrapper that forwards requests directly to OpenAI-compatible endpoints
 */

const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

export function isOpenAIPassthroughEnabled(): boolean {
  return !!OPENAI_API_KEY;
}

export function getOpenAIConfig() {
  return {
    baseUrl: OPENAI_BASE_URL,
    hasKey: !!OPENAI_API_KEY,
  };
}

export async function proxyOpenAIRequest(
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<Response> {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY not configured");
  }

  const url = `${OPENAI_BASE_URL}${path}`;

  const requestHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${OPENAI_API_KEY}`,
    ...headers,
  };

  // OpenRouter-specific headers
  if (OPENAI_BASE_URL.includes("openrouter")) {
    requestHeaders["HTTP-Referer"] = process.env.OPENROUTER_REFERER || "https://github.com/ccproxy";
    requestHeaders["X-Title"] = process.env.OPENROUTER_TITLE || "CCProxy";
  }

  console.log(`  → Forwarding to ${OPENAI_BASE_URL}`);

  return fetch(url, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify(body),
  });
}

