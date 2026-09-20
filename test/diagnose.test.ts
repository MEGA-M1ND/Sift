/**
 * Selector health tests.
 *
 * These matter more than they look. The selectors have never met a live Amazon
 * page, so the warning this module produces is how a real user's breakage gets
 * back to us. A health check that stays quiet when the page is broken, or that
 * cries wolf on a healthy one, is worse than none.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { diagnose, formatReport } from "../src/content/diagnose.js";

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

function fixture(name: string): Document {
  return parse(readFileSync(resolve(process.cwd(), "fixtures", name), "utf8"));
}

/** A card with every field, so tests can knock one out at a time. */
function card(id: string, parts: Partial<Record<"title" | "body" | "rating" | "date", boolean>> = {}): string {
  const has = { title: true, body: true, rating: true, date: true, ...parts };
  return [
    `<div data-hook="review" id="${id}">`,
    has.title ? `<a data-hook="review-title"><span>Title ${id}</span></a>` : "",
    has.rating ? `<i data-hook="review-star-rating"><span>4.0 out of 5 stars</span></i>` : "",
    has.date ? `<span data-hook="review-date">Reviewed in India on 4 March 2026</span>` : "",
    has.body ? `<span data-hook="review-body"><span>Body of review ${id}.</span></span>` : "",
    `</div>`,
  ].join("");
}

function page(cards: string): Document {
  return parse(
    `<html><body><span id="productTitle">A product</span>
     <div id="cm_cr-review_list">${cards}</div></body></html>`,
  );
}

describe("a healthy page", () => {
  it("reports no problems for the amazon.in fixture", () => {
    const report = diagnose(fixture("amazon-in-product-reviews.html"));
    expect(report.problems).toEqual([]);
    expect(report.healthy).toBe(true);
  });

  it("reports no problems for the amazon.com fixture", () => {
    const report = diagnose(fixture("amazon-com-dp.html"));
    expect(report.healthy).toBe(true);
  });

  it("does not flag missing verified badges or helpful votes", () => {
    // Most genuine reviews have neither. Judging those by coverage would fire
    // on a perfectly healthy page.
    const report = diagnose(page([card("R1"), card("R2"), card("R3")].join("")));
    expect(report.healthy).toBe(true);
    const verified = report.fields.find((f) => f.field === "verified")!;
    expect(verified.matched).toBe(0);
    expect(verified.expected).toBe(false);
  });

  it("names the selector that matched, so a fix has somewhere to start", () => {
    const report = diagnose(fixture("amazon-com-dp.html"));
    expect(report.listContainer).toBe("#cm-cr-dp-review-list");
    expect(report.cardSelector).toBe('[data-hook="review"]');
    expect(report.fields.find((f) => f.field === "body")?.selector).toContain("review-body");
  });
});

describe("a page where the selectors have broken", () => {
  it("reports the case that matters most: page matched, nothing found", () => {
    const report = diagnose(parse("<html><body><h1>Amazon</h1></body></html>"));
    expect(report.healthy).toBe(false);
    expect(report.cards).toBe(0);
    expect(report.problems[0]).toContain("No review list container matched");
  });

  it("distinguishes an empty list from a missing list", () => {
    const report = diagnose(parse('<html><body><div id="cm_cr-review_list"></div></body></html>'));
    expect(report.problems[0]).toContain("contains no review cards");
    expect(report.listContainer).toBe("#cm_cr-review_list");
  });

  it("points at the body selector when cards parse to nothing", () => {
    // Every card present, none with a body: exactly what a changed body
    // selector looks like, and the failure that empties the whole page.
    const report = diagnose(page([card("R1", { body: false }), card("R2", { body: false })].join("")));
    expect(report.healthy).toBe(false);
    expect(report.cards).toBe(2);
    expect(report.reviewsParsed).toBe(0);
    expect(report.problems.some((p) => p.includes("body selector"))).toBe(true);
  });

  it("catches a field that broke without emptying the page", () => {
    // The quiet failure: reviews still score, but ratings are silently gone.
    const cards = [
      card("R1", { rating: false }),
      card("R2", { rating: false }),
      card("R3", { rating: false }),
      card("R4"),
    ].join("");
    const report = diagnose(page(cards));
    expect(report.healthy).toBe(false);
    expect(report.problems.some((p) => p.includes('"rating"'))).toBe(true);
    expect(report.reviewsParsed).toBe(4);
  });

  it("does not flag a field merely missing from a minority of cards", () => {
    const cards = [card("R1"), card("R2"), card("R3", { date: false })].join("");
    expect(diagnose(page(cards)).healthy).toBe(true);
  });

  it("flags a missing product title, which costs scoring its context", () => {
    const doc = parse(`<html><body><div id="cm_cr-review_list">${card("R1")}</div></body></html>`);
    const report = diagnose(doc);
    expect(report.problems.some((p) => p.includes("product title"))).toBe(true);
  });

  it("counts dropped cards rather than hiding them", () => {
    const cards = [card("R1"), card("R1"), card("R2", { body: false })].join("");
    const report = diagnose(page(cards));
    expect(report.cards).toBe(3);
    expect(report.reviewsParsed).toBe(1);
    expect(report.dropped).toBe(2);
  });
});

describe("formatReport", () => {
  it("leads with the verdict", () => {
    expect(formatReport(diagnose(fixture("amazon-com-dp.html")))).toMatch(/^Sift selector health: OK/);
    expect(formatReport(diagnose(parse("<html><body></body></html>")))).toMatch(
      /^Sift selector health: PROBLEMS FOUND/,
    );
  });

  it("marks the broken field in the table, not only in the prose", () => {
    const cards = [card("R1", { rating: false }), card("R2", { rating: false }), card("R3")].join("");
    const text = formatReport(diagnose(page(cards)));
    expect(text).toMatch(/rating.*probably broken/);
  });

  it("tells the reader where to fix it", () => {
    const text = formatReport(diagnose(parse("<html><body></body></html>")));
    expect(text).toContain("src/content/selectors.ts");
    expect(text).toContain("check-fixture");
  });

  it("does not print fix instructions when nothing is wrong", () => {
    expect(formatReport(diagnose(fixture("amazon-com-dp.html")))).not.toContain("check-fixture");
  });

  it("shows MISS rather than an empty column for a selector that found nothing", () => {
    expect(formatReport(diagnose(parse("<html><body></body></html>")))).toContain("MISS");
  });
});
