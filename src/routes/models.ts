/**
 * /v1/models endpoint handler
 * Returns list of available Claude models in OpenAI format
 */

export function handleModelsRequest(): Response {
  console.log(`\n🔍 [Models] /v1/models endpoint called at ${new Date().toISOString()}`);
  // context_window: 1M for 4.6 models (GA since March 2026), 200K for 4.5 models
  return Response.json({
    object: "list",
    data: [
      // Claude 4.6 models (Anthropic format) — 1M context GA
      {
        id: "claude-opus-4-6",
        object: "model",
        created: 1738800000,
        owned_by: "anthropic",
        context_window: 1000000,
      },
      // Claude 4.5 models (Anthropic format) — 200K context
      {
        id: "claude-sonnet-4-5",
        object: "model",
        created: 1700000000,
        owned_by: "anthropic",
        context_window: 200000,
      },
      {
        id: "claude-opus-4-5",
        object: "model",
        created: 1700000000,
        owned_by: "anthropic",
        context_window: 200000,
      },
      {
        id: "claude-haiku-4-5",
        object: "model",
        created: 1700000000,
        owned_by: "anthropic",
        context_window: 200000,
      },
      // Cursor format models (will be normalized)
      {
        id: "claude-4.6-opus-max-thinking",
        object: "model",
        created: 1738800000,
        owned_by: "anthropic",
        context_window: 1000000,
      },
      {
        id: "claude-4.6-opus-high",
        object: "model",
        created: 1738800000,
        owned_by: "anthropic",
        context_window: 1000000,
      },
      {
        id: "claude-4.5-opus-high",
        object: "model",
        created: 1700000000,
        owned_by: "anthropic",
        context_window: 200000,
      },
      {
        id: "claude-4.5-sonnet-high",
        object: "model",
        created: 1700000000,
        owned_by: "anthropic",
        context_window: 200000,
      },
      {
        id: "claude-4.5-haiku",
        object: "model",
        created: 1700000000,
        owned_by: "anthropic",
        context_window: 200000,
      },
    ],
  });
}
