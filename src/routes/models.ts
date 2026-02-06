/**
 * /v1/models endpoint handler
 * Returns list of available Claude models in OpenAI format
 */

export function handleModelsRequest(): Response {
  return Response.json({
    object: "list",
    data: [
      // Claude 4.6 models (Anthropic format)
      {
        id: "claude-opus-4-6",
        object: "model",
        created: 1738800000,
        owned_by: "anthropic",
      },
      // Claude 4.5 models (Anthropic format)
      {
        id: "claude-sonnet-4-5",
        object: "model",
        created: 1700000000,
        owned_by: "anthropic",
      },
      {
        id: "claude-opus-4-5",
        object: "model",
        created: 1700000000,
        owned_by: "anthropic",
      },
      {
        id: "claude-haiku-4-5",
        object: "model",
        created: 1700000000,
        owned_by: "anthropic",
      },
      // Cursor format models (will be normalized)
      {
        id: "claude-4.6-opus-max-thinking",
        object: "model",
        created: 1738800000,
        owned_by: "anthropic",
      },
      {
        id: "claude-4.6-opus-high",
        object: "model",
        created: 1738800000,
        owned_by: "anthropic",
      },
      {
        id: "claude-4.5-opus-high",
        object: "model",
        created: 1700000000,
        owned_by: "anthropic",
      },
      {
        id: "claude-4.5-sonnet-high",
        object: "model",
        created: 1700000000,
        owned_by: "anthropic",
      },
      {
        id: "claude-4.5-haiku",
        object: "model",
        created: 1700000000,
        owned_by: "anthropic",
      },
    ],
  });
}
