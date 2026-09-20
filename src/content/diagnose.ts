/**
 * Is the scraper still working?
 *
 * The selectors in selectors.ts are the most fragile thing in this project:
 * Amazon changes its markup often and A/B tests it, so "it worked yesterday"
 * and "it works for me" are both weak evidence. This module answers "did the
 * page change under us?" in a form a person can paste into a bug report.
 *
 * The same code serves two callers, so they cannot disagree:
 *   - the content script, which warns automatically when something looks wrong
 *   - `npm run check-fixture`, run by hand against a saved page
 */
import {
  PANEL_ANCHOR,
  PRODUCT,
  REVIEW_CARD,
  REVIEW_FIELD,
  REVIEW_LIST,
  SEE_ALL_REVIEWS,
} from "./selectors.js";
import { scrapeProduct, scrapeReviewCards } from "./scrape.js";

/**
 * Fields Amazon renders on essentially every review. If one of these is missing
 * from most cards, a selector has broken.
 *
 * `verified` and `helpful` are deliberately absent: plenty of genuine reviews
 * carry no "Verified Purchase" badge and no helpful votes, so judging those by
 * coverage would cry wolf on a perfectly healthy page.
 */
const EXPECTED_FIELDS = ["title", "body", "rating", "date"] as const;

/** Below this share of cards, an expected field counts as broken. */
const FIELD_HEALTH_THRESHOLD = 0.5;

export interface FieldHealth {
  field: string;
  /** Cards where some candidate selector matched. */
  matched: number;
  total: number;
  /** The candidate that matched first, or null if none did. */
  selector: string | null;
  /** Whether this field should be present on nearly every review. */
  expected: boolean;
}

export interface SelectorReport {
  /** Which candidate matched, or null. */
  listContainer: string | null;
  cardSelector: string | null;
  cards: number;
  reviewsParsed: number;
  /** Cards that parsed to nothing: no body, or a duplicate id. */
  dropped: number;
  productTitle: string | null;
  productCategory: string | null;
  panelAnchor: string | null;
  seeAllReviews: string | null;
  fields: FieldHealth[];
  /** Plain-English descriptions of what looks broken. Empty means healthy. */
  problems: string[];
  healthy: boolean;
}

/** First candidate that matches anything, with its match count. */
function firstMatch(root: ParentNode, candidates: readonly string[]): { selector: string | null; count: number } {
  for (const selector of candidates) {
    let count = 0;
    try {
      count = root.querySelectorAll(selector).length;
    } catch {
      // A malformed selector is a bug in selectors.ts, not a broken page.
      continue;
    }
    if (count > 0) return { selector, count };
  }
  return { selector: null, count: 0 };
}

/** Inspect the page and report on every selector the scraper depends on. */
export function diagnose(root: ParentNode): SelectorReport {
  const list = firstMatch(root, REVIEW_LIST);
  const card = firstMatch(root, REVIEW_CARD);
  const cards = card.selector ? Array.from(root.querySelectorAll(card.selector)) : [];

  const fields: FieldHealth[] = Object.entries(REVIEW_FIELD).map(([field, candidates]) => {
    let selector: string | null = null;
    let matched = 0;
    for (const element of cards) {
      const hit = firstMatch(element, candidates);
      if (hit.selector) {
        matched += 1;
        selector ??= hit.selector;
      }
    }
    return {
      field,
      matched,
      total: cards.length,
      selector,
      expected: (EXPECTED_FIELDS as readonly string[]).includes(field),
    };
  });

  const parsed = scrapeReviewCards(root);
  const product = scrapeProduct(root);

  const problems: string[] = [];
  if (cards.length === 0) {
    problems.push(
      list.selector === null
        ? "No review list container matched, and no review cards were found anywhere on the page." +
          " Either this product has no reviews yet, or the selectors have changed."
        : `The list container matched (${list.selector}) but it contains no review cards.`,
    );
  } else if (parsed.length === 0) {
    problems.push(
      `${cards.length} review cards were found, but none could be parsed. The body selector is the` +
        " likeliest cause, since a card with no body text is dropped.",
    );
  }

  for (const health of fields) {
    if (!health.expected || health.total === 0) continue;
    if (health.matched / health.total < FIELD_HEALTH_THRESHOLD) {
      problems.push(
        `The "${health.field}" selector matched only ${health.matched} of ${health.total} cards.` +
          " Amazon renders that field on nearly every review, so this selector has probably changed.",
      );
    }
  }

  if (cards.length > 0 && !product.title) {
    problems.push("The product title selector matched nothing, so scoring loses product context.");
  }

  return {
    listContainer: list.selector,
    cardSelector: card.selector,
    cards: cards.length,
    reviewsParsed: parsed.length,
    dropped: cards.length - parsed.length,
    productTitle: product.title || null,
    productCategory: product.category,
    panelAnchor: firstMatch(root, PANEL_ANCHOR).selector,
    seeAllReviews: firstMatch(root, SEE_ALL_REVIEWS).selector,
    fields,
    problems,
    healthy: problems.length === 0,
  };
}

/** The report as text, for a console warning or a bug report. */
export function formatReport(report: SelectorReport): string {
  const lines: string[] = [];
  lines.push(report.healthy ? "Sift selector health: OK" : "Sift selector health: PROBLEMS FOUND");

  for (const problem of report.problems) lines.push(`  ! ${problem}`);

  lines.push("");
  lines.push(`  list container   ${report.listContainer ?? "MISS"}`);
  lines.push(`  review card      ${report.cardSelector ?? "MISS"}`);
  lines.push(`  cards found      ${report.cards}`);
  lines.push(`  reviews parsed   ${report.reviewsParsed} (${report.dropped} dropped)`);
  lines.push(`  product title    ${report.productTitle ?? "MISS"}`);
  lines.push(`  category         ${report.productCategory ?? "MISS"}`);
  lines.push(`  panel anchor     ${report.panelAnchor ?? "MISS"}`);
  lines.push(`  see-all link     ${report.seeAllReviews ?? "(none on this page)"}`);
  lines.push("");

  for (const field of report.fields) {
    const coverage = field.total === 0 ? "-" : `${field.matched}/${field.total}`;
    const flag = field.expected && field.total > 0 && field.matched / field.total < FIELD_HEALTH_THRESHOLD
      ? " <-- probably broken"
      : "";
    lines.push(`  ${field.field.padEnd(10)} ${coverage.padStart(8)}  ${field.selector ?? "MISS"}${flag}`);
  }

  if (!report.healthy) {
    lines.push("");
    lines.push("  Every selector lives in src/content/selectors.ts. To fix: save this page");
    lines.push("  (Ctrl+S, or copy document.documentElement.outerHTML) and run");
    lines.push("  npm run check-fixture -- <file.html>");
  }

  return lines.join("\n");
}
