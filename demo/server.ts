/**
 * Local demo server.
 *
 *   npm run demo
 *
 * Exists because the extension is hard to show to someone who is not going to
 * install an unpacked Chrome extension first. This serves one page that drives
 * the real scoring pipeline over a set of sample reviews.
 *
 * It imports the extension's own modules rather than reimplementing them, so a
 * demo cannot quietly drift from the product: same questions, same preset
 * weights, same combination rules, same client with its retries and its
 * eight-request cap, same cache.
 *
 * The API key stays in this process and is never sent to the page, which is the
 * same arrangement the extension uses between its service worker and the page.
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AnswerCache, MemoryStorage } from "../src/background/cache.js";
import { SiftClient } from "../src/background/client.js";
import { scorePage } from "../src/background/pipeline.js";
import { MAX_CUSTOM_FILTERS, PRESETS } from "../src/questions/presets.js";
import { buildQuestions, type ActiveFilters } from "../src/questions/buildQuestions.js";
import {
  badgeStep,
  matchStrength,
  passesThreshold,
  sortByMatch,
  usefulnessOf,
  verdictsFor,
} from "../src/questions/combine.js";
import { estimateCostUsd, estimateTokens } from "../src/shared/cost.js";
import { toState, type ProductContext, type Review } from "../src/shared/types.js";

const PORT = Number(process.env.PORT ?? 5174);
const here = (file: string) => resolve(process.cwd(), "demo", file);

const sample = JSON.parse(readFileSync(here("reviews.json"), "utf8")) as {
  product: ProductContext;
  reviews: Review[];
};

// One cache for the server's lifetime, so re-running a filter you already tried
// costs nothing — exactly as a repeat page visit does in the extension.
const cache = new AnswerCache(new MemoryStorage());

function requireClient(): SiftClient {
  if (!process.env.TYPESAFE_API_KEY) {
    throw new Error(
      "TYPESAFE_API_KEY is not set. Put it in .env (which is gitignored) or export it, then restart.",
    );
  }
  return new SiftClient({ apiKey: process.env.TYPESAFE_API_KEY });
}

interface ScoreBody {
  filters: string[];
  presets: string[];
  reviews?: Review[];
}

async function handleScore(body: ScoreBody) {
  const reviews = body.reviews?.length ? body.reviews : sample.reviews;
  const active: ActiveFilters = {
    custom: body.filters.slice(0, MAX_CUSTOM_FILTERS).map((text, index) => ({ id: `f${index}`, text })),
    presets: body.presets,
  };

  const built = buildQuestions(active);
  const estimatedUsd = estimateCostUsd(
    reviews.reduce(
      (total, review) =>
        total +
        estimateTokens(
          JSON.stringify(toState(sample.product, review)) + JSON.stringify(built.map((q) => q.question)),
        ),
      0,
    ),
  );

  const started = Date.now();
  const result = await scorePage({
    product: sample.product,
    reviews,
    active,
    client: requireClient(),
    cache,
  });

  // Verdicts and ordering come from the extension's own combine.ts, so what the
  // demo shows is what the panel would show.
  const rows = reviews.map((review) => ({
    id: review.id,
    review,
    verdicts: verdictsFor(result.answers.get(review.id) ?? {}, active),
  }));

  const ordered = sortByMatch(rows).map((row) => ({
    ...row.review,
    strength: matchStrength(row.verdicts),
    usefulness: usefulnessOf(result.answers.get(row.id) ?? {}),
    badges: Object.entries(row.verdicts.byFilter).map(([key, verdict]) => ({
      key,
      label: labelFor(key, active),
      step: badgeStep(verdict),
      kind: verdict.kind,
      probability: verdict.kind === "unscored" ? null : verdict.probability,
    })),
    passes: (threshold: number) => passesThreshold(row.verdicts, threshold),
  }));

  // `passes` cannot cross JSON, so precompute the thresholds the slider can take.
  const withThresholds = ordered.map(({ passes, ...rest }) => ({
    ...rest,
    // Keyed by the exact string the slider produces, so lookup cannot miss.
    passesAt: Object.fromEntries(
      Array.from({ length: 21 }, (_, i) => {
        const value = (i * 5) / 100;
        return [value.toFixed(2), passes(value)];
      }),
    ),
  }));

  return {
    product: sample.product,
    reviews: withThresholds,
    summary: { ...result.summary, wallMs: Date.now() - started, estimatedUsd },
    questions: built.map((q) => q.key),
  };
}

function labelFor(key: string, active: ActiveFilters): string {
  const custom = active.custom.find((filter) => `custom:${filter.id}` === key);
  if (custom) return custom.text;
  const preset = PRESETS.find((p) => `preset:${p.id}` === key);
  return preset ? shortLabel(preset.id) : key;
}

function shortLabel(id: string): string {
  return id === "fake" ? "incentivised" : id;
}

function send(res: import("node:http").ServerResponse, status: number, body: unknown, type = "application/json") {
  const payload = type === "application/json" ? JSON.stringify(body) : String(body);
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(payload);
}

const server = createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url?.startsWith("/?"))) {
    return send(res, 200, readFileSync(here("index.html"), "utf8"), "text/html; charset=utf-8");
  }

  if (req.method === "GET" && req.url === "/api/config") {
    return send(res, 200, {
      hasApiKey: Boolean(process.env.TYPESAFE_API_KEY),
      presets: PRESETS.map((preset) => ({
        id: preset.id,
        label: preset.label,
        flagOnly: Boolean(preset.flagOnly),
      })),
      maxFilters: MAX_CUSTOM_FILTERS,
      product: sample.product,
      reviews: sample.reviews,
    });
  }

  if (req.method === "POST" && req.url === "/api/score") {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      void (async () => {
        try {
          send(res, 200, await handleScore(JSON.parse(raw) as ScoreBody));
        } catch (error) {
          send(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
      })();
    });
    return;
  }

  return send(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`\n  Sift demo on http://localhost:${PORT}`);
  console.log(
    process.env.TYPESAFE_API_KEY
      ? "  API key loaded. Scoring will hit api.typesafe.ai for real.\n"
      : "  No TYPESAFE_API_KEY found. Put it in .env and restart, or scoring will fail.\n",
  );
});
