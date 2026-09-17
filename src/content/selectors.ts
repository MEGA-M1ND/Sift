/**
 * Every Amazon selector lives here. Amazon changes its markup often, so this file
 * is the blast radius: when extraction breaks, this is the only file to edit.
 *
 * PROVENANCE. Each entry is tagged with how well it is established:
 *
 *   [corroborated] Seen in the published scraper `amazon-buddy@2.2.45`
 *                  (lib/Amazon.js), which parses live Amazon pages. Second-hand
 *                  but not invented.
 *   [unverified]   Consistent with Amazon's long-standing `data-hook` scheme but
 *                  NOT confirmed against a live page in this environment, because
 *                  amazon.in and amazon.com are blocked by network egress policy.
 *
 * Nothing here has been checked against a page fetched by this project. Run
 * `npm run check-fixture -- <saved-page.html>` against a real saved page to find
 * out which of these actually hit. Treat [unverified] as a hypothesis.
 *
 * Each field lists CANDIDATES tried in order, so a single markup change degrades
 * one field instead of emptying the whole page.
 */

/** Containers holding the list of review cards. */
export const REVIEW_LIST: readonly string[] = [
  // [corroborated] The review list on /product-reviews/ pages.
  "#cm_cr-review_list",
  // [unverified] The reviews block embedded in a /dp/ product page.
  "#cm-cr-dp-review-list",
  // [unverified] Wrapper around the whole reviews section on /dp/.
  "#reviewsMedley",
];

/** A single review card within a list. */
export const REVIEW_CARD: readonly string[] = [
  // [unverified] The stable card marker; its `id` attribute carries the review id.
  '[data-hook="review"]',
  // [unverified] Older card class, still emitted on some locales.
  "div.review",
];

/** Fields within one review card. */
export const REVIEW_FIELD = {
  // [corroborated] amazon-buddy reads [data-hook="review-title"].
  title: ['[data-hook="review-title"] span:not([class])', '[data-hook="review-title"]', "a.review-title", "span.review-title"],
  // [corroborated] amazon-buddy reads [data-hook="review-body"].
  body: ['[data-hook="review-body"] span', '[data-hook="review-body"]', "span.review-text-content", "span.review-text"],
  // [corroborated] amazon-buddy reads [data-hook="review-star-rating"].
  rating: ['[data-hook="review-star-rating"]', '[data-hook="cmps-review-star-rating"]', "i.review-rating", "i[class*='a-star-']"],
  // [corroborated] amazon-buddy reads [data-hook="review-date"].
  date: ['[data-hook="review-date"]'],
  // [unverified] The "Verified Purchase" badge.
  verified: ['[data-hook="avp-badge"]', "span.a-declarative [data-hook='avp-badge']"],
  // [unverified] "N people found this helpful".
  helpful: ['[data-hook="helpful-vote-statement"]'],
} as const satisfies Record<string, readonly string[]>;

/** Product-level fields, read from the /dp/ page. */
export const PRODUCT = {
  // [unverified] The H1 product title on a product detail page.
  title: ["#productTitle", "#title span", "h1#title"],
  // [unverified] Breadcrumb trail; its last link is the narrowest category.
  breadcrumb: [
    "#wayfinding-breadcrumbs_feature_div ul li:last-of-type a",
    "#wayfinding-breadcrumbs_container ul li:last-of-type a",
    "a.a-link-normal.a-color-tertiary",
  ],
} as const satisfies Record<string, readonly string[]>;

/** Link to the full reviews page, used to decide whether pagination is possible. */
export const SEE_ALL_REVIEWS: readonly string[] = [
  // [unverified] The "See more reviews" / "See all reviews" footer link.
  '[data-hook="see-all-reviews-link-foot"]',
  'a[href*="/product-reviews/"]',
];

/** Where the panel is injected: directly above the reviews section. */
export const PANEL_ANCHOR: readonly string[] = [
  // [unverified] Anchor points on /dp/ and /product-reviews/ respectively.
  "#reviewsMedley",
  "#cm_cr-review_list",
];

/** First matching element for an ordered candidate list. */
export function queryFirst(root: ParentNode, candidates: readonly string[]): Element | null {
  for (const selector of candidates) {
    const found = root.querySelector(selector);
    if (found) return found;
  }
  return null;
}

/** Matches for the first candidate that finds anything at all. */
export function queryAll(root: ParentNode, candidates: readonly string[]): Element[] {
  for (const selector of candidates) {
    const found = Array.from(root.querySelectorAll(selector));
    if (found.length > 0) return found;
  }
  return [];
}

/** Trimmed, whitespace-collapsed text of the first matching candidate. */
export function textOf(root: ParentNode, candidates: readonly string[]): string {
  const element = queryFirst(root, candidates);
  return (element?.textContent ?? "").replace(/\s+/g, " ").trim();
}
