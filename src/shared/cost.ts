/** Cost estimate for the panel's status line. Output tokens are not billed. */

/** USD per million input tokens for jev-latest. */
export const INPUT_USD_PER_MTOK = 0.042;

/** Estimated USD for a number of input tokens. */
export function estimateCostUsd(inputTokens: number): number {
  return (inputTokens / 1_000_000) * INPUT_USD_PER_MTOK;
}

/** Format a cost for display; sub-cent costs are the normal case, so show enough digits. */
export function formatCostUsd(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}
