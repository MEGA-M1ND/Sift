// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { chunk, orderByViewport, sendWithRetry, withinBudget } from "../src/content/resume.js";

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

describe("orderByViewport", () => {
  const H = 800;
  /** Score in page order; `top` mimics getBoundingClientRect().top. */
  const order = (tops: Array<number | null>) =>
    orderByViewport(
      tops.map((top, i) => ({ id: i, top })),
      (item) => item.top,
      H,
    ).map((item) => item.id);

  it("puts what is on screen first", () => {
    // 0: below the fold, 1: on screen, 2: scrolled past.
    expect(order([900, 100, -500])[0]).toBe(1);
  });

  it("orders visible reviews top to bottom", () => {
    expect(order([600, 100, 350])).toEqual([1, 2, 0]);
  });

  it("takes what is just below the fold before what scrolled past", () => {
    // Someone scrolling down is heading towards 0, not back to 1.
    expect(order([850, -50])).toEqual([0, 1]);
  });

  it("orders below-the-fold reviews nearest first", () => {
    expect(order([2000, 900, 1400])).toEqual([1, 2, 0]);
  });

  it("orders scrolled-past reviews nearest last", () => {
    expect(order([-2000, -100, -900])).toEqual([1, 2, 0]);
  });

  it("puts the whole viewport band ahead of everything else", () => {
    const result = order([-10, 810, 0, 799]);
    // Indices 2 and 3 are on screen; 1 is just below; 0 just above.
    expect(result.slice(0, 2)).toEqual([2, 3]);
  });

  it("keeps reviews it cannot measure, sorted last", () => {
    const result = order([null, 100, null, 900]);
    expect(result).toHaveLength(4);
    expect(result.slice(0, 2)).toEqual([1, 3]);
    expect(result.slice(2).sort()).toEqual([0, 2]);
  });

  it("is stable, so repeated runs do not reshuffle the queue", () => {
    const tops = [100, 100, 100];
    expect(order(tops)).toEqual([0, 1, 2]);
  });

  it("returns everything it was given", () => {
    const tops = Array.from({ length: 50 }, (_, i) => i * 37 - 500);
    expect(order(tops).sort((a, b) => a - b)).toEqual(tops.map((_, i) => i));
  });

  it("handles an empty list", () => {
    expect(order([])).toEqual([]);
  });
});

describe("withinBudget", () => {
  it("allows a chunk that fits", () => {
    expect(withinBudget(0.02, 0.01, 0.05)).toBe(true);
  });

  it("allows a chunk that lands exactly on the ceiling", () => {
    expect(withinBudget(0.04, 0.01, 0.05)).toBe(true);
  });

  it("refuses a chunk that would cross the ceiling", () => {
    // Checked before sending: a limit noticed after the fact is not a limit.
    expect(withinBudget(0.045, 0.01, 0.05)).toBe(false);
  });

  it("refuses once the ceiling is already spent", () => {
    expect(withinBudget(0.05, 0.0001, 0.05)).toBe(false);
  });

  it("treats a ceiling of zero as no ceiling", () => {
    expect(withinBudget(99, 99, 0)).toBe(true);
  });

  it("treats a negative ceiling as no ceiling rather than blocking everything", () => {
    expect(withinBudget(0, 1, -1)).toBe(true);
  });

  it("allows the first chunk when nothing has been spent", () => {
    expect(withinBudget(0, 0.004, 0.05)).toBe(true);
  });
});
