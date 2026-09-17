// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { NoulResponse, ScoreResponse } from "@typesafe-ai/sdk";
import {
  NOUL_UNSURE_BAND,
  badgeStep,
  combinePreset,
  customVerdict,
  matchStrength,
  noulVerdict,
  passesThreshold,
  sortByMatch,
  usefulnessOf,
  verdictsFor,
  type AnswerMap,
} from "../src/questions/combine.js";
import { customKey, presetSignalKey, USEFULNESS_KEY } from "../src/questions/buildQuestions.js";

/** Hand-built answers, exactly the shape the API documents. */
function noulAnswer(p: number): NoulResponse {
  return { type: "noul", noul: p };
}

function scoreAnswer(value: number, confidence: number): ScoreResponse {
  return {
    type: "score",
    score: value,
    confidence,
    legend: { 0: "generic", 1: "some specifics", 2: "concrete details" },
    probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 },
  } as unknown as ScoreResponse;
}

describe("noulVerdict", () => {
  it("shows a confident yes as a probability", () => {
    expect(noulVerdict(noulAnswer(0.93))).toEqual({ kind: "scored", probability: 0.93 });
  });

  it("shows a confident no as a probability", () => {
    expect(noulVerdict(noulAnswer(0.04))).toEqual({ kind: "scored", probability: 0.04 });
  });

  it("calls a coin-flip answer unsure rather than showing a number", () => {
    // Nouls carry no confidence field, so proximity to 0.5 is the only signal.
    expect(noulVerdict(noulAnswer(0.5)).kind).toBe("unsure");
    expect(noulVerdict(noulAnswer(NOUL_UNSURE_BAND.low)).kind).toBe("unsure");
    expect(noulVerdict(noulAnswer(NOUL_UNSURE_BAND.high)).kind).toBe("unsure");
  });

  it("treats answers just outside the band as usable", () => {
    expect(noulVerdict(noulAnswer(NOUL_UNSURE_BAND.high + 0.01)).kind).toBe("scored");
    expect(noulVerdict(noulAnswer(NOUL_UNSURE_BAND.low - 0.01)).kind).toBe("scored");
  });

  it("is unscored when the answer is missing or the wrong type", () => {
    expect(noulVerdict(undefined)).toEqual({ kind: "unscored" });
    expect(noulVerdict(scoreAnswer(2, 0.9))).toEqual({ kind: "unscored" });
  });
});

describe("customVerdict", () => {
  it("reads the answer under the filter's own key", () => {
    const answers: AnswerMap = { [customKey("f1")]: noulAnswer(0.88) };
    expect(customVerdict(answers, "f1")).toEqual({ kind: "scored", probability: 0.88 });
    expect(customVerdict(answers, "f2")).toEqual({ kind: "unscored" });
  });
});

