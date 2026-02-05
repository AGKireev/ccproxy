/**
 * Anthropic model pricing (USD per million tokens)
 * Note: Prompt caching can significantly reduce actual costs,
 * so these estimates represent maximum potential cost.
 */

export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

// Pricing as of early 2026
const MODEL_PRICING: Record<string, ModelPricing> = {
  // Opus 4.x
  "claude-opus-4-6": { inputPerMTok: 5.0, outputPerMTok: 25.0 },
  "claude-opus-4-5": { inputPerMTok: 5.0, outputPerMTok: 25.0 },
  "claude-opus-4-1": { inputPerMTok: 15.0, outputPerMTok: 75.0 },
  "claude-opus-4": { inputPerMTok: 15.0, outputPerMTok: 75.0 },

  // Sonnet 4.x
  "claude-sonnet-4-5": { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  "claude-sonnet-4": { inputPerMTok: 3.0, outputPerMTok: 15.0 },

  // Haiku 4.x
  "claude-haiku-4-5": { inputPerMTok: 1.0, outputPerMTok: 5.0 },

  // Claude 3.5 (legacy)
  "claude-3-5-sonnet": { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  "claude-3-5-haiku": { inputPerMTok: 0.8, outputPerMTok: 4.0 },

  // Claude 3 (legacy)
  "claude-3-opus": { inputPerMTok: 15.0, outputPerMTok: 75.0 },
  "claude-3-sonnet": { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  "claude-3-haiku": { inputPerMTok: 0.25, outputPerMTok: 1.25 },
};

// Default pricing for unknown models (use Sonnet pricing as safe default)
const DEFAULT_PRICING: ModelPricing = { inputPerMTok: 3.0, outputPerMTok: 15.0 };

/**
 * Get pricing for a model by matching the model family
 * e.g., "claude-sonnet-4-20250514" matches "claude-sonnet-4"
 */
export function getModelPricing(modelId: string): ModelPricing {
  // Try exact match first
  if (MODEL_PRICING[modelId]) {
    return MODEL_PRICING[modelId];
  }

  // Try matching by prefix (remove date suffix)
  for (const [pattern, pricing] of Object.entries(MODEL_PRICING)) {
    if (modelId.startsWith(pattern)) {
      return pricing;
    }
  }

  return DEFAULT_PRICING;
}

/**
 * Calculate estimated cost for a request
 * Note: This is an estimate - actual cost may be lower due to prompt caching
 */
export function calculateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number
): number {
  const pricing = getModelPricing(modelId);
  const inputCost = (inputTokens / 1_000_000) * pricing.inputPerMTok;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPerMTok;
  return inputCost + outputCost;
}

/**
 * Format cost as USD string
 */
export function formatCost(cost: number): string {
  if (cost < 0.01) {
    return `$${(cost * 100).toFixed(4)}¢`;
  }
  return `$${cost.toFixed(4)}`;
}

