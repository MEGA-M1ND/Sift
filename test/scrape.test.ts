/**
 * Parser tests.
 *
 * NOTE ON WHAT THESE PROVE. The fixtures are synthetic (see fixtures/README.md);
 * amazon.in and amazon.com are blocked by network egress policy here, so no real
 * page could be saved. These tests cover normalisation, fallback chains, dedupe,
 * malformed cards and the state mapping. They do NOT show that the selectors match
 * live Amazon markup. Replace the fixtures with real saved pages to learn that.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  hasSeeAllReviewsLink,
  parseHelpfulVotes,
  parseRating,
  parseReviewDate,
  scrapeProduct,
  scrapeReviews,
} from "../src/content/scrape.js";
import { toState } from "../src/shared/types.js";

function load(name: string): Document {
  const html = readFileSync(resolve(process.cwd(), "fixtures", name), "utf8");
  return new DOMParser().parseFromString(html, "text/html");
}

describe("parseRating", () => {
  it("reads the usual star text", () => {
    expect(parseRating("2.0 out of 5 stars")).toBe(2);
    expect(parseRating("5.0 out of 5 stars")).toBe(5);
  });

  it("reads a decimal-comma locale", () => {
    expect(parseRating("4,0 out of 5 stars")).toBe(4);
  });

  it("rounds a half star to the nearest whole", () => {
    expect(parseRating("3.5 out of 5 stars")).toBe(4);
  });

  it("falls back to the icon class when there is no text", () => {
    expect(parseRating("", "a-icon a-star-4")).toBe(4);
    expect(parseRating("", "a-icon a-star-medium-3")).toBe(3);
    expect(parseRating("", "a-icon a-star-3-5")).toBe(4);
  });

  it("returns null rather than inventing a rating", () => {
    expect(parseRating("")).toBeNull();
    expect(parseRating("no stars here", "a-icon")).toBeNull();
    expect(parseRating("9 out of 5 stars")).toBeNull();
  });
});

describe("parseHelpfulVotes", () => {
  it("reads a plain count", () => {
    expect(parseHelpfulVotes("17 people found this helpful")).toBe(17);
  });

  it("reads the singular form", () => {
    expect(parseHelpfulVotes("One person found this helpful")).toBe(1);
    expect(parseHelpfulVotes("1 person found this helpful")).toBe(1);
  });

  it("reads a grouped thousands separator", () => {
    expect(parseHelpfulVotes("1,204 people found this helpful")).toBe(1204);
    expect(parseHelpfulVotes("12,345 people found this helpful")).toBe(12345);
  });

  it("is zero when absent or unreadable", () => {
    expect(parseHelpfulVotes("")).toBe(0);
    expect(parseHelpfulVotes("Helpful")).toBe(0);
  });
});

describe("parseReviewDate", () => {
  it("normalises the amazon.in day-month-year form", () => {
    expect(parseReviewDate("Reviewed in India on 4 March 2026")).toBe("2026-03-04");
    expect(parseReviewDate("Reviewed in India on 19 May 2026")).toBe("2026-05-19");
  });

  it("normalises the amazon.com month-day-year form", () => {
    expect(parseReviewDate("Reviewed in the United States on March 4, 2026")).toBe("2026-03-04");
    expect(parseReviewDate("Reviewed in the United States on December 31, 2025")).toBe("2025-12-31");
  });

  it("handles an abbreviated month", () => {
    expect(parseReviewDate("Reviewed in India on 4 Mar 2026")).toBe("2026-03-04");
  });

  it("keeps text it cannot parse rather than discarding context", () => {
    expect(parseReviewDate("Reviewed recently")).toBe("Reviewed recently");
  });

  it("is null only when there is nothing at all", () => {
    expect(parseReviewDate("")).toBeNull();
    expect(parseReviewDate("   ")).toBeNull();
  });
});

describe("scrapeReviews on the amazon.in reviews fixture", () => {
  let doc: Document;
  beforeAll(() => {
    doc = load("amazon-in-product-reviews.html");
  });

  it("drops the duplicate id and the card with no body", () => {
    // Six cards in the fixture; one duplicates an id, one has no body.
    expect(doc.querySelectorAll('[data-hook="review"]').length).toBe(6);
    expect(scrapeReviews(doc)).toHaveLength(4);
  });

  it("extracts the first review in full", () => {
    const review = scrapeReviews(doc)[0]!;
    expect(review.id).toBe("R1A2B3C4D5E6F7");
    expect(review.title).toBe("Battery was dead within ten months");
    expect(review.body).toContain("month ten the battery went from a full day of work");
    expect(review.rating).toBe(2);
    expect(review.verified_purchase).toBe(true);
    expect(review.date).toBe("2026-03-04");
    expect(review.helpful_votes).toBe(17);
  });

  it("does not leak the star-rating text into the title", () => {
    // The title anchor also contains "2.0 out of 5 stars" in real markup.
    expect(scrapeReviews(doc)[0]!.title).not.toContain("out of 5");
  });

  it("keeps a review whose rating is missing", () => {
    const review = scrapeReviews(doc).find((r) => r.id === "R7Z8Y9X0W1V2U3")!;
    expect(review.rating).toBeNull();
    expect(review.body).toContain("Fine for light DIY");
    expect(review.helpful_votes).toBe(1);
  });

  it("keeps a review whose date is unparseable", () => {
    const review = scrapeReviews(doc).find((r) => r.id === "RABCDEF1234567")!;
    expect(review.date).toBe("Reviewed recently");
    expect(review.rating).toBe(5);
  });

  it("collapses whitespace in body text", () => {
    for (const review of scrapeReviews(doc)) {
      expect(review.body).not.toMatch(/\s{2,}/);
      expect(review.body).toBe(review.body.trim());
    }
  });

  it("reports no see-all link on a reviews page that has none", () => {
    expect(hasSeeAllReviewsLink(doc)).toBe(false);
  });
});

describe("scrapeReviews on the amazon.com product fixture", () => {
  let doc: Document;
  beforeAll(() => {
    doc = load("amazon-com-dp.html");
  });

  it("finds the reviews embedded in the detail page", () => {
    expect(scrapeReviews(doc)).toHaveLength(3);
  });

  it("reads the product title and the narrowest breadcrumb category", () => {
    const product = scrapeProduct(doc);
    expect(product.title).toBe("AcmeDrive 20V Cordless Drill with 2 Li-ion Batteries");
    expect(product.category).toBe("Drills & Drivers");
  });

  it("parses US-format dates", () => {
    expect(scrapeReviews(doc)[0]!.date).toBe("2026-04-11");
  });

  it("synthesises a stable id for a card that has none", () => {
    const review = scrapeReviews(doc)[2]!;
    expect(review.id).toMatch(/^sift-/);
    // Stable across runs, so the cache still works for this review.
    expect(scrapeReviews(load("amazon-com-dp.html"))[2]!.id).toBe(review.id);
  });

  it("reads a rating expressed only in the icon class", () => {
    expect(scrapeReviews(doc)[2]!.rating).toBe(4);
  });

  it("sees the see-all-reviews link", () => {
    expect(hasSeeAllReviewsLink(doc)).toBe(true);
  });

  it("maps a review into the documented state shape, without the id", () => {
    const state = toState(scrapeProduct(doc), scrapeReviews(doc)[0]!);
    expect(Object.keys(state).sort()).toEqual(["product", "review"]);
    expect(state.review).not.toHaveProperty("id");
    expect(Object.keys(state.review).sort()).toEqual([
      "body", "date", "helpful_votes", "rating", "title", "verified_purchase",
    ]);
    expect(state.product.title).toContain("AcmeDrive");
  });
});

describe("resilience", () => {
  it("returns nothing, and does not throw, on a page with no reviews", () => {
    const doc = new DOMParser().parseFromString("<html><body><h1>Hello</h1></body></html>", "text/html");
    expect(scrapeReviews(doc)).toEqual([]);
    expect(hasSeeAllReviewsLink(doc)).toBe(false);
  });

  it("returns empty product fields rather than throwing when markup is missing", () => {
    const doc = new DOMParser().parseFromString("<html><body></body></html>", "text/html");
    expect(scrapeProduct(doc)).toEqual({ title: "", category: null });
  });

  it("still finds cards when the known list containers are gone", () => {
    // Markup drift: the wrapper id changed, but the cards did not.
    const doc = new DOMParser().parseFromString(
      `<html><body><div id="something-new">
        <div data-hook="review" id="RX1"><span data-hook="review-body"><span>Body one</span></span></div>
        <div data-hook="review" id="RX2"><span data-hook="review-body"><span>Body two</span></span></div>
      </div></body></html>`,
      "text/html",
    );
    expect(scrapeReviews(doc).map((r) => r.id)).toEqual(["RX1", "RX2"]);
  });

  it("falls back to the older review class when data-hook is gone", () => {
    const doc = new DOMParser().parseFromString(
      `<html><body><div id="cm_cr-review_list">
        <div class="review" id="RY1"><span class="review-text-content"><span>Older markup body</span></span></div>
      </div></body></html>`,
      "text/html",
    );
    const reviews = scrapeReviews(doc);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.body).toBe("Older markup body");
  });
});
