/**
 * DOM -> the state shape we send for scoring. Takes a `Document` rather than
 * touching globals, so the same code runs in the content script, in tests, and
 * over a fetched pagination page.
 *
 * Every field degrades on its own: a review with an unreadable date is still a
 * review. Only a missing body disqualifies a card, because body text is the
 * evidence every question is asked about.
 */
import type { ProductContext, Review } from "../shared/types.js";
import {
  PRODUCT,
  REVIEW_CARD,
  REVIEW_FIELD,
  REVIEW_LIST,
  SEE_ALL_REVIEWS,
  queryAll,
  queryFirst,
  textOf,
} from "./selectors.js";

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/** "4.0 out of 5 stars" -> 4. Falls back to an `a-star-4`-style class. */
export function parseRating(text: string, className = ""): number | null {
  const outOf = /(\d+(?:[.,]\d+)?)\s*out of\s*5/i.exec(text);
  if (outOf?.[1]) {
    const value = Number(outOf[1].replace(",", "."));
    if (value >= 0 && value <= 5) return Math.round(value);
  }
  // Class form: a-star-4, a-star-medium-4, a-star-4-5.
  const fromClass = /a-star-(?:[a-z]+-)?(\d)(?:-(\d))?/i.exec(className);
  if (fromClass?.[1]) {
    const whole = Number(fromClass[1]);
    const half = fromClass[2] ? Number(fromClass[2]) / 10 : 0;
    const value = Math.round(whole + half);
    if (value >= 1 && value <= 5) return value;
  }
  return null;
}

/** "17 people found this helpful" -> 17. "One person found this helpful" -> 1. */
export function parseHelpfulVotes(text: string): number {
  if (!text) return 0;
  if (/^\s*one person/i.test(text)) return 1;
  const match = /([\d][\d,.\s]*)\s*(?:people|person|customer)/i.exec(text);
  if (!match?.[1]) return 0;
  const digits = match[1].replace(/[^\d]/g, "");
  if (!digits) return 0;
  const value = Number.parseInt(digits, 10);
  return Number.isFinite(value) ? value : 0;
}

/**
 * "Reviewed in India on 4 March 2026"              -> "2026-03-04"
 * "Reviewed in the United States on March 4, 2026" -> "2026-03-04"
 * Returns the trimmed original when the shape is not recognised: a date we
 * cannot normalise is still better context than nothing.
 */
export function parseReviewDate(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const after = /\bon\b\s+(.*)$/i.exec(trimmed)?.[1] ?? trimmed;

  const dmy = /^(\d{1,2})\s+([A-Za-z]+)\.?,?\s+(\d{4})/.exec(after);
  const mdy = /^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(after);

  let day: number | undefined;
  let monthName: string | undefined;
  let year: number | undefined;

  if (dmy?.[1] && dmy[2] && dmy[3]) {
    day = Number(dmy[1]);
    monthName = dmy[2];
    year = Number(dmy[3]);
  } else if (mdy?.[1] && mdy[2] && mdy[3]) {
    monthName = mdy[1];
    day = Number(mdy[2]);
    year = Number(mdy[3]);
  }

  if (day === undefined || monthName === undefined || year === undefined) return trimmed;
  const prefix = monthName.toLowerCase().slice(0, 3);
  const monthIndex = MONTHS.findIndex((m) => m.startsWith(prefix));
  if (monthIndex < 0 || day < 1 || day > 31) return trimmed;

  const pad = (n: number) => String(n).padStart(2, "0");
  return `${year}-${pad(monthIndex + 1)}-${pad(day)}`;
}

/** Stable fallback id for a card with no id attribute, so caching still works. */
function syntheticId(title: string, body: string): string {
  let hash = 5381;
  const source = `${title}|${body}`;
  for (let i = 0; i < source.length; i += 1) hash = ((hash << 5) + hash + source.charCodeAt(i)) | 0;
  return `sift-${(hash >>> 0).toString(36)}`;
}

/** Amazon puts the review id on the card's `id`; a data attribute is the fallback. */
function reviewIdOf(card: Element, title: string, body: string): string {
  const fromData = card.getAttribute("data-review-id");
  if (fromData) return fromData;
  const fromId = card.getAttribute("id");
  if (fromId) return fromId;
  return syntheticId(title, body);
}

/** Parse one review card. Returns null when there is no body text to score. */
export function parseReviewCard(card: Element): Review | null {
  const body = textOf(card, REVIEW_FIELD.body);
  if (!body) return null;

  const title = textOf(card, REVIEW_FIELD.title);
  const ratingElement = queryFirst(card, REVIEW_FIELD.rating);
  const rating = parseRating(
    (ratingElement?.textContent ?? "").replace(/\s+/g, " ").trim(),
    ratingElement?.getAttribute("class") ?? "",
  );

  return {
    id: reviewIdOf(card, title, body),
    title,
    body,
    rating,
    verified_purchase: queryFirst(card, REVIEW_FIELD.verified) !== null,
    date: parseReviewDate(textOf(card, REVIEW_FIELD.date)),
    helpful_votes: parseHelpfulVotes(textOf(card, REVIEW_FIELD.helpful)),
  };
}

/** A parsed review together with the element it came from. */
export interface ScrapedCard {
  review: Review;
  card: Element;
}

/**
 * All reviews currently in the DOM, in page order, deduplicated by id, each
 * paired with its element so the UI can badge and reorder it later.
 * Searches within the known list containers first, then falls back to scanning
 * the whole document for review cards.
 */
export function scrapeReviewCards(root: ParentNode): ScrapedCard[] {
  const lists = queryAll(root, REVIEW_LIST);
  const cards =
    lists.length > 0 ? lists.flatMap((list) => queryAll(list, REVIEW_CARD)) : queryAll(root, REVIEW_CARD);

  const seen = new Set<string>();
  const scraped: ScrapedCard[] = [];
  for (const card of cards) {
    const review = parseReviewCard(card);
    if (!review || seen.has(review.id)) continue;
    seen.add(review.id);
    scraped.push({ review, card });
  }
  return scraped;
}

/** All reviews currently in the DOM, in page order, deduplicated by id. */
export function scrapeReviews(root: ParentNode): Review[] {
  return scrapeReviewCards(root).map((item) => item.review);
}

/** Product title and narrowest breadcrumb category. */
export function scrapeProduct(root: ParentNode): ProductContext {
  return {
    title: textOf(root, PRODUCT.title),
    category: textOf(root, PRODUCT.breadcrumb) || null,
  };
}

/** Whether the page offers a route to more reviews than are rendered. */
export function hasSeeAllReviewsLink(root: ParentNode): boolean {
  return queryFirst(root, SEE_ALL_REVIEWS) !== null;
}
