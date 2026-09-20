/** Cost estimate for the panel's status line. Output tokens are not billed. */

/** USD per million input tokens for jev-latest. */
export const INPUT_USD_PER_MTOK = 0.042;

/** Estimated USD for a number of input tokens. */
export function estimateCostUsd(inputTokens: number): number {
  return (inputTokens / 1_000_000) * INPUT_USD_PER_MTOK;
}

/**
 * Format a cost for display; sub-cent costs are the normal case, so show enough
 * digits.
 *
 * Anything smaller than the smallest figure four decimals can show becomes
 * "<$0.0001" rather than "$0.0000", which would read as free.
 */
export function formatCostUsd(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.0001) return "<$0.0001";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * Characters per token, for estimating a request's size before sending it.
 *
 * Calibrated against real `usage.input_tokens` from the API: a 1,800-character
 * request came back as roughly 450 tokens. This is an estimate for a spend
 * warning, never for billing. The figure reported after a run is the real one
 * the API returned.
 */
export const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
