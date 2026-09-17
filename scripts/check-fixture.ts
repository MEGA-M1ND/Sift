/**
 * Point this at any saved Amazon page to find out which selectors actually hit.
 *
 *   npm run check-fixture -- fixtures/amazon-in-product-reviews.html
 *
 * It exists because the selectors in src/content/selectors.ts could not be
 * verified against a live page here. Save a real page, run this, and every
 * field reporting MISS is a selector to fix. No network, no API key.
 */
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import {
  PANEL_ANCHOR,
  PRODUCT,
  REVIEW_CARD,
  REVIEW_FIELD,
  REVIEW_LIST,
  SEE_ALL_REVIEWS,
} from "../src/content/selectors.js";
import { hasSeeAllReviewsLink, scrapeProduct, scrapeReviews } from "../src/content/scrape.js";

const file = process.argv[2];
if (!file) {
  console.error("usage: npm run check-fixture -- <path-to-saved-page.html>");
  process.exit(1);
}

const html = readFileSync(file, "utf8");
const window = new Window({ url: "https://www.amazon.in/" });
window.document.documentElement.innerHTML = html;
const doc = window.document as unknown as Document;

/** Report which candidate in an ordered list matches, and how many it finds. */
function report(label: string, candidates: readonly string[], root: ParentNode = doc): void {
  for (const selector of candidates) {
    let count = 0;
    try {
      count = root.querySelectorAll(selector).length;
    } catch {
      console.log(`  ${label.padEnd(12)} ERROR   invalid selector: ${selector}`);
      return;
    }
    if (count > 0) {
      console.log(`  ${label.padEnd(12)} HIT     ${String(count).padStart(4)}  ${selector}`);
      return;
    }
  }
  console.log(`  ${label.padEnd(12)} MISS      --  tried ${candidates.length}: ${candidates.join(" | ")}`);
}

console.log(`\nfile: ${file}  (${(html.length / 1024).toFixed(0)} KB)`);

console.log("\npage-level selectors");
report("list", REVIEW_LIST);
report("card", REVIEW_CARD);
report("title", PRODUCT.title);
report("breadcrumb", PRODUCT.breadcrumb);
report("see-all", SEE_ALL_REVIEWS);
report("anchor", PANEL_ANCHOR);

const cards = Array.from(doc.querySelectorAll(REVIEW_CARD.find((s) => doc.querySelector(s)) ?? REVIEW_CARD[0]!));
console.log(`\nper-review selectors (across ${cards.length} card${cards.length === 1 ? "" : "s"})`);
for (const [field, candidates] of Object.entries(REVIEW_FIELD)) {
  const hits = cards.filter((card) => candidates.some((s) => card.querySelector(s))).length;
  const verdict = hits === 0 ? "MISS" : hits === cards.length ? "HIT " : "PART";
  console.log(`  ${field.padEnd(12)} ${verdict}    ${String(hits).padStart(4)}/${cards.length} cards`);
}

const product = scrapeProduct(doc);
const reviews = scrapeReviews(doc);

console.log("\nextraction");
console.log(`  product title   ${product.title || "(none)"}`);
console.log(`  category        ${product.category ?? "(none)"}`);
console.log(`  cards found     ${cards.length}`);
console.log(`  reviews parsed  ${reviews.length}`);
console.log(`  dropped         ${cards.length - reviews.length} (no body, or duplicate id)`);
console.log(`  see-all link    ${hasSeeAllReviewsLink(doc) ? "yes" : "no"}`);

const withRating = reviews.filter((r) => r.rating !== null).length;
const withDate = reviews.filter((r) => r.date !== null).length;
const normalisedDate = reviews.filter((r) => r.date && /^\d{4}-\d{2}-\d{2}$/.test(r.date)).length;
const verified = reviews.filter((r) => r.verified_purchase).length;
const withVotes = reviews.filter((r) => r.helpful_votes > 0).length;

console.log("\nfield coverage");
console.log(`  rating          ${withRating}/${reviews.length}`);
console.log(`  date present    ${withDate}/${reviews.length}  (normalised to ISO: ${normalisedDate})`);
console.log(`  verified badge  ${verified}/${reviews.length}`);
console.log(`  helpful votes   ${withVotes}/${reviews.length}`);

console.log("\nfirst three reviews");
for (const review of reviews.slice(0, 3)) {
  console.log(`  [${review.id}] ${review.rating ?? "-"}* ${review.date ?? "-"} ` +
    `${review.verified_purchase ? "verified" : "unverified"} votes=${review.helpful_votes}`);
  console.log(`      title: ${review.title || "(none)"}`);
  console.log(`      body:  ${review.body.slice(0, 100)}${review.body.length > 100 ? "..." : ""}`);
}
console.log("");
