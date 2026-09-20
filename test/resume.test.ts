// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { chunk, sendWithRetry } from "../src/content/resume.js";

describe("chunk", () => {
  it("splits into runs of the given size", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("keeps a page of 300 reviews to chunks of 50", () => {
    const reviews = Array.from({ length: 300 }, (_, i) => i);
    const chunks = chunk(reviews, 50);
    expect(chunks).toHaveLength(6);
    expect(chunks.every((c) => c.length === 50)).toBe(true);
    // Nothing lost, nothing reordered: a dropped review is a review never scored.
    expect(chunks.flat()).toEqual(reviews);
  });

  it("returns one chunk when everything fits", () => {
    expect(chunk([1, 2, 3], 50)).toEqual([[1, 2, 3]]);
  });

  it("returns nothing for an empty list, rather than one empty chunk", () => {
    expect(chunk([], 50)).toEqual([]);
  });

  it("refuses a nonsensical size instead of looping forever", () => {
    expect(() => chunk([1, 2], 0)).toThrow(RangeError);
  });
});

describe("sendWithRetry", () => {
  const noSleep = async () => {};

  it("sends once when the worker answers", async () => {
    const send = vi.fn().mockResolvedValue({ ok: true });
    const result = await sendWithRetry(send, 300, noSleep);
    expect(result).toEqual({ ok: true });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("retries once when the worker was not there, and succeeds", async () => {
    // This is the eviction case: the first message wakes the worker but is lost.
    const send = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ ok: true });
    const result = await sendWithRetry(send, 300, noSleep);
    expect(result).toEqual({ ok: true });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("gives up after exactly one retry, so a broken channel is not hammered", async () => {
    const send = vi.fn().mockResolvedValue(null);
    const result = await sendWithRetry(send, 300, noSleep);
    expect(result).toBeNull();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("waits between the two attempts, to give the worker time to start", async () => {
    const waits: number[] = [];
    const send = vi.fn().mockResolvedValue(null);
    await sendWithRetry(send, 300, async (ms) => {
      waits.push(ms);
    });
    expect(waits).toEqual([300]);
  });

  it("does not wait at all when the first attempt worked", async () => {
    const sleep = vi.fn();
    await sendWithRetry(async () => ({ ok: true }), 300, sleep);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("really does wait when using the default sleep", async () => {
    const send = vi.fn().mockResolvedValue(null);
    const started = Date.now();
    await sendWithRetry(send, 120);
    expect(Date.now() - started).toBeGreaterThanOrEqual(110);
  });
});
