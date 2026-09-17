/**
 * Calibration sanity check, run before any UI exists.
 *
 *   npm run smoke
 *
 * Sends five hand-written reviews, three questions each, to the real API and
 * prints the probabilities and confidence side by side. Read the columns against
 * the "expected" note on each review: that is the whole point of the script.
 */
import { noul, score } from "@typesafe-ai/sdk";
import { SiftClient } from "../src/background/client.js";
import { estimateCostUsd, formatCostUsd } from "../src/shared/cost.js";
import { toState, type ProductContext, type Review } from "../src/shared/types.js";

const PRODUCT: ProductContext = {
  title: "AcmeDrive 20V Cordless Drill with 2 Li-ion Batteries",
  category: "Tools & Home Improvement",
};

/** Three questions, asked together over the same state: they run in parallel. */
const QUESTIONS = {
  battery_dies: noul(
    "Does `review.title` or `review.body` describe the product's battery losing its charge capacity, dying, or needing replacement within about a year of use?",
    {
      true: "The reviewer reports the battery degrading, dying, or holding much less charge after months of ownership.",
      false: "The reviewer does not discuss battery lifespan, or reports the battery still performing well.",
    },
  ),
  incentivised: noul(
    "Does `review.body` state that the reviewer received the product free, discounted, or in exchange for the review?",
    {
      true: "The text discloses a free sample, a discount, a gift, or a request to review in exchange for the item.",
      false: "No such disclosure appears; the reviewer writes as an ordinary paying customer.",
    },
  ),
  usefulness: score(
    "How useful is this review to a shopper deciding whether to buy, based on `review.title` and `review.body`?",
    [
      "Generic praise or complaint with no product specifics: 'great product', 'waste of money', and nothing else.",
      "Some specifics about the product, but no detail on how, how long, or under what conditions it was used.",
      "Concrete details tied to real usage: what the reviewer did with it, for how long, and what happened.",
    ],
  ),
};

/** Hand-written, spanning the cases the filters must separate. */
const REVIEWS: Array<Review & { expected: string }> = [
  {
    id: "smoke-1",
    title: "Battery was dead within ten months",
    body: "Used it for weekend jobs, nothing heavy. Around month ten the battery went from a full day of work to about forty minutes. The second battery went the same way a month later. Drill itself is fine, the cells are not.",
    rating: 2,
    verified_purchase: true,
    date: "2026-03-04",
    helpful_votes: 17,
    expected: "battery HIGH, incentivised LOW, usefulness HIGH",
  },
  {
    id: "smoke-2",
    title: "Great product!!",
    body: "Love it. Exactly what I wanted. Five stars.",
    rating: 5,
    verified_purchase: true,
    date: "2026-05-19",
    helpful_votes: 0,
    expected: "battery LOW, incentivised LOW, usefulness LOW",
  },
  {
    id: "smoke-3",
    title: "Excellent value for the price",
    body: "I received this item at a discounted price in exchange for my honest and unbiased review. That said, the build quality is impressive and the finish is lovely. Would recommend to anyone!",
    rating: 5,
    verified_purchase: false,
    date: "2026-06-02",
    helpful_votes: 1,
    expected: "battery LOW, incentivised HIGH, usefulness LOW-MID",
  },
  {
    id: "smoke-4",
    title: "Box arrived crushed",
    body: "Courier left it in the rain and the outer box was soaked through and torn open. Amazon replaced it quickly, no complaints there. Haven't actually used the drill yet so I can't speak to it.",
    rating: 1,
    verified_purchase: true,
    date: "2026-04-11",
    helpful_votes: 4,
    expected: "battery LOW, incentivised LOW, usefulness LOW-MID",
  },
  {
    id: "smoke-5",
    title: "Eighteen months of daily site use",
    body: "I run a small carpentry business and this has been my main driver since early last year. Roughly forty holes a day into pine and MDF, occasional masonry with the hammer setting. Both batteries still take a full charge and I get through a morning on one. The chuck has loosened slightly and I torque it by hand now.",
    rating: 5,
    verified_purchase: true,
    date: "2026-08-22",
    helpful_votes: 63,
    expected: "battery LOW, incentivised LOW, usefulness HIGH",
  },
];

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value + " ".repeat(width - value.length);
}

function padStart(value: string, width: number): string {
  return value.length >= width ? value : " ".repeat(width - value.length) + value;
}

async function main(): Promise<void> {
  if (!process.env.TYPESAFE_API_KEY) {
    console.error("TYPESAFE_API_KEY is not set. Put it in .env (gitignored) or export it, then re-run.");
    process.exitCode = 1;
    return;
  }

  const client = new SiftClient();
  const started = Date.now();
  // One request per review, all five in flight at once under the concurrency cap.
  const results = await Promise.all(
    REVIEWS.map((review) => client.score(toState(PRODUCT, review), QUESTIONS)),
  );
  const wallMs = Date.now() - started;

  const header =
    pad("review", 34) +
    padStart("battery", 9) +
    padStart("incent.", 9) +
    padStart("useful", 8) +
    padStart("conf", 7) +
    padStart("ms", 7) +
    padStart("tok", 7);
  console.log("");
  console.log(header);
  console.log("-".repeat(header.length));

  let inputTokens = 0;
  const latencies: number[] = [];

  results.forEach((result, index) => {
    const review = REVIEWS[index]!;
    const label = pad(review.title, 34);
    if (!result.ok) {
      console.log(label + padStart(`unscored (${result.reason})`, 40));
      return;
    }
    inputTokens += result.usage.input_tokens;
    latencies.push(result.latencyMs);
    console.log(
      label +
        padStart(result.answers.battery_dies.noul.toFixed(2), 9) +
        padStart(result.answers.incentivised.noul.toFixed(2), 9) +
        padStart(result.answers.usefulness.score.toFixed(2), 8) +
        padStart(result.answers.usefulness.confidence.toFixed(2), 7) +
        padStart(String(result.latencyMs), 7) +
        padStart(String(result.usage.input_tokens), 7),
    );
  });

  console.log("");
  for (const review of REVIEWS) console.log(`  ${pad(review.title, 34)} expected ${review.expected}`);

  latencies.sort((a, b) => a - b);
  const p = (q: number) => latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))] ?? 0;
  console.log("");
  console.log(
    `${results.filter((r) => r.ok).length}/${REVIEWS.length} scored | wall ${wallMs}ms | p50 ${p(0.5)}ms p95 ${p(0.95)}ms | ` +
      `${inputTokens} input tokens | ${formatCostUsd(estimateCostUsd(inputTokens))}`,
  );
  const failed = results.filter((r) => !r.ok);
  if (failed.length === REVIEWS.length && !failed[0]!.ok) {
    const { reason, message } = failed[0]!;
    console.log("");
    console.log(`nothing was scored: ${reason} (${message})`);
    if (reason === "blocked") {
      console.log("api.typesafe.ai is not reachable from this machine. Check your network egress allowlist.");
    } else if (reason === "auth") {
      console.log("the API rejected the key. Check TYPESAFE_API_KEY.");
    }
  }
  console.log(
    `note: usefulness is a 0-2 rubric score (expected value, may be fractional); nouls are 0-1 probabilities.`,
  );
  console.log(`note: noul answers carry no confidence field; only score and choice do.`);
}

await main();
