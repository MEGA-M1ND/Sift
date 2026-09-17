/**
 * Page detection. Pure URL work, no DOM: this decides whether Sift runs at all,
 * so it stays strict. Anything not matched here is left completely untouched.
 */

/** The two sites v1 supports. Nothing else, per spec. */
export type Site = "amazon.in" | "amazon.com";

export type PageKind =
  /** Product detail page: /dp/ASIN or /gp/product/ASIN. */
  | "product"
  /** The "see all reviews" page: /product-reviews/ASIN. */
  | "reviews";

export interface PageTarget {
  site: Site;
  kind: PageKind;
  /** Amazon Standard Identification Number: 10 chars, letters and digits. */
  asin: string;
}

/** Amazon hosts we act on, with or without a `www.` (or other) subdomain. */
const SITE_HOSTS: Record<Site, RegExp> = {
  "amazon.in": /(^|\.)amazon\.in$/i,
  "amazon.com": /(^|\.)amazon\.com$/i,
};

/**
 * ASIN as it appears in a path segment. Amazon uses 10 uppercase alphanumerics
 * (ISBN-10s for books can end in X), so accept exactly 10 of [A-Z0-9].
 */
const ASIN = "([A-Z0-9]{10})";

/** Ordered so the more specific reviews path is tested before the product paths. */
const PATHS: Array<{ kind: PageKind; re: RegExp }> = [
  { kind: "reviews", re: new RegExp(`/product-reviews/${ASIN}(?:[/?#]|$)`, "i") },
  { kind: "product", re: new RegExp(`/dp/${ASIN}(?:[/?#]|$)`, "i") },
  // /gp/product/ is the older product-detail path and still serves live pages.
  { kind: "product", re: new RegExp(`/gp/product/${ASIN}(?:[/?#]|$)`, "i") },
];

function siteOf(hostname: string): Site | null {
  for (const [site, re] of Object.entries(SITE_HOSTS)) {
    if (re.test(hostname)) return site as Site;
  }
  return null;
}

/**
 * Identify a page, or return null when Sift must stay out of the way.
 * Accepts a full URL string; invalid URLs are simply "not ours".
 */
export function detectPage(href: string): PageTarget | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  const site = siteOf(url.hostname);
  if (!site) return null;

  for (const { kind, re } of PATHS) {
    const match = re.exec(url.pathname);
    if (match?.[1]) return { site, kind, asin: match[1].toUpperCase() };
  }
  return null;
}

/**
 * URL of the paginated review list for a product. Amazon serves these on the
 * same origin, so the content script can fetch them without a cross-origin hop.
 */
export function reviewsPageUrl(target: PageTarget, page: number): string {
  const params = new URLSearchParams({
    ie: "UTF8",
    reviewerType: "all_reviews",
    pageNumber: String(page),
  });
  return `https://www.${target.site}/product-reviews/${target.asin}/?${params.toString()}`;
}
