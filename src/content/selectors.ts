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

/**
 * Containers holding the list of review cards.
 *
 * Tried in order, and a container is only accepted if it actually contains
 * cards, so an empty or wrong match falls through to the next.
 */
export const REVIEW_LIST: readonly string[] = [
  // [corroborated] The review list on /product-reviews/ pages.
  "#cm_cr-review_list",
  // [unverified] The reviews block embedded in a /dp/ product page.
  "#cm-cr-dp-review-list",
  // [speculative] Hyphen/underscore variants of the same two ids. Amazon is not
  // consistent between them, and a one-character change should not cost a page.
  "#cm-cr-review-list",
  "#cm_cr-dp-review-list",
  // [unverified] Wrapper around the whole reviews section on /dp/.
  "#reviewsMedley",
  // [speculative] Structural last resort before the document-wide scan: any
  // element that directly holds review cards.
  "div:has(> [data-hook=\"review\"])",
];

/**
 * A single review card within a list.
 *
 * Widening here is cheap: `parseReviewCard` drops anything without body text,
 * so a card selector that matches something else costs nothing but a cycle.
 */
export const REVIEW_CARD: readonly string[] = [
  // [unverified] The stable card marker; its `id` attribute carries the review id.
  '[data-hook="review"]',
  // [speculative] Same marker on a list item rather than a div, and the
  // "other countries" variant Amazon renders in a separate block.
  '[data-hook="cr-non-verified-purchase-review"]',
  '[data-hook="review-collapsed"]',
  // [unverified] Older card class, still emitted on some locales.
  "div.review",
  // [speculative] Any element carrying a review body, walked up to its card.
  '[id^="R"]:has([data-hook="review-body"])',
];

/** Fields within one review card. */
export const REVIEW_FIELD = {
  // [corroborated] amazon-buddy reads [data-hook="review-title"].
  //
  // The first entry is precise but brittle: it breaks the moment Amazon adds a
  // class to that span. The next two survive that, and the bare hook is last
  // because its text includes the star rating ("2.0 out of 5 stars Title").
  title: [
    '[data-hook="review-title"] span:not([class])',
    '[data-hook="review-title"] > span:last-of-type', // [speculative]
    '[data-hook="review-title"] span:not(.a-icon-alt):not(.a-letter-space)', // [speculative]
    '[data-hook="review-title-content"] span', // [speculative]
    '[data-hook="review-title"]',
    "a.review-title",
    "span.review-title",
  ],
  // [corroborated] amazon-buddy reads [data-hook="review-body"].
  body: [
    '[data-hook="review-body"] span',
    '[data-hook="review-body"] .a-expander-content', // [speculative] collapsed long reviews
    '[data-hook="review-body"]',
    '[data-hook="review-collapsed"] span', // [speculative]
    "span.review-text-content",
    "span.review-text",
    "div.reviewText", // [speculative] older markup
  ],
  // [corroborated] amazon-buddy reads [data-hook="review-star-rating"].
  //
  // Each candidate is tried until one yields a parseable rating, so an entry
  // that matches an element with neither readable text nor a star class is
  // skipped rather than accepted as "no rating".
  rating: [
    '[data-hook="review-star-rating"]',
    '[data-hook="cmps-review-star-rating"]',
    '[data-hook="review-star-rating"] .a-icon-alt', // [speculative]
    '[data-hook*="review-star-rating"]', // [speculative] covers future hook names
    "i.review-rating",
    "i[class*='a-star-']",
    "span.a-icon-alt", // [speculative] last resort, text-only
  ],
  // [corroborated] amazon-buddy reads [data-hook="review-date"].
  date: [
    '[data-hook="review-date"]',
    '[data-hook*="review-date"]', // [speculative]
    "span.review-date", // [speculative] older markup
  ],
  // [unverified] The "Verified Purchase" badge.
  verified: [
    '[data-hook="avp-badge"]',
    '[data-hook="avp-badge-linkless"]', // [speculative]
    '[data-hook*="avp-badge"]', // [speculative]
    "span.a-declarative [data-hook='avp-badge']",
  ],
  // [unverified] "N people found this helpful".
  helpful: [
    '[data-hook="helpful-vote-statement"]',
    '[data-hook*="helpful"]', // [speculative]
    "span.cr-vote-text", // [speculative] older markup
  ],
} as const satisfies Record<string, readonly string[]>;

/** Product-level fields, read from the /dp/ page. */
export const PRODUCT = {
  // [unverified] The H1 product title on a product detail page.
  title: [
    "#productTitle",
    "#title span",
    "h1#title",
    "#titleSection #productTitle", // [speculative]
    'span[data-hook="product-link"]', // [speculative] on /product-reviews/ pages
  ],
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
  '[data-hook*="see-all-reviews"]', // [speculative]
  'a[href*="/product-reviews/"]',
];

/** Where the panel is injected: directly above the reviews section. */
export const PANEL_ANCHOR: readonly string[] = [
  // [unverified] Anchor points on /dp/ and /product-reviews/ respectively.
  "#reviewsMedley",
  "#cm_cr-review_list",
];

/**
 * Matches for one selector, treating an unusable selector as a miss.
 *
 * The candidate lists contain modern syntax such as `:has()`. An engine that
 * does not support one throws on `querySelectorAll`, and an uncaught throw here
 * would take out scraping entirely rather than costing a single candidate. A
 * selector we cannot run is a selector that did not match.
 */
function matchAll(root: ParentNode, selector: string): Element[] {
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    return [];
  }
}

/** First matching element for an ordered candidate list. */
export function queryFirst(root: ParentNode, candidates: readonly string[]): Element | null {
  for (const selector of candidates) {
    const found = matchAll(root, selector)[0];
    if (found) return found;
  }
  return null;
}

/** Matches for the first candidate that finds anything at all. */
export function queryAll(root: ParentNode, candidates: readonly string[]): Element[] {
  for (const selector of candidates) {
    const found = matchAll(root, selector);
    if (found.length > 0) return found;
  }
  return [];
}

/** Trimmed and whitespace-collapsed. */
function cleanText(element: Element | null): string {
  return (element?.textContent ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Text of the first candidate that yields any, trying every element a candidate
 * matches before moving on.
 *
 * Taking the first matching element regardless of its content is what makes a
 * widened candidate list dangerous: Amazon's review title anchor contains a
 * spacer span, so a broader selector matched it, found nothing, and the title
 * came back empty while a perfectly good later candidate went untried. An empty
 * match is not an answer.
 */
export function textOf(root: ParentNode, candidates: readonly string[]): string {
  for (const selector of candidates) {
    for (const element of matchAll(root, selector)) {
      const text = cleanText(element);
      if (text) return text;
    }
  }
  return "";
}

/**
 * First element from these candidates that satisfies `accept`.
 *
 * Same reasoning as `textOf`: a candidate that matches an element we cannot use
 * must not stop us trying the rest.
 */
export function queryFirstUsable(
  root: ParentNode,
  candidates: readonly string[],
  accept: (element: Element) => boolean,
): Element | null {
  for (const selector of candidates) {
    for (const element of matchAll(root, selector)) {
      if (accept(element)) return element;
    }
  }
  return null;
}
