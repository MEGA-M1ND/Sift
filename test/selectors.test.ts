/**
 * Candidate-list behaviour.
 *
 * Widening a selector list is only safe if a bad candidate falls through
 * instead of winning. These tests are the safety net for that: they cover the
 * fall-through rules, the markup variants the widened lists are meant to
 * survive, and — most importantly — the cases where a broad candidate must NOT
 * match, because wrong data gets scored and billed while missing data does not.
 */
import { describe, expect, it } from "vitest";
import { queryAll, queryFirstUsable, textOf } from "../src/content/selectors.js";
import { parseReviewCard, scrapeProduct, scrapeReviews } from "../src/content/scrape.js";

const parse = (html: string) => new DOMParser().parseFromString(html, "text/html");
const el = (html: string) => parse(`<div id="root">${html}</div>`).querySelector("#root")!;

describe("textOf falls through", () => {
  it("skips a candidate that matches an element with no text", () => {
    const card = el('<span class="empty"></span><span class="real">Real text</span>');
    expect(textOf(card, ["span.empty", "span.real"])).toBe("Real text");
  });

  it("skips an empty element and takes a later one matched by the same candidate", () => {
    // Amazon's title anchor holds a spacer span before the real one.
    const card = el('<a data-hook="t"><span class="sp"></span><span>Title here</span></a>');
    expect(textOf(card, ['[data-hook="t"] span'])).toBe("Title here");
  });

  it("collapses whitespace", () => {
    expect(textOf(el("<p>  lots\n   of   space  </p>"), ["p"])).toBe("lots of space");
  });

  it("is empty when nothing matches", () => {
    expect(textOf(el("<p>x</p>"), ["div.nope"])).toBe("");
  });

  it("treats an unusable selector as a miss rather than throwing", () => {
    // An engine without :has() throws; that must cost one candidate, not the page.
    expect(textOf(el("<p>found</p>"), ["div:has(", "p"])).toBe("found");
  });
});

describe("queryFirstUsable falls through", () => {
  it("skips matches the caller rejects", () => {
    const card = el('<i class="a">no</i><i class="b">yes</i>');
    const found = queryFirstUsable(card, ["i"], (element) => element.textContent === "yes");
    expect(found?.className).toBe("b");
  });

  it("is null when no match is acceptable", () => {
    expect(queryFirstUsable(el("<i>x</i>"), ["i"], () => false)).toBeNull();
  });
});

describe("queryAll", () => {
  it("returns matches for the first candidate that finds anything", () => {
    const root = el('<div class="b">1</div><div class="b">2</div>');
    expect(queryAll(root, ["div.a", "div.b"])).toHaveLength(2);
  });

  it("survives an unusable selector", () => {
    expect(queryAll(el("<p>x</p>"), ["p:has(", "p"])).toHaveLength(1);
  });
});