describe("combinePreset", () => {
  /** Build a fake-preset answer map from its three signals. */
  function fakeAnswers(parts: { generic?: number; free?: number; tone?: number }): AnswerMap {
    const answers: AnswerMap = {};
    if (parts.generic !== undefined) answers[presetSignalKey("fake", "generic_praise")] = noulAnswer(parts.generic);
    if (parts.free !== undefined) answers[presetSignalKey("fake", "free_or_discounted")] = noulAnswer(parts.free);
    if (parts.tone !== undefined) answers[presetSignalKey("fake", "tone_mismatch")] = noulAnswer(parts.tone);
    return answers;
  }

  it("passes a single-signal preset straight through", () => {
    const answers: AnswerMap = { [presetSignalKey("durability", "durability")]: noulAnswer(0.91) };
    const combined = combinePreset("durability", answers);
    expect(combined.verdict).toEqual({ kind: "scored", probability: 0.91 });
    expect(combined.missing).toEqual([]);
  });

  it("weights the three fake-review signals rather than asking one question", () => {
    // weights: generic 0.35, free 0.45, tone 0.2
    const combined = combinePreset("fake", fakeAnswers({ generic: 1, free: 0, tone: 0 }));
    expect(combined.verdict.kind).toBe("scored");
    expect((combined.verdict as { probability: number }).probability).toBeCloseTo(0.35, 5);
    expect(combined.parts).toEqual({ generic_praise: 1, free_or_discounted: 0, tone_mismatch: 0 });
  });

  it("averages compensating signals", () => {
    const combined = combinePreset("fake", fakeAnswers({ generic: 0.6, free: 0.2, tone: 0.4 }));
    // 0.6*0.35 + 0.2*0.45 + 0.4*0.2 = 0.21 + 0.09 + 0.08 = 0.38
    expect((combined.verdict as { probability: number }).probability).toBeCloseTo(0.38, 5);
  });

  it("does not let a weighted mean bury an explicit free-product disclosure", () => {
    // Without the decisive rule this would be 0.95*0.45 = 0.4275, i.e. "unsure",
    // for a review that openly says it was given the product free.
    const combined = combinePreset("fake", fakeAnswers({ generic: 0, free: 0.95, tone: 0 }));
    expect(combined.decisive).toBe(true);
    expect((combined.verdict as { probability: number }).probability).toBeCloseTo(0.95, 5);
    expect(combined.verdict.kind).toBe("scored");
  });

  it("does not apply the floor below the decisive threshold", () => {
    const combined = combinePreset("fake", fakeAnswers({ generic: 0, free: 0.7, tone: 0 }));
    expect(combined.decisive).toBe(false);
    expect((combined.verdict as { probability: number }).probability).toBeCloseTo(0.315, 5);
  });

  it("does not lower a high mean to a decisive signal's value", () => {
    const combined = combinePreset("fake", fakeAnswers({ generic: 1, free: 0.85, tone: 1 }));
    const p = (combined.verdict as { probability: number }).probability;
    // Mean is 0.9325, above the decisive signal itself; the floor must not pull it down.
    expect(p).toBeCloseTo(0.9325, 4);
  });

  it("degrades rather than voids when one signal is missing", () => {
    const combined = combinePreset("fake", fakeAnswers({ generic: 0.8, tone: 0.6 }));
    expect(combined.missing).toEqual(["free_or_discounted"]);
    // Renormalised over the two present weights: (0.8*0.35 + 0.6*0.2) / 0.55
    expect((combined.verdict as { probability: number }).probability).toBeCloseTo(0.7272, 3);
  });

  it("is unscored when every signal is missing", () => {
    const combined = combinePreset("fake", {});
    expect(combined.verdict).toEqual({ kind: "unscored" });
    expect(combined.missing).toHaveLength(3);
  });

  it("is unscored for an unknown preset id", () => {
    expect(combinePreset("nonsense", {}).verdict).toEqual({ kind: "unscored" });
  });

  it("marks a combined result in the band as unsure", () => {
    const combined = combinePreset("fake", fakeAnswers({ generic: 0.5, free: 0.5, tone: 0.5 }));
    expect(combined.verdict.kind).toBe("unsure");
  });
});

describe("usefulnessOf", () => {
  it("reads the rubric score and its confidence", () => {
    expect(usefulnessOf({ [USEFULNESS_KEY]: scoreAnswer(1.86, 0.88) })).toEqual({
      level: 1.86,
      confidence: 0.88,
      unsure: false,
    });
  });

  it("flags a low-confidence score as unsure", () => {
    expect(usefulnessOf({ [USEFULNESS_KEY]: scoreAnswer(1.05, 0.41) })?.unsure).toBe(true);
  });

  it("is null when absent", () => {
    expect(usefulnessOf({})).toBeNull();
  });
});

