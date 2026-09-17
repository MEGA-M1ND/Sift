/**
 * Scoring a page of reviews.
 *
 * One request per review carrying every active question, as the spec requires:
 * never several reviews concatenated into one state. Cached answers are
 * subtracted first, so a request asks only what is genuinely unknown, and a
 * fully cached review makes no request at all.
 *
 * Concurrency is the client's job; this fires everything and lets the gate hold
 * it at eight in flight.
 */
import type { Questions } from "@typesafe-ai/sdk";
import type { SiftClient } from "./client.js";
import type { AnswerCache, CachedAnswer } from "./cache.js";
import { buildQuestions, toQuestionsObject, type ActiveFilters, type BuiltQuestion } from "../questions/buildQuestions.js";
import { estimateCostUsd } from "../shared/cost.js";
import { toState, type ProductContext, type Review, type ScoreFailed } from "../shared/types.js";
import type { AnswerMap } from "../questions/combine.js";

export interface PageSummary {
  reviews: number;
  /** Reviews with at least one usable answer. */
  scored: number;
  /** Reviews we gave up on; they render as "unscored". */
  unscored: number;
  /** Reviews answered entirely from cache, costing nothing. */
  fullyCached: number;
  cacheHits: number;
  cacheMisses: number;
  requests: number;
  inputTokens: number;
  estimatedCostUsd: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  wallMs: number;
  /** Failure reasons seen, with counts, for the panel's one status line. */
  failures: Partial<Record<ScoreFailed["reason"], number>>;
}

export interface ScorePageResult {
  /** Answers per review id. Reviews with no answers at all are absent. */
  answers: Map<string, AnswerMap>;
  summary: PageSummary;
}

export interface ScorePageOptions {
  product: ProductContext;
  reviews: readonly Review[];
  active: ActiveFilters;
  client: SiftClient;
  cache: AnswerCache;
  /** Called as each review resolves, so the UI can paint progressively. */
  onReviewScored?: (reviewId: string, answers: AnswerMap) => void;
  signal?: AbortSignal;
}

function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[index] ?? 0;
}

/** Score every review against every active filter. Never throws. */
export async function scorePage(options: ScorePageOptions): Promise<ScorePageResult> {
  const { product, reviews, active, client, cache } = options;
  const started = Date.now();

  // The cache's counters are lifetime totals; this summary is per page, so
  // snapshot them and report the delta.
  const hitsBefore = cache.hits;
  const missesBefore = cache.misses;

  const built = buildQuestions(active);
  const answers = new Map<string, AnswerMap>();
  const failures: Partial<Record<ScoreFailed["reason"], number>> = {};
  const latencies: number[] = [];

  let requests = 0;
  let inputTokens = 0;
  let scored = 0;
  let unscored = 0;
  let fullyCached = 0;

  if (built.length === 0) {
    return {
      answers,
      summary: {
        reviews: reviews.length,
        scored: 0,
        unscored: 0,
        fullyCached: 0,
        cacheHits: 0,
        cacheMisses: 0,
        requests: 0,
        inputTokens: 0,
        estimatedCostUsd: 0,
        p50LatencyMs: 0,
        p95LatencyMs: 0,
        wallMs: Date.now() - started,
        failures,
      },
    };
  }

  const scoreOne = async (review: Review): Promise<void> => {
    if (options.signal?.aborted) return;

    const cached = await cache.getMany(
      built.map((question) => ({ reviewId: review.id, questionText: question.text, key: question.key })),
    );

    const merged: AnswerMap = {};
    for (const [key, answer] of cached) merged[key] = answer;

    const missing: BuiltQuestion[] = built.filter((question) => !cached.has(question.key));
    if (missing.length === 0) {
      fullyCached += 1;
      scored += 1;
      answers.set(review.id, merged);
      options.onReviewScored?.(review.id, merged);
      return;
    }

    const questions: Questions = toQuestionsObject(missing);
    requests += 1;
    const result = await client.score(
      toState(product, review),
      questions,
      options.signal ? { signal: options.signal } : undefined,
    );
    latencies.push(result.latencyMs);

    if (!result.ok) {
      failures[result.reason] = (failures[result.reason] ?? 0) + 1;
      // Partial answers from the cache are still worth showing.
      if (Object.keys(merged).length > 0) {
        scored += 1;
        answers.set(review.id, merged);
        options.onReviewScored?.(review.id, merged);
      } else {
        unscored += 1;
      }
      return;
    }

    inputTokens += result.usage.input_tokens;

    const toStore: Array<{ reviewId: string; questionText: string; answer: CachedAnswer }> = [];
    for (const question of missing) {
      const answer = (result.answers as Record<string, CachedAnswer | undefined>)[question.key];
      if (!answer) continue;
      merged[question.key] = answer;
      toStore.push({ reviewId: review.id, questionText: question.text, answer });
    }
    if (toStore.length > 0) await cache.putMany(toStore);

    scored += 1;
    answers.set(review.id, merged);
    options.onReviewScored?.(review.id, merged);
  };

  // The client's semaphore caps concurrency, so queue everything at once.
  await Promise.all(reviews.map((review) => scoreOne(review)));

  latencies.sort((a, b) => a - b);

  return {
    answers,
    summary: {
      reviews: reviews.length,
      scored,
      unscored,
      fullyCached,
      cacheHits: cache.hits - hitsBefore,
      cacheMisses: cache.misses - missesBefore,
      requests,
      inputTokens,
      estimatedCostUsd: estimateCostUsd(inputTokens),
      p50LatencyMs: percentile(latencies, 0.5),
      p95LatencyMs: percentile(latencies, 0.95),
      wallMs: Date.now() - started,
      failures,
    },
  };
}

/** The per-page console summary the spec asks for. */
export function logSummary(summary: PageSummary): void {
  const failureText = Object.entries(summary.failures)
    .map(([reason, count]) => `${reason}=${count}`)
    .join(" ");
  console.info(
    `[Sift] ${summary.scored}/${summary.reviews} scored` +
      (summary.unscored > 0 ? `, ${summary.unscored} unscored` : "") +
      ` | cache ${summary.cacheHits} hit / ${summary.cacheMisses} miss` +
      (summary.fullyCached > 0 ? ` (${summary.fullyCached} reviews free)` : "") +
      ` | ${summary.requests} requests, ${summary.inputTokens} input tokens` +
      ` | ~$${summary.estimatedCostUsd.toFixed(4)}` +
      ` | p50 ${summary.p50LatencyMs}ms p95 ${summary.p95LatencyMs}ms` +
      ` | ${summary.wallMs}ms wall` +
      (failureText ? ` | failures: ${failureText}` : ""),
  );
}
