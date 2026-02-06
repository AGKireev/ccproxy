/**
 * /v1/messages endpoint handler
 * Proxies Anthropic Messages API requests
 */

import { manageContext } from "../context-manager";
import { proxyRequest } from "../anthropic-client";
import type { AnthropicRequest, AnthropicError } from "../types";
import { logRequestDetails, extractHeaders, extractAPIKey } from "../server";

export async function handleAnthropicRequest(req: Request): Promise<Response> {
  try {
    logRequestDetails(req, "Anthropic /v1/messages");
    const body = (await req.json()) as AnthropicRequest;
    const headers = extractHeaders(req);

    // Check if user provided their own API key
    const userAPIKey = extractAPIKey(req);
    if (userAPIKey) {
      console.log(`\n🔑 Using user-provided API key from request`);
    }

    console.log(
      `\n→ Model: "${body.model}" | ${
        body.stream ? "stream" : "sync"
      } | max_tokens=${body.max_tokens}`
    );

    const { request: managedBody } = await manageContext(body);
    const response = await proxyRequest(
      "/v1/messages",
      managedBody,
      headers,
      userAPIKey || undefined
    );

    const responseHeaders = new Headers(response.headers);
    responseHeaders.set("Access-Control-Allow-Origin", "*");

    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error("Request handling error:", error);
    return Response.json(
      {
        type: "error",
        error: { type: "invalid_request_error", message: String(error) },
      } satisfies AnthropicError,
      { status: 400 }
    );
  }
}
