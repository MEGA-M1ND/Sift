/**
 * Shared types. The state shape here is what every scoring request carries;
 * it is deliberately one review per request (never a batch), so question text
 * can reference `review.body` and `review.title` unambiguously.
 */
import type { Questions, ResultFor, Usage } from "@typesafe-ai/sdk";

/** A single review scraped from the page. */
export type Review = {
  /** Amazon's own review id, used as the stable cache key. */
  id: string;
  title: string;
  body: string;
  /** Stars, 1-5. `null` when the card renders without a rating. */
  rating: number | null;
  verified_purchase: boolean;
  /** ISO date (YYYY-MM-DD) when parseable, else the raw string. */
  date: string | null;
  helpful_votes: number;
}

/** Product context sent alongside every review. */
export type ProductContext = {
  title: string;
  category: string | null;
}

/** Exactly the JSON posted as `state` for one review. */
export type ReviewState = {
  product: ProductContext;
  review: Omit<Review, "id">;
};

/** Build the request state for one review. Drops the id: it is a cache key, not evidence. */
export function toState(product: ProductContext, review: Review): ReviewState {
  const { id: _id, ...rest } = review;
  return { product, review: rest };
}

/** A successful scoring call for one review. */
export interface ScoreOk<Q extends Questions> {
  ok: true;
  answers: { [K in keyof Q]: ResultFor<Q[K]> };
  usage: Usage;
  latencyMs: number;
  attempts: number;
}

/**
 * A failed scoring call. The review is rendered "unscored"; the page never breaks.
 * `reason` is for the console summary and the panel's single status line.
 */
export interface ScoreFailed {
  ok: false;
  reason: "rate_limited" | "server_error" | "bad_request" | "auth" | "blocked" | "network" | "aborted" | "unknown";
  message: string;
  latencyMs: number;
  attempts: number;
}

export type ScoreResult<Q extends Questions> = ScoreOk<Q> | ScoreFailed;
