import { describe, expect, it } from "vitest";
import { detectPage, reviewsPageUrl } from "../src/content/page.js";

describe("detectPage", () => {
  it("recognises an amazon.in product page", () => {
    expect(detectPage("https://www.amazon.in/dp/B0BDHWDR12")).toEqual({
      site: "amazon.in",
      kind: "product",
      asin: "B0BDHWDR12",
    });
  });

  it("recognises an amazon.com product page", () => {
    expect(detectPage("https://www.amazon.com/dp/B0BDHWDR12")).toEqual({
      site: "amazon.com",
      kind: "product",
      asin: "B0BDHWDR12",
    });
  });

  it("recognises a product page behind a slug, which is the common real-world shape", () => {
    const target = detectPage(
      "https://www.amazon.in/AcmeDrive-Cordless-Drill-Batteries/dp/B0BDHWDR12/ref=sr_1_3?keywords=drill",
    );
    expect(target).toMatchObject({ kind: "product", asin: "B0BDHWDR12" });
  });

  it("recognises the older /gp/product/ path", () => {
    expect(detectPage("https://www.amazon.com/gp/product/B0BDHWDR12")).toMatchObject({
      kind: "product",
      asin: "B0BDHWDR12",
    });
  });

  it("recognises a see-all-reviews page", () => {
    expect(detectPage("https://www.amazon.in/product-reviews/B0BDHWDR12/ref=cm_cr_arp_d_paging_btm_2")).toEqual({
      site: "amazon.in",
      kind: "reviews",
      asin: "B0BDHWDR12",
    });
  });

  it("prefers the reviews path when a URL contains both", () => {
    const target = detectPage("https://www.amazon.in/AcmeDrive/dp/B0BDHWDR12/product-reviews/B0BDHWDR12");
    expect(target?.kind).toBe("reviews");
  });

  it("uppercases a lowercased ASIN so cache keys stay stable", () => {
    expect(detectPage("https://www.amazon.in/dp/b0bdhwdr12")?.asin).toBe("B0BDHWDR12");
  });

  it("works without the www subdomain", () => {
    expect(detectPage("https://amazon.in/dp/B0BDHWDR12")?.site).toBe("amazon.in");
  });

  describe("stays out of the way", () => {
    const shouldNotMatch = [
      // Other Amazon sites are out of scope for v1.
      "https://www.amazon.co.uk/dp/B0BDHWDR12",
      "https://www.amazon.de/dp/B0BDHWDR12",
      // Non-product Amazon pages.
      "https://www.amazon.in/",
      "https://www.amazon.in/s?k=cordless+drill",
      "https://www.amazon.in/gp/cart/view.html",
      "https://www.amazon.in/gp/css/order-history",
      // Lookalike hostnames must not match.
      "https://amazon.in.evil.example/dp/B0BDHWDR12",
      "https://notamazon.in/dp/B0BDHWDR12",
      "https://fakeamazon.com/dp/B0BDHWDR12",
      // Entirely unrelated.
      "https://www.flipkart.com/dp/B0BDHWDR12",
      "not a url at all",
      "",
    ];

    for (const href of shouldNotMatch) {
      it(`ignores ${href || "(empty string)"}`, () => {
        expect(detectPage(href)).toBeNull();
      });
    }

    it("ignores a path that only looks like an ASIN", () => {
      expect(detectPage("https://www.amazon.in/dp/SHORT")).toBeNull();
      expect(detectPage("https://www.amazon.in/dp/TOOLONGANASIN12345")).toBeNull();
    });
  });
});

describe("reviewsPageUrl", () => {
  it("builds a same-origin paginated reviews URL for the right site", () => {
    const url = reviewsPageUrl({ site: "amazon.in", kind: "product", asin: "B0BDHWDR12" }, 3);
    expect(url).toContain("https://www.amazon.in/product-reviews/B0BDHWDR12/");
    expect(url).toContain("pageNumber=3");
    expect(url).toContain("reviewerType=all_reviews");
  });

  it("keeps amazon.com pages on amazon.com", () => {
    const url = reviewsPageUrl({ site: "amazon.com", kind: "reviews", asin: "B0BDHWDR12" }, 2);
    expect(url.startsWith("https://www.amazon.com/")).toBe(true);
  });
});
