/**
 * Preset filter criteria. THIS FILE IS MEANT TO BE EDITED.
 *
 * Everything here is wording and weights, no logic. Tune a criterion, add an
 * example, change a weight: nothing else needs to change. `buildQuestions.ts`
 * turns these into API questions and `combine.ts` turns the answers into scores.
 *
 * Each signal follows the contrastive-criteria shape: say what the question IS
 * for, what it is NOT for, and give one example each way. The exclusion does as
 * much work as the definition, because the near-misses are what a filter gets
 * wrong: a shipping complaint that mentions the product, a durability question
 * answered by a review that merely worries about durability.
 */

/** One yes/no signal, as structured instructions for a `noul`. */
export interface SignalCriteria {
  /** What the question is asking. */
  what: string;
  /** What must NOT count, stated as its own sentence. */
  not_for: string;
  /** Review text that should score high. */
  example_yes: string;
  /** Near-miss review text that should score low. */
  example_no: string;
}

/** A toggleable chip. Most presets have one signal; `fake` has several. */
export interface Preset {
  id: string;
  /** Chip text in the panel. */
  label: string;
  signals: Record<string, SignalCriteria>;
  /**
   * How to turn several signals into one probability. Weights are relative and
   * are normalised, so they do not need to sum to 1.
   */
  weights?: Record<string, number>;
  /**
   * A signal that is close to decisive on its own. A weighted mean dilutes an
   * explicit admission, so when one of these is above `decisiveAbove`, the
   * combined score is floored at that signal's own probability.
   */
  decisive?: { signal: string; decisiveAbove: number };
}

export const PRESETS: readonly Preset[] = [
  {
    id: "durability",
    label: "mentions durability or breakage",
    signals: {
      durability: {
        what: "The reviewer reports the product physically breaking, wearing out, cracking, tearing, or failing after some period of use.",
        not_for:
          "Do not count speculation about future durability, praise for how sturdy something feels, or damage that happened in transit before use.",
        example_yes:
          "The hinge snapped after about four months of daily opening and closing.",
        example_no:
          "Feels really solid and well built, I expect it will last for years.",
      },
    },
  },
  {
    id: "sizing",
    label: "mentions sizing or fit",
    signals: {
      sizing: {
        what: "The reviewer comments on how the item fits, or on its size relative to what they expected or to a stated size.",
        not_for:
          "Do not count remarks about weight, capacity, or packaging dimensions that are not about fit on a body or in an intended space.",
        example_yes:
          "Runs at least one size small. I usually wear a medium and had to return it for a large.",
        example_no:
          "Heavier than I expected but that is a good thing, it feels substantial.",
      },
    },
  },
  {
    id: "shipping",
    label: "mentions shipping or packaging, not the product itself",
    signals: {
      shipping: {
        what: "The review is about delivery, courier handling, or packaging, rather than about the product's own qualities.",
        not_for:
          "Do not count a review that mentions delivery in passing but then goes on to judge the product. This question is for reviews whose substance is the shipping experience.",
        example_yes:
          "Arrived four days late and the box was crushed. Haven't opened it yet.",
        example_no:
          "Shipping was quick. The drill itself is powerful and the battery lasts all day.",
      },
    },
  },
  {
    /**
     * Never asked as one "is this fake?" question. Three independent signals,
     * combined in code, so the reason a review looks incentivised stays visible
     * and the weights stay tunable here.
     */
    id: "fake",
    label: "reads like an incentivised or fake review",
    signals: {
      generic_praise: {
        what: "The review praises or condemns the product in general terms without any specific detail about the product itself.",
        not_for:
          "Do not count a short review that still names a concrete feature, measurement, or use. Brevity alone is not generic.",
        example_yes:
          "Amazing product! Great quality, fast delivery, highly recommend to everyone!!",
        example_no: "Battery lasted six hours on one charge. Good enough for me.",
      },
      free_or_discounted: {
        what: "The reviewer states they received the product free, at a discount, as a sample, or in exchange for a review.",
        not_for:
          "Do not count mentions of the product being good value, on sale, or cheap. This is about how the reviewer obtained it.",
        example_yes:
          "I received this product at a discounted price in exchange for my honest review.",
        example_no: "Got it in the sale for half price, which is a bargain for what it does.",
      },
      tone_mismatch: {
        what: "The enthusiasm of the text does not match the star rating given in `review.rating`.",
        not_for:
          "Do not count a review whose tone and rating agree, however strongly worded. A furious one-star review is consistent, not mismatched.",
        example_yes:
          "A five-star rating whose text says the item stopped working after a week.",
        example_no:
          "A one-star rating whose text says the item stopped working after a week.",
      },
    },
    weights: { generic_praise: 0.35, free_or_discounted: 0.45, tone_mismatch: 0.2 },
    // An explicit disclosure is near-conclusive, and averaging it away would be wrong.
    decisive: { signal: "free_or_discounted", decisiveAbove: 0.8 },
  },
];

/**
 * The usefulness rubric, used as the secondary sort key. Three ordered levels,
 * indexed from zero; each describes a concrete situation and stands on its own.
 */
export const USEFULNESS_RUBRIC = [
  "Generic praise or complaint with no product specifics: the reviewer says it is great or terrible and nothing more.",
  "Some specifics about the product, but nothing about how, how long, or under what conditions it was used.",
  "Concrete details tied to real usage: what the reviewer did with the product, over what period, and what happened as a result.",
] as const;

export const USEFULNESS_INSTRUCTIONS =
  "How useful is this review to a shopper deciding whether to buy, judging only `review.title` and `review.body`?";

/** Maximum simultaneous user-typed filters, per spec. */
export const MAX_CUSTOM_FILTERS = 5;

export function presetById(id: string): Preset | undefined {
  return PRESETS.find((preset) => preset.id === id);
}
