/**
 * Raw answers -> what the panel shows and how reviews are ordered.
 *
 * Kept separate from the API client on purpose: changing a weight, a threshold
 * or the unsure band is a display decision and must never re-run inference. The
 * cached answers stay valid; only this file's output changes.
 */
import type { NoulResponse, ScoreResponse } from "@typesafe-ai/sdk";
import { PRESETS, presetById } from "./presets.js";
import { USEFULNESS_KEY, customKey, presetSignalKey } from "./buildQuestions.js";

/** Any answer we might get back, keyed by question key. */
export type AnswerMap = Record<string, NoulResponse | ScoreResponse | undefined>;

/**
 * Nouls carry NO confidence field: `{ type, noul }` is the whole answer. Only
 * `score` and `choice` report confidence. So the spec's "grey out below 0.5
 * confidence" cannot be applied to a noul as written.
 *
 * What a noul does tell us is that a probability near 0.5 means yes and no are
 * about equally likely, which is the same thing the user wanted the grey badge
 * for. So a noul inside this band renders as "unsure" instead of as a number.
 * Widen or narrow it here; nothing else needs to change.
 */
export const NOUL_UNSURE_BAND = { low: 0.4, high: 0.6 } as const;

/** Scores and choices do have confidence; below this they render as unsure. */
export const MIN_CONFIDENCE = 0.5;

export type Verdict =
  /** A probability we are willing to show as a number. */
  | { kind: "scored"; probability: number }
  /** An answer too close to a coin flip to display as a probability. */
  | { kind: "unsure"; probability: number }
  /** No answer: the request failed, or the question was never asked. */
  | { kind: "unscored" };

function isNoul(answer: NoulResponse | ScoreResponse | undefined): answer is NoulResponse {
  return answer?.type === "noul";
}

function isScore(answer: NoulResponse | ScoreResponse | undefined): answer is ScoreResponse {
  return answer?.type === "score";
}

/** Turn one noul probability into a verdict, applying the unsure band. */
export function noulVerdict(answer: NoulResponse | ScoreResponse | undefined): Verdict {
  if (!isNoul(answer)) return { kind: "unscored" };
  const p = answer.noul;
  if (p >= NOUL_UNSURE_BAND.low && p <= NOUL_UNSURE_BAND.high) return { kind: "unsure", probability: p };
  return { kind: "scored", probability: p };
}

/** A user-typed filter's verdict. */
export function customVerdict(answers: AnswerMap, filterId: string): Verdict {
  return noulVerdict(answers[customKey(filterId)]);
}

export interface PresetCombination {
  verdict: Verdict;
  /** Each contributing signal's probability, for explaining the badge. */
  parts: Record<string, number>;
  /** Signals that were asked for but came back missing. */
  missing: string[];
  /** True when a decisive signal set the floor rather than the weighted mean. */
  decisive: boolean;
}

/**
 * Combine a preset's signals into one probability.
 *
 * Single-signal presets pass straight through. The fake-review preset is three
 * separate nouls, deliberately never asked as one "is this fake?" question, and
 * they are combined here with the weights from presets.ts.
 *
 * A weighted mean alone would be wrong for an explicit disclosure: "I received
 * this free in exchange for a review" is close to conclusive, and averaging it
 * against two soft signals would bury it. So a signal marked `decisive` floors
 * the result at its own probability once it passes its threshold. Weighted mean
 * for compensating signals, a floor for the one that stands on its own.
 */
export function combinePreset(presetId: string, answers: AnswerMap): PresetCombination {
  const preset = presetById(presetId);
  if (!preset) return { verdict: { kind: "unscored" }, parts: {}, missing: [], decisive: false };

  const parts: Record<string, number> = {};
  const missing: string[] = [];
  for (const signalId of Object.keys(preset.signals)) {
    const answer = answers[presetSignalKey(presetId, signalId)];
    if (isNoul(answer)) parts[signalId] = answer.noul;
    else missing.push(signalId);
  }

  const present = Object.keys(parts);
  if (present.length === 0) return { verdict: { kind: "unscored" }, parts, missing, decisive: false };

  // Weight only the signals we actually got, so one missing answer degrades the
  // score rather than voiding it.
  const weights = preset.weights ?? {};
  let weightedSum = 0;
  let totalWeight = 0;
  for (const signalId of present) {
    const weight = weights[signalId] ?? 1;
    weightedSum += parts[signalId]! * weight;
    totalWeight += weight;
  }
  let probability = totalWeight > 0 ? weightedSum / totalWeight : 0;

  let decisive = false;
  const rule = preset.decisive;
  if (rule) {
    const signalValue = parts[rule.signal];
    if (signalValue !== undefined && signalValue > rule.decisiveAbove && signalValue > probability) {
      probability = signalValue;
      decisive = true;
    }
  }

  const inBand = probability >= NOUL_UNSURE_BAND.low && probability <= NOUL_UNSURE_BAND.high;
  return {
    verdict: inBand ? { kind: "unsure", probability } : { kind: "scored", probability },
    parts,
    missing,
    decisive,
  };
}

