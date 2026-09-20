// @vitest-environment node
import { describe, expect, it } from "vitest";
import { CHARS_PER_TOKEN, estimateCostUsd, estimateTokens, formatCostUsd } from "../src/shared/cost.js";

describe("estimateCostUsd", () => {
  it("prices input tokens at $0.042 per million", () => {
    expect(estimateCostUsd(1_000_000)).toBeCloseTo(0.042, 9);
    expect(estimateCostUsd(500)).toBeCloseTo(0.000021, 9);
  });

  it("is zero for no tokens", () => {
    expect(estimateCostUsd(0)).toBe(0);
  });

  it("prices a realistic full page", () => {
    // 300 reviews at roughly 450 input tokens each.
    expect(estimateCostUsd(300 * 450)).toBeCloseTo(0.00567, 5);
  });
});

describe("formatCostUsd", () => {
  it("shows enough digits for the sub-cent case, which is the normal one", () => {
    expect(formatCostUsd(0.0043)).toBe("$0.0043");
    expect(formatCostUsd(0.0001)).toBe("$0.0001");
  });

  it("switches to cents above a cent", () => {
    expect(formatCostUsd(0.42)).toBe("$0.42");
  });

  it("shows exactly zero as zero, not as $0.0000", () => {
    expect(formatCostUsd(0)).toBe("$0");
  });

  it("does not round a tiny but real cost down to nothing", () => {
    // "$0.0000" would read as free, which is a different claim entirely.
    expect(formatCostUsd(0.00002)).toBe("<$0.0001");
    expect(formatCostUsd(0.000000001)).toBe("<$0.0001");
  });

  it("starts showing four decimals at the point they mean something", () => {
    expect(formatCostUsd(0.0001)).toBe("$0.0001");
  });
});

describe("estimateTokens", () => {
  it("counts roughly four characters to a token", () => {
    expect(estimateTokens("a".repeat(4 * 100))).toBe(100);
  });

  it("rounds up, so a short request is never estimated at zero", () => {
    expect(estimateTokens("ab")).toBe(1);
    expect(estimateTokens("")).toBe(0);
  });

  it("uses the documented constant", () => {
    expect(estimateTokens("x".repeat(CHARS_PER_TOKEN))).toBe(1);
  });
});