describe("markup variants the widened lists should now survive", () => {
  const body = '<span data-hook="review-body"><span>A perfectly ordinary review body.</span></span>';

  it("reads a title whose span has picked up a class", () => {
    // The original selector was span:not([class]); one added class broke it.
    const card = el(
      `<div data-hook="review" id="R1">
         <a data-hook="review-title"><span class="cr-original-review-title">Still readable</span></a>
         ${body}
       </div>`,
    ).firstElementChild!;
    expect(parseReviewCard(card)?.title).toBe("Still readable");
  });

  it("does not take the star text as the title when a class appears", () => {
    const card = el(
      `<div data-hook="review" id="R1">
         <a data-hook="review-title">
           <i class="a-icon"><span class="a-icon-alt">4.0 out of 5 stars</span></i>
           <span class="new-class">The actual title</span>
         </a>
         ${body}
       </div>`,
    ).firstElementChild!;
    expect(parseReviewCard(card)?.title).toBe("The actual title");
  });

  it("reads a body held in a collapsed expander", () => {
    const card = el(
      `<div data-hook="review" id="R1">
         <span data-hook="review-body"><div class="a-expander-content">Expanded text here.</div></span>
       </div>`,
    ).firstElementChild!;
    expect(parseReviewCard(card)?.body).toBe("Expanded text here.");
  });

  it("reads a rating when only a nested alt span carries it", () => {
    const card = el(
      `<div data-hook="review" id="R1">
         <i data-hook="review-star-rating"><span class="a-icon-alt">3.0 out of 5 stars</span></i>
         ${body}
       </div>`,
    ).firstElementChild!;
    expect(parseReviewCard(card)?.rating).toBe(3);
  });

  it("skips a star element that carries no usable rating and finds the one that does", () => {
    const card = el(
      `<div data-hook="review" id="R1">
         <i data-hook="review-star-rating" class="a-icon"></i>
         <i class="a-star-5"><span>5.0 out of 5 stars</span></i>
         ${body}
       </div>`,
    ).firstElementChild!;
    expect(parseReviewCard(card)?.rating).toBe(5);
  });

  it("reads a date under a renamed hook", () => {
    const card = el(
      `<div data-hook="review" id="R1">
         <span data-hook="review-date-v2">Reviewed in India on 4 March 2026</span>
         ${body}
       </div>`,
    ).firstElementChild!;
    expect(parseReviewCard(card)?.date).toBe("2026-03-04");
  });

  it("reads helpful votes under a renamed hook", () => {
    const card = el(
      `<div data-hook="review" id="R1">
         <span data-hook="helpful-vote-statement-v2">17 people found this helpful</span>
         ${body}
       </div>`,
    ).firstElementChild!;
    expect(parseReviewCard(card)?.helpful_votes).toBe(17);
  });

  it("finds reviews when the list container id has changed", () => {
    const doc = parse(
      `<html><body><div id="cm-cr-review-list">
         <div data-hook="review" id="R1">${body}</div>
       </div></body></html>`,
    );
    expect(scrapeReviews(doc)).toHaveLength(1);
  });

  it("does not let a matching but empty container shadow the real reviews", () => {
    // The exact failure that made widening the list unsafe.
    const doc = parse(
      `<html><body>
         <div id="cm_cr-review_list"></div>
         <div id="somewhere-else"><div data-hook="review" id="R1">${body}</div></div>
       </body></html>`,
    );
    expect(scrapeReviews(doc)).toHaveLength(1);
  });

  it("reads the product title from a review page variant", () => {
    const doc = parse('<html><body><span data-hook="product-link">A Drill</span></body></html>');
    expect(scrapeProduct(doc).title).toBe("A Drill");
  });
});

describe("what the widened lists must NOT pick up", () => {
  // Wrong data is worse than missing data: it gets scored, billed and believed.
  const realReview = `<div data-hook="review" id="R-real">
      <a data-hook="review-title"><span>Genuine review</span></a>
      <span data-hook="review-body"><span>This is a real customer review of the product.</span></span>
    </div>`;

  it("ignores a product description that is not a review", () => {
    const doc = parse(
      `<html><body>
         <div id="productDescription"><p>Marketing copy about the drill.</p></div>
         <div id="cm_cr-review_list">${realReview}</div>
       </body></html>`,
    );
    const reviews = scrapeReviews(doc);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.body).toContain("real customer review");
  });

  it("ignores a sponsored-products carousel", () => {
    const doc = parse(
      `<html><body>
         <div class="sp_desktop_sponsored"><span>Sponsored item blurb</span></div>
         <div id="cm_cr-review_list">${realReview}</div>
       </body></html>`,
    );
    expect(scrapeReviews(doc).map((r) => r.body)).toEqual([
      "This is a real customer review of the product.",
    ]);
  });

  it("does not invent reviews on a page that has none", () => {
    const doc = parse(
      `<html><body>
         <div id="productTitle">A product</div>
         <div id="ask-btf_feature_div"><span>Customer questions and answers</span></div>
         <div class="a-section"><span>No customer reviews yet</span></div>
       </body></html>`,
    );
    expect(scrapeReviews(doc)).toEqual([]);
  });

  it("does not treat a Q&A entry as a review", () => {
    const doc = parse(
      `<html><body>
         <div class="askTeaserQuestions">
           <div class="a-fixed-left-grid"><span>Does it come with a battery?</span></div>
         </div>
       </body></html>`,
    );
    expect(scrapeReviews(doc)).toEqual([]);
  });

  it("does not pull the product title into a review body", () => {
    const doc = parse(
      `<html><body>
         <span id="productTitle">AcmeDrive 20V Cordless Drill</span>
         <div id="cm_cr-review_list">${realReview}</div>
       </body></html>`,
    );
    expect(scrapeReviews(doc)[0]!.body).not.toContain("AcmeDrive");
  });

  it("still drops a card with no body, however broadly the card matched", () => {
    const doc = parse(
      `<html><body><div id="cm_cr-review_list">
         <div data-hook="review" id="R-empty"><a data-hook="review-title"><span>Title only</span></a></div>
         ${realReview}
       </div></body></html>`,
    );
    expect(scrapeReviews(doc).map((r) => r.id)).toEqual(["R-real"]);
  });
});