export interface Usefulness {
  /** Expected position on the 0-2 rubric; may be fractional. */
  level: number;
  confidence: number;
  /** True when confidence is too low to rely on. */
  unsure: boolean;
}

/** The usefulness score, used as the secondary sort key. */
export function usefulnessOf(answers: AnswerMap): Usefulness | null {
  const answer = answers[USEFULNESS_KEY];
  if (!isScore(answer)) return null;
  return {
    level: answer.score,
    confidence: answer.confidence,
    unsure: answer.confidence < MIN_CONFIDENCE,
  };
}

/** Every active filter's verdict for one review. */
export interface ReviewVerdicts {
  /** Keyed by filter id for custom filters, preset id for presets. */
  byFilter: Record<string, Verdict>;
  usefulness: Usefulness | null;
}

export function verdictsFor(
  answers: AnswerMap,
  active: { custom: Array<{ id: string }>; presets: string[] },
): ReviewVerdicts {
  const byFilter: Record<string, Verdict> = {};
  for (const filter of active.custom) byFilter[filter.id] = customVerdict(answers, filter.id);
  for (const preset of PRESETS) {
    if (active.presets.includes(preset.id)) byFilter[preset.id] = combinePreset(preset.id, answers).verdict;
  }
  return { byFilter, usefulness: usefulnessOf(answers) };
}

/**
 * Match strength for sorting: the strongest active filter.
 *
 * An unsure verdict still carries its probability, but it is not allowed to
 * outrank a confident one, so it is damped rather than dropped. A review with
 * no usable answer sorts last instead of sorting as zero, which would mix it in
 * with confident non-matches.
 */
export function matchStrength(verdicts: ReviewVerdicts): number | null {
  let best: number | null = null;
  for (const verdict of Object.values(verdicts.byFilter)) {
    if (verdict.kind === "unscored") continue;
    const value = verdict.kind === "unsure" ? verdict.probability * 0.5 : verdict.probability;
    if (best === null || value > best) best = value;
  }
  return best;
}

export interface SortableReview {
  id: string;
  verdicts: ReviewVerdicts;
}

/**
 * Order reviews by match strength, then by usefulness, then by id so the order
 * is stable across re-renders. Unscored reviews sink to the bottom but are kept.
 */
export function sortByMatch<T extends SortableReview>(reviews: readonly T[]): T[] {
  return [...reviews].sort((a, b) => {
    const strengthA = matchStrength(a.verdicts);
    const strengthB = matchStrength(b.verdicts);
    if (strengthA === null && strengthB !== null) return 1;
    if (strengthB === null && strengthA !== null) return -1;
    if (strengthA !== null && strengthB !== null && strengthA !== strengthB) return strengthB - strengthA;

    const usefulA = a.verdicts.usefulness?.level ?? -1;
    const usefulB = b.verdicts.usefulness?.level ?? -1;
    if (usefulA !== usefulB) return usefulB - usefulA;

    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Colour steps for the badge, per spec: 0.5 / 0.7 / 0.85. */
export type BadgeStep = "unsure" | "low" | "medium" | "high" | "top";

export function badgeStep(verdict: Verdict): BadgeStep | null {
  if (verdict.kind === "unscored") return null;
  if (verdict.kind === "unsure") return "unsure";
  const p = verdict.probability;
  if (p >= 0.85) return "top";
  if (p >= 0.7) return "high";
  if (p >= 0.5) return "medium";
  return "low";
}

/** Whether a review passes the user's threshold on any active filter. */
export function passesThreshold(verdicts: ReviewVerdicts, threshold: number): boolean {
  for (const verdict of Object.values(verdicts.byFilter)) {
    // An unsure answer is never confidently below the threshold, so it is not hidden.
    if (verdict.kind === "unsure") return true;
    if (verdict.kind === "scored" && verdict.probability >= threshold) return true;
  }
  // A review with no usable answers is never hidden: we do not know that it fails.
  return Object.values(verdicts.byFilter).every((v) => v.kind === "unscored");
}
