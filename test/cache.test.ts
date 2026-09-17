// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { NoulResponse } from "@typesafe-ai/sdk";
import { AnswerCache, MAX_ENTRIES, MemoryStorage } from "../src/background/cache.js";
import { cacheKey, isCacheKey, sha256Hex } from "../src/shared/hashing.js";

const answer = (p: number): NoulResponse => ({ type: "noul", noul: p });

describe("cache keys", () => {
  it("is a sha256 hex digest under our own namespace", async () => {
    const key = await cacheKey("R1", "question text");
    expect(key.startsWith("sift:v1:")).toBe(true);
    expect(key.slice("sift:v1:".length)).toMatch(/^[0-9a-f]{64}$/);
    expect(isCacheKey(key)).toBe(true);
  });

  it("is stable across calls, or nothing would ever hit", async () => {
    expect(await cacheKey("R1", "q")).toBe(await cacheKey("R1", "q"));
  });

  it("changes when the question wording changes", async () => {
    expect(await cacheKey("R1", "q1")).not.toBe(await cacheKey("R1", "q2"));
  });

  it("changes when the review changes", async () => {
    expect(await cacheKey("R1", "q")).not.toBe(await cacheKey("R2", "q"));
  });

  it("does not collide when the id/question boundary shifts", async () => {
    // Without a separator, "AB"+"C" and "A"+"BC" would hash identically.
    expect(await cacheKey("AB", "C")).not.toBe(await cacheKey("A", "BC"));
  });

  it("ignores keys it does not own", () => {
    expect(isCacheKey("someone-elses-key")).toBe(false);
  });

  it("hashes a known value correctly", async () => {
    // Guards against a broken encoder or hex conversion.
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("AnswerCache", () => {
  it("misses on an empty cache and hits after storing", async () => {
    const cache = new AnswerCache(new MemoryStorage());
    const lookup = [{ reviewId: "R1", questionText: "q", key: "custom:f1" }];

    expect((await cache.getMany(lookup)).size).toBe(0);
    expect(cache.misses).toBe(1);

    await cache.putMany([{ reviewId: "R1", questionText: "q", answer: answer(0.9) }]);

    const found = await cache.getMany(lookup);
    expect(found.get("custom:f1")).toEqual(answer(0.9));
    expect(cache.hits).toBe(1);
  });

  it("returns answers under the caller's question key, not the storage key", async () => {
    const cache = new AnswerCache(new MemoryStorage());
    await cache.putMany([{ reviewId: "R1", questionText: "qA", answer: answer(0.8) }]);
    const found = await cache.getMany([{ reviewId: "R1", questionText: "qA", key: "preset:fake:tone_mismatch" }]);
    expect([...found.keys()]).toEqual(["preset:fake:tone_mismatch"]);
  });

  it("reports a partial hit, so only the missing questions get asked", async () => {
    const cache = new AnswerCache(new MemoryStorage());
    await cache.putMany([{ reviewId: "R1", questionText: "q1", answer: answer(0.7) }]);

    const found = await cache.getMany([
      { reviewId: "R1", questionText: "q1", key: "a" },
      { reviewId: "R1", questionText: "q2", key: "b" },
    ]);
    expect([...found.keys()]).toEqual(["a"]);
    expect(cache.hits).toBe(1);
    expect(cache.misses).toBe(1);
  });

  it("survives a service-worker restart by rebuilding its index from storage", async () => {
    const storage = new MemoryStorage();
    await new AnswerCache(storage).putMany([{ reviewId: "R1", questionText: "q", answer: answer(0.6) }]);

    // A fresh instance, as after the worker is killed.
    const revived = new AnswerCache(storage);
    const found = await revived.getMany([{ reviewId: "R1", questionText: "q", key: "k" }]);
    expect(found.get("k")).toEqual(answer(0.6));
  });

  it("ignores foreign keys already in storage", async () => {
    const storage = new MemoryStorage();
    await storage.set({ "some-other-extension-key": { junk: true }, "sift-ish": 42 });
    const cache = new AnswerCache(storage);
    expect(await cache.size()).toBe(0);
  });

  it("clears only its own entries", async () => {
    const storage = new MemoryStorage();
    await storage.set({ "unrelated:key": "keep me" });
    const cache = new AnswerCache(storage);
    await cache.putMany([{ reviewId: "R1", questionText: "q", answer: answer(0.5) }]);

    await cache.clear();
    expect(await cache.size()).toBe(0);
    expect(storage.data.get("unrelated:key")).toBe("keep me");
  });

  describe("eviction", () => {
    it("stays under the cap and drops the least recently used first", async () => {
      const storage = new MemoryStorage();
      const cache = new AnswerCache(storage);

      // Fill to exactly the cap.
      const entries = Array.from({ length: MAX_ENTRIES }, (_, i) => ({
        reviewId: `R${i}`,
        questionText: "q",
        answer: answer(i / MAX_ENTRIES),
      }));
      await cache.putMany(entries);
      expect(await cache.size()).toBe(MAX_ENTRIES);

      // Touch the very first entry so it is the most recently used.
      const touched = await cache.getMany([{ reviewId: "R0", questionText: "q", key: "k" }]);
      expect(touched.size).toBe(1);

      // One more entry pushes us over the cap and triggers eviction.
      await cache.putMany([{ reviewId: "NEW", questionText: "q", answer: answer(1) }]);

      expect(await cache.size()).toBeLessThanOrEqual(MAX_ENTRIES);
      expect(await cache.size()).toBeLessThan(MAX_ENTRIES);

      // The newest entry survived.
      const newest = await cache.getMany([{ reviewId: "NEW", questionText: "q", key: "new" }]);
      expect(newest.size).toBe(1);

      // The touched entry survived, despite being written first.
      const stillThere = await cache.getMany([{ reviewId: "R0", questionText: "q", key: "k" }]);
      expect(stillThere.size).toBe(1);
    });

    it("removes evicted entries from storage, not just the index", async () => {
      const storage = new MemoryStorage();
      const cache = new AnswerCache(storage);
      await cache.putMany(
        Array.from({ length: MAX_ENTRIES + 1 }, (_, i) => ({
          reviewId: `R${i}`,
          questionText: "q",
          answer: answer(0.5),
        })),
      );
      const stored = [...storage.data.keys()].filter(isCacheKey).length;
      expect(stored).toBe(await cache.size());
      expect(stored).toBeLessThanOrEqual(MAX_ENTRIES);
    });

    it("does not evict while under the cap", async () => {
      const cache = new AnswerCache(new MemoryStorage());
      await cache.putMany(
        Array.from({ length: 100 }, (_, i) => ({ reviewId: `R${i}`, questionText: "q", answer: answer(0.5) })),
      );
      expect(await cache.size()).toBe(100);
    });
  });
});
