/**
 * /v1/models endpoint handler
 * Returns list of available Claude and OpenAI models in OpenAI format
 */

export function handleModelsRequest(): Response {
  console.log(`\n🔍 [Models] /v1/models endpoint called at ${new Date().toISOString()}`);

  // context_window: 1M for 4.6 models (GA since March 2026), 200K for 4.5 models
  const models: any[] = [
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
  ];

  // OpenAI models — always listed, auth is auto-detected at request time.
  // If no credentials exist, the request returns a descriptive error telling
  // the user exactly what's missing (Codex login or API key).
  models.push(
      // GPT-5.4 models — 1M context
      // Default: maximum reasoning (xhigh) — "GPT-5.4 Extra High Thinking" in Cursor
      {
        id: "gpt-5.4",
        object: "model",
        created: 1741219200,
        owned_by: "openai",
        context_window: 1000000,
      },
      {
        id: "gpt-5.4-extra-high-thinking",
        object: "model",
        created: 1741219200,
        owned_by: "openai",
        context_window: 1000000,
      },
      {
        id: "gpt-5.4-xhigh",
        object: "model",
        created: 1741219200,
        owned_by: "openai",
        context_window: 1000000,
      },
      {
        id: "gpt-5.4-high",
        object: "model",
        created: 1741219200,
        owned_by: "openai",
        context_window: 1000000,
      },
      {
        id: "gpt-5.4-medium",
        object: "model",
        created: 1741219200,
        owned_by: "openai",
        context_window: 1000000,
      },
      {
        id: "gpt-5.4-thinking",
        object: "model",
        created: 1741219200,
        owned_by: "openai",
        context_window: 1000000,
      },
      // GPT-5.4 fast variant
      {
        id: "gpt-5.4-fast",
        object: "model",
        created: 1741219200,
        owned_by: "openai",
        context_window: 1000000,
      },
      // GPT-4o models
      {
        id: "gpt-4o",
        object: "model",
        created: 1700000000,
        owned_by: "openai",
        context_window: 128000,
      },
      {
        id: "gpt-4o-mini",
        object: "model",
        created: 1700000000,
        owned_by: "openai",
        context_window: 128000,
      },
      // O-series reasoning models
      {
        id: "o3",
        object: "model",
        created: 1700000000,
        owned_by: "openai",
        context_window: 200000,
      },
      {
        id: "o4-mini",
        object: "model",
        created: 1700000000,
        owned_by: "openai",
        context_window: 200000,
      },
  );

  return Response.json({
    object: "list",
    data: models,
  });
}
