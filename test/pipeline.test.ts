// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { Questions } from "@typesafe-ai/sdk";
import { AnswerCache, MemoryStorage } from "../src/background/cache.js";
import type { SiftClient } from "../src/background/client.js";
import { scorePage } from "../src/background/pipeline.js";
import { buildQuestions, customKey, USEFULNESS_KEY } from "../src/questions/buildQuestions.js";
import type { ActiveFilters } from "../src/questions/buildQuestions.js";
import type { ProductContext, Review, ScoreResult } from "../src/shared/types.js";

const PRODUCT: ProductContext = { title: "Cordless drill", category: "Tools" };

function review(id: string): Review {
  return {
    id,
    title: `Title ${id}`,
    body: `Body ${id}`,
    rating: 4,
    verified_purchase: true,
    date: "2026-03-04",
    helpful_votes: 3,
  };
}

const ACTIVE: ActiveFilters = { custom: [{ id: "f1", text: "battery dies within a year" }], presets: [] };

/**
 * A stand-in for SiftClient that answers every question it is asked and records
 * the calls. Structurally typed, so no network and no SDK involved.
 */
function fakeClient(options: { fail?: (reviewBody: string) => boolean; inputTokens?: number } = {}) {
  const calls: Array<{ body: string; questionKeys: string[] }> = [];
  const client = {
    async score(state: { review: { body: string } }, questions: Questions): Promise<ScoreResult<Questions>> {
      const keys = Object.keys(questions);
      calls.push({ body: state.review.body, questionKeys: keys });
      if (options.fail?.(state.review.body)) {
        return { ok: false, reason: "server_error", message: "boom", latencyMs: 12, attempts: 4 };
      }
      const answers: Record<string, unknown> = {};
      for (const key of keys) {
        answers[key] =
          key === USEFULNESS_KEY
            ? { type: "score", score: 1.5, confidence: 0.8, legend: {}, probabilities: {} }
            : { type: "noul", noul: 0.82 };
      }
      return {
        ok: true,
        answers: answers as never,
        usage: { input_tokens: options.inputTokens ?? 100, output_tokens: 0 },
        latencyMs: 90,
        attempts: 1,
      };
    },
  };
  return { client: client as unknown as SiftClient, calls };
}

