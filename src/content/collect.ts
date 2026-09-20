/**
 * Gathering reviews beyond what the page rendered.
 *
 * Runs in the content script so the requests are same-origin and carry the
 * user's own session, exactly as if they had clicked through. Amazon may still
 * refuse: it commonly redirects anonymous pagination to a sign-in page. That is
 * an expected outcome, not an error, so we stop and keep what we already have.
 */
import { reviewsPageUrl, type PageTarget } from "./page.js";
import { scrapeReviews } from "./scrape.js";
import type { Review } from "../shared/types.js";

/** Spec default: never collect more than this many reviews from one page. */
export const DEFAULT_REVIEW_CAP = 300;

/** Amazon serves 10 reviews per page; a page yielding none means we are done. */
const MAX_PAGES = 60;

/**
 * Pause between pagination requests.
 *
 * Thirty same-origin requests fired back to back is what scraping looks like,
 * and the account being throttled or shown a CAPTCHA is the user's problem, not
 * ours to cause. This is roughly a fast human clicking "next page", and the
 * reviews already on screen are scored while this runs, so the wait is not felt.
 */
const PAGE_DELAY_MS = 600;
const PAGE_DELAY_JITTER_MS = 400;

function pageDelay(): Promise<void> {
  const wait = PAGE_DELAY_MS + Math.random() * PAGE_DELAY_JITTER_MS;
  return new Promise((resolve) => setTimeout(resolve, wait));
}

export type StopReason =
  /** Hit the configured review cap. */
  | "cap"
  /** Amazon stopped giving us reviews: no more pages, or an empty page. */
  | "exhausted"
  /** Amazon asked for a login, or refused the request. */
  | "blocked"
  /** The page offered no route to more reviews. */
  | "no_pagination"
  /** A network or parse failure. */
  | "error";

export interface CollectResult {
  reviews: Review[];
  /** How many reviews came from the rendered DOM, before any fetching. */
  fromDom: number;
  /** How many extra pages were successfully fetched and parsed. */
  pagesFetched: number;
  stopped: StopReason;
  /** Present when `stopped` is "blocked" or "error". */
  detail?: string;
}

export interface CollectOptions {
  target: PageTarget;
  /** Reviews already rendered on the page. */
  initial: Review[];
  /** Whether the page offers a "see all reviews" route. */
  canPaginate: boolean;
  cap?: number;
  /** Injected so tests never touch the network. Defaults to same-origin fetch. */
  fetchPage?: (url: string) => Promise<Response>;
  /** Injected for tests; defaults to DOMParser. */
  parseHtml?: (html: string) => Document;
  /** Injected so tests do not sit through the pacing delay. */
  delay?: () => Promise<void>;
}

/** A sign-in redirect is how Amazon usually refuses anonymous pagination. */
function looksLikeSignIn(response: Response, html: string): boolean {
  if (/\/ap\/signin/.test(response.url)) return true;
  // Some locales serve 200 with a sign-in form rather than redirecting.
  return /name="signIn"|id="ap_email"|action="[^"]*\/ap\/signin/.test(html.slice(0, 20_000));
}

function defaultParseHtml(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

/**
 * Collect up to `cap` reviews, starting from what is already on the page.
 * Never throws: every failure becomes a `stopped` reason with what we gathered.
 */
export async function collectReviews(options: CollectOptions): Promise<CollectResult> {
  const cap = options.cap ?? DEFAULT_REVIEW_CAP;
  const fetchPage = options.fetchPage ?? ((url: string) => fetch(url, { credentials: "include" }));
  const parseHtml = options.parseHtml ?? defaultParseHtml;
  const delay = options.delay ?? pageDelay;

  const seen = new Set<string>();
  const reviews: Review[] = [];
  for (const review of options.initial) {
    if (reviews.length >= cap) break;
    if (seen.has(review.id)) continue;
    seen.add(review.id);
    reviews.push(review);
  }
  const fromDom = reviews.length;

  const done = (stopped: StopReason, pagesFetched: number, detail?: string): CollectResult => ({
    reviews,
    fromDom,
    pagesFetched,
    stopped,
    ...(detail === undefined ? {} : { detail }),
  });

  if (reviews.length >= cap) return done("cap", 0);
  if (!options.canPaginate) return done("no_pagination", 0);

  let pagesFetched = 0;
  // Page 1 is what the product page already showed, so start at 2. On a
  // /product-reviews/ page the visible list is also page 1 unless the user
  // navigated, which is handled by dedupe rather than by guessing.
  for (let page = 2; page <= MAX_PAGES; page += 1) {
    // Pace ourselves before every fetch, including the first extra page.
    await delay();

    let response: Response;
    let html: string;
    try {
      response = await fetchPage(reviewsPageUrl(options.target, page));
      if (response.status === 401 || response.status === 403 || response.status === 429) {
        return done("blocked", pagesFetched, `HTTP ${response.status}`);
      }
      if (!response.ok) return done("error", pagesFetched, `HTTP ${response.status}`);
      html = await response.text();
    } catch (error) {
      return done("error", pagesFetched, error instanceof Error ? error.message : String(error));
    }

    if (looksLikeSignIn(response, html)) return done("blocked", pagesFetched, "sign-in required");

    let parsed: Review[];
    try {
      parsed = scrapeReviews(parseHtml(html));
    } catch (error) {
      return done("error", pagesFetched, error instanceof Error ? error.message : String(error));
    }

    pagesFetched += 1;

    let added = 0;
    for (const review of parsed) {
      if (reviews.length >= cap) break;
      if (seen.has(review.id)) continue;
      seen.add(review.id);
      reviews.push(review);
      added += 1;
    }

    if (reviews.length >= cap) return done("cap", pagesFetched);
    // No new reviews means Amazon is repeating itself or has run out.
    if (added === 0) return done("exhausted", pagesFetched);
  }

  return done("exhausted", pagesFetched);
}
