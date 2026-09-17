/**
 * Active filters -> the `questions` object sent with every review.
 *
 * All questions travel in one request and run in parallel over the same state,
 * so adding a filter costs tokens but not a round trip. Each question also
 * carries a canonical text form, which is what the cache keys off: change the
 * wording of a question and its cached answers correctly stop matching.
 */
import { noul, score, type JsonValue, type Question, type Questions } from "@typesafe-ai/sdk";
import { PRESETS, USEFULNESS_INSTRUCTIONS, USEFULNESS_RUBRIC, presetById, type SignalCriteria } from "./presets.js";

/** A user-typed filter. */
export interface CustomFilter {
  /** Stable id, assigned when the filter is added. */
  id: string;
  /** Exactly what the user typed. */
  text: string;
}

export interface ActiveFilters {
  custom: CustomFilter[];
  /** Ids of enabled presets. */
  presets: string[];
  /** The usefulness score is the secondary sort key; on by default. */
  usefulness?: boolean;
}

/** One question, its answer key, and the text that identifies it in the cache. */
export interface BuiltQuestion {
  key: string;
  question: Question;
  /** Canonical text; the cache key is sha256(reviewId + this). */
  text: string;
}

/** Answer key for a user-typed filter. */
export function customKey(filterId: string): string {
  return `custom:${filterId}`;
}

/** Answer key for one signal of a preset. */
export function presetSignalKey(presetId: string, signalId: string): string {
  return `preset:${presetId}:${signalId}`;
}

export const USEFULNESS_KEY = "usefulness";

/**
 * Structured instructions for a preset signal. An object rather than a string
 * because the exclusion and the two examples are what make these accurate.
 */
function signalInstructions(criteria: SignalCriteria): { [key: string]: JsonValue } {
  return {
    what: criteria.what,
    not_for: criteria.not_for,
    examples: [
      { text: criteria.example_yes, answer: "yes" },
      { text: criteria.example_no, answer: "no" },
    ],
  };
}

/**
 * Canonical text for cache identity. Stable key order matters: two runs must
 * produce byte-identical text for the same question, or the cache never hits.
 */
function canonicalText(key: string, instructions: unknown, criteria: unknown): string {
  return JSON.stringify([key, instructions, criteria]);
}

/** A user-typed filter becomes one noul pointed explicitly at both text fields. */
export function buildCustomQuestion(filter: CustomFilter): BuiltQuestion {
  const instructions = {
    what: `Does \`review.title\` or \`review.body\` describe the following? ${filter.text.trim()}`,
    not_for:
      "Judge only what the reviewer actually says about this product. Do not infer from the star rating alone, and do not count a topic that is merely adjacent to the description.",
  };
  const criteria = {
    true: `The review's text describes: ${filter.text.trim()}`,
    false: "The review's text does not describe that, or is about something else.",
  };
  return {
    key: customKey(filter.id),
    question: noul(instructions, criteria),
    text: canonicalText(customKey(filter.id), instructions, criteria),
  };
}

/** Every signal of one preset, as separate questions. */
export function buildPresetQuestions(presetId: string): BuiltQuestion[] {
  const preset = presetById(presetId);
  if (!preset) return [];
  return Object.entries(preset.signals).map(([signalId, criteria]) => {
    const key = presetSignalKey(presetId, signalId);
    const instructions = signalInstructions(criteria);
    const answerCriteria = { true: criteria.what, false: criteria.not_for };
    return {
      key,
      question: noul(instructions, answerCriteria),
      text: canonicalText(key, instructions, answerCriteria),
    };
  });
}

/** The 3-level usefulness rubric. */
export function buildUsefulnessQuestion(): BuiltQuestion {
  const criteria = [...USEFULNESS_RUBRIC] as [string, string, ...string[]];
  return {
    key: USEFULNESS_KEY,
    question: score(USEFULNESS_INSTRUCTIONS, criteria),
    text: canonicalText(USEFULNESS_KEY, USEFULNESS_INSTRUCTIONS, criteria),
  };
}

/** Every question implied by the active filters, in a stable order. */
export function buildQuestions(active: ActiveFilters): BuiltQuestion[] {
  const built: BuiltQuestion[] = [];
  for (const filter of active.custom) built.push(buildCustomQuestion(filter));
  // Iterate PRESETS rather than active.presets so ordering never depends on
  // the order the user clicked the chips.
  for (const preset of PRESETS) {
    if (active.presets.includes(preset.id)) built.push(...buildPresetQuestions(preset.id));
  }
  if (active.usefulness !== false) built.push(buildUsefulnessQuestion());
  return built;
}

/** The subset of built questions as the object the API expects. */
export function toQuestionsObject(built: readonly BuiltQuestion[]): Questions {
  const questions: Questions = {};
  for (const item of built) questions[item.key] = item.question;
  return questions;
}
