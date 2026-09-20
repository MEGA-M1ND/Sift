/**
 * Point this at any saved Amazon page to find out which selectors actually hit.
 *
 *   npm run check-fixture -- fixtures/amazon-in-product-reviews.html
 *
 * It exists because the selectors in src/content/selectors.ts could not be
 * verified against a live page here. Save a real page, run this, and every
 * field reporting MISS is a selector to fix. No network, no API key.
 *
 * The analysis is the same `diagnose()` the extension runs on a real page, so
 * what this prints and what a user sees in their console cannot drift apart.
 */
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { diagnose, formatReport } from "../src/content/diagnose.js";
import { scrapeReviewCards } from "../src/content/scrape.js";

const file = process.argv[2];
if (!file) {
  console.error("usage: npm run check-fixture -- <path-to-saved-page.html>");
  process.exit(1);
}

const html = readFileSync(file, "utf8");
const window = new Window({ url: "https://www.amazon.in/" });
window.document.documentElement.innerHTML = html;
const doc = window.document as unknown as Document;

console.log(`\nfile: ${file}  (${(html.length / 1024).toFixed(0)} KB)\n`);

const report = diagnose(doc);
console.log(formatReport(report));

const reviews = scrapeReviewCards(doc).map((item) => item.review);
if (reviews.length > 0) {
  const withRating = reviews.filter((r) => r.rating !== null).length;
  const isoDates = reviews.filter((r) => r.date && /^\d{4}-\d{2}-\d{2}$/.test(r.date)).length;

  console.log("");
  console.log(`  rating parsed    ${withRating}/${reviews.length}`);
  console.log(`  dates normalised ${isoDates}/${reviews.length}`);
  console.log(`  verified badge   ${reviews.filter((r) => r.verified_purchase).length}/${reviews.length}`);
  console.log(`  helpful votes    ${reviews.filter((r) => r.helpful_votes > 0).length}/${reviews.length}`);

  console.log("\n  first three reviews");
  for (const review of reviews.slice(0, 3)) {
    console.log(
      `    [${review.id}] ${review.rating ?? "-"}* ${review.date ?? "-"} ` +
        `${review.verified_purchase ? "verified" : "unverified"} votes=${review.helpful_votes}`,
    );
    console.log(`        title: ${review.title || "(none)"}`);
    console.log(`        body:  ${review.body.slice(0, 90)}${review.body.length > 90 ? "..." : ""}`);
  }
}

console.log("");
// A non-zero exit makes this usable as a check, not just something to read.
if (!report.healthy) process.exitCode = 1;