describe("scorePage", () => {
  it("sends exactly one request per review, never a batch", async () => {
    const { client, calls } = fakeClient();
    const reviews = [review("R1"), review("R2"), review("R3")];
    const result = await scorePage({
      product: PRODUCT,
      reviews,
      active: ACTIVE,
      client,
      cache: new AnswerCache(new MemoryStorage()),
    });

    expect(calls).toHaveLength(3);
    expect(calls.map((c) => c.body).sort()).toEqual(["Body R1", "Body R2", "Body R3"]);
    // Each request carries one review's state only.
    for (const call of calls) expect(call.body).not.toContain("Body R2Body");
    expect(result.summary.requests).toBe(3);
    expect(result.summary.scored).toBe(3);
  });

  it("asks every active question in one request per review", async () => {
    const { client, calls } = fakeClient();
    const active: ActiveFilters = {
      custom: [{ id: "f1", text: "battery" }, { id: "f2", text: "noisy" }],
      presets: ["fake"],
    };
    await scorePage({
      product: PRODUCT,
      reviews: [review("R1")],
      active,
      client,
      cache: new AnswerCache(new MemoryStorage()),
    });

    expect(calls).toHaveLength(1);
    // 2 custom + 3 fake signals + usefulness.
    expect(calls[0]!.questionKeys).toHaveLength(6);
    expect(calls[0]!.questionKeys).toContain("preset:fake:free_or_discounted");
    expect(calls[0]!.questionKeys).toContain(USEFULNESS_KEY);
  });

  it("makes no request at all when every answer is cached", async () => {
    const storage = new MemoryStorage();
    const cache = new AnswerCache(storage);
    const built = buildQuestions(ACTIVE);
    await cache.putMany(
      built.map((question) => ({
        reviewId: "R1",
        questionText: question.text,
        answer:
          question.key === USEFULNESS_KEY
            ? ({ type: "score", score: 2, confidence: 0.9, legend: {}, probabilities: {} } as never)
            : ({ type: "noul", noul: 0.77 } as never),
      })),
    );

    const { client, calls } = fakeClient();
    const result = await scorePage({
      product: PRODUCT,
      reviews: [review("R1")],
      active: ACTIVE,
      client,
      cache,
    });

    expect(calls).toHaveLength(0);
    expect(result.summary.requests).toBe(0);
    expect(result.summary.fullyCached).toBe(1);
    expect(result.summary.inputTokens).toBe(0);
    expect(result.summary.estimatedCostUsd).toBe(0);
    expect(result.answers.get("R1")?.[customKey("f1")]).toEqual({ type: "noul", noul: 0.77 });
  });

  it("asks only the questions that are not cached", async () => {
    const cache = new AnswerCache(new MemoryStorage());
    const built = buildQuestions(ACTIVE);
    const usefulness = built.find((q) => q.key === USEFULNESS_KEY)!;
    await cache.putMany([
      {
        reviewId: "R1",
        questionText: usefulness.text,
        answer: { type: "score", score: 2, confidence: 0.9, legend: {}, probabilities: {} } as never,
      },
    ]);

    const { client, calls } = fakeClient();
    await scorePage({ product: PRODUCT, reviews: [review("R1")], active: ACTIVE, client, cache });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.questionKeys).toEqual([customKey("f1")]);
  });

  it("caches answers so a second pass is free", async () => {
    const cache = new AnswerCache(new MemoryStorage());
    const first = fakeClient();
    await scorePage({ product: PRODUCT, reviews: [review("R1")], active: ACTIVE, client: first.client, cache });
    expect(first.calls).toHaveLength(1);

    const second = fakeClient();
    const result = await scorePage({
      product: PRODUCT,
      reviews: [review("R1")],
      active: ACTIVE,
      client: second.client,
      cache,
    });
    expect(second.calls).toHaveLength(0);
    expect(result.summary.fullyCached).toBe(1);
  });

  it("keeps scoring the page when one review fails", async () => {
    const { client } = fakeClient({ fail: (body) => body === "Body R2" });
    const result = await scorePage({
      product: PRODUCT,
      reviews: [review("R1"), review("R2"), review("R3")],
      active: ACTIVE,
      client,
      cache: new AnswerCache(new MemoryStorage()),
    });

    expect(result.summary.scored).toBe(2);
    expect(result.summary.unscored).toBe(1);
    expect(result.summary.failures.server_error).toBe(1);
    expect(result.answers.has("R1")).toBe(true);
    expect(result.answers.has("R2")).toBe(false);
    expect(result.answers.has("R3")).toBe(true);
  });

  it("still shows cached answers for a review whose request fails", async () => {
    const cache = new AnswerCache(new MemoryStorage());
    const built = buildQuestions(ACTIVE);
    const custom = built.find((q) => q.key === customKey("f1"))!;
    await cache.putMany([
      { reviewId: "R1", questionText: custom.text, answer: { type: "noul", noul: 0.9 } as never },
    ]);

    const { client } = fakeClient({ fail: () => true });
    const result = await scorePage({ product: PRODUCT, reviews: [review("R1")], active: ACTIVE, client, cache });

    expect(result.summary.scored).toBe(1);
    expect(result.summary.unscored).toBe(0);
    expect(result.answers.get("R1")?.[customKey("f1")]).toEqual({ type: "noul", noul: 0.9 });
  });

  it("totals tokens and cost from real usage", async () => {
    const { client } = fakeClient({ inputTokens: 250 });
    const result = await scorePage({
      product: PRODUCT,
      reviews: [review("R1"), review("R2")],
      active: ACTIVE,
      client,
      cache: new AnswerCache(new MemoryStorage()),
    });

    expect(result.summary.inputTokens).toBe(500);
    // 500 tokens at $0.042 per million.
    expect(result.summary.estimatedCostUsd).toBeCloseTo(0.000021, 9);
  });

  it("reports latency percentiles", async () => {
    const { client } = fakeClient();
    const result = await scorePage({
      product: PRODUCT,
      reviews: [review("R1"), review("R2")],
      active: ACTIVE,
      client,
      cache: new AnswerCache(new MemoryStorage()),
    });
    expect(result.summary.p50LatencyMs).toBe(90);
    expect(result.summary.p95LatencyMs).toBe(90);
  });

  it("reports progress as each review resolves, for progressive painting", async () => {
    const { client } = fakeClient();
    const onReviewScored = vi.fn();
    await scorePage({
      product: PRODUCT,
      reviews: [review("R1"), review("R2")],
      active: ACTIVE,
      client,
      cache: new AnswerCache(new MemoryStorage()),
      onReviewScored,
    });
    expect(onReviewScored).toHaveBeenCalledTimes(2);
  });

  it("does nothing, and costs nothing, with no active filters", async () => {
    const { client, calls } = fakeClient();
    const result = await scorePage({
      product: PRODUCT,
      reviews: [review("R1")],
      active: { custom: [], presets: [], usefulness: false },
      client,
      cache: new AnswerCache(new MemoryStorage()),
    });
    expect(calls).toHaveLength(0);
    expect(result.summary.requests).toBe(0);
    expect(result.summary.estimatedCostUsd).toBe(0);
  });

  it("handles a page with no reviews", async () => {
    const { client } = fakeClient();
    const result = await scorePage({
      product: PRODUCT,
      reviews: [],
      active: ACTIVE,
      client,
      cache: new AnswerCache(new MemoryStorage()),
    });
    expect(result.summary.reviews).toBe(0);
    expect(result.summary.scored).toBe(0);
  });
});

describe("summary counters are per page, not lifetime", () => {
  it("reports only this page's cache activity when the cache is reused", async () => {
    const cache = new AnswerCache(new MemoryStorage());
    const active: ActiveFilters = { custom: [{ id: "f1", text: "battery" }], presets: [], usefulness: false };

    const first = await scorePage({
      product: PRODUCT,
      reviews: [review("R1")],
      active,
      client: fakeClient().client,
      cache,
    });
    expect(first.summary.cacheHits).toBe(0);
    expect(first.summary.cacheMisses).toBe(1);

    // Same cache, second page view: one hit and, crucially, no carried-over miss.
    const second = await scorePage({
      product: PRODUCT,
      reviews: [review("R1")],
      active,
      client: fakeClient().client,
      cache,
    });
    expect(second.summary.cacheHits).toBe(1);
    expect(second.summary.cacheMisses).toBe(0);
  });
});