describe("matchStrength", () => {
  const active = { custom: [{ id: "f1" }, { id: "f2" }], presets: [] };

  it("takes the strongest active filter", () => {
    const verdicts = verdictsFor(
      { [customKey("f1")]: noulAnswer(0.3), [customKey("f2")]: noulAnswer(0.82) },
      active,
    );
    expect(matchStrength(verdicts)).toBeCloseTo(0.82, 5);
  });

  it("damps an unsure answer so it cannot outrank a confident one", () => {
    const verdicts = verdictsFor({ [customKey("f1")]: noulAnswer(0.55) }, { custom: [{ id: "f1" }], presets: [] });
    expect(matchStrength(verdicts)).toBeCloseTo(0.275, 5);
  });

  it("is null when nothing could be answered", () => {
    expect(matchStrength(verdictsFor({}, active))).toBeNull();
  });
});

describe("sortByMatch", () => {
  const active = { custom: [{ id: "f1" }], presets: [] };

  function entry(id: string, p: number | null, useful?: number) {
    const answers: AnswerMap = {};
    if (p !== null) answers[customKey("f1")] = noulAnswer(p);
    if (useful !== undefined) answers[USEFULNESS_KEY] = scoreAnswer(useful, 0.9);
    return { id, verdicts: verdictsFor(answers, active) };
  }

  it("orders by match strength, strongest first", () => {
    const sorted = sortByMatch([entry("a", 0.2), entry("b", 0.95), entry("c", 0.7)]);
    expect(sorted.map((r) => r.id)).toEqual(["b", "c", "a"]);
  });

  it("breaks ties on usefulness", () => {
    const sorted = sortByMatch([entry("a", 0.8, 0.2), entry("b", 0.8, 1.9)]);
    expect(sorted.map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("sinks unscored reviews to the bottom without dropping them", () => {
    const sorted = sortByMatch([entry("a", null), entry("b", 0.1), entry("c", 0.9)]);
    expect(sorted.map((r) => r.id)).toEqual(["c", "b", "a"]);
    expect(sorted).toHaveLength(3);
  });

  it("is stable for identical scores, so re-renders do not reshuffle", () => {
    const first = sortByMatch([entry("z", 0.5, 1), entry("a", 0.5, 1), entry("m", 0.5, 1)]);
    const second = sortByMatch([entry("m", 0.5, 1), entry("z", 0.5, 1), entry("a", 0.5, 1)]);
    expect(first.map((r) => r.id)).toEqual(second.map((r) => r.id));
  });

  it("does not mutate its input", () => {
    const input = [entry("a", 0.1), entry("b", 0.9)];
    const before = input.map((r) => r.id);
    sortByMatch(input);
    expect(input.map((r) => r.id)).toEqual(before);
  });
});

describe("badgeStep", () => {
  it("steps colour at 0.5, 0.7 and 0.85", () => {
    expect(badgeStep({ kind: "scored", probability: 0.86 })).toBe("top");
    expect(badgeStep({ kind: "scored", probability: 0.85 })).toBe("top");
    expect(badgeStep({ kind: "scored", probability: 0.7 })).toBe("high");
    expect(badgeStep({ kind: "scored", probability: 0.5 })).toBe("medium");
    expect(badgeStep({ kind: "scored", probability: 0.49 })).toBe("low");
  });

  it("has a distinct step for unsure, and nothing for unscored", () => {
    expect(badgeStep({ kind: "unsure", probability: 0.5 })).toBe("unsure");
    expect(badgeStep({ kind: "unscored" })).toBeNull();
  });
});

describe("passesThreshold", () => {
  const active = { custom: [{ id: "f1" }], presets: [] };
  const at = (p: number) => verdictsFor({ [customKey("f1")]: noulAnswer(p) }, active);

  it("keeps a review at or above the threshold", () => {
    expect(passesThreshold(at(0.7), 0.7)).toBe(true);
    expect(passesThreshold(at(0.95), 0.7)).toBe(true);
  });

  it("hides a review confidently below the threshold", () => {
    expect(passesThreshold(at(0.12), 0.7)).toBe(false);
  });

  it("never hides an unsure review: we do not know that it fails", () => {
    expect(passesThreshold(at(0.5), 0.7)).toBe(true);
  });

  it("never hides a review we could not score at all", () => {
    expect(passesThreshold(verdictsFor({}, active), 0.7)).toBe(true);
  });
});
