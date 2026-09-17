import { describe, expect, it } from "vitest";
import { collectReviews } from "../src/content/collect.js";
import type { PageTarget } from "../src/content/page.js";
import type { Review } from "../src/shared/types.js";

const TARGET: PageTarget = { site: "amazon.in", kind: "product", asin: "B0BDHWDR12" };

function review(id: string): Review {
  return {
    id,
    title: `Title ${id}`,
    body: `Body text for review ${id}.`,
    rating: 4,
    verified_purchase: true,
    date: "2026-03-04",
    helpful_votes: 0,
  };
}

/** A reviews page carrying the given review ids. */
function pageHtml(ids: string[]): string {
  const cards = ids
    .map(
      (id) =>
        `<div data-hook="review" id="${id}">` +
        `<a data-hook="review-title"><span>Title ${id}</span></a>` +
        `<span data-hook="review-body"><span>Body text for review ${id}.</span></span>` +
        `</div>`,
    )
    .join("");
  return `<html><body><div id="cm_cr-review_list">${cards}</div></body></html>`;
}

function response(body: string, init: ResponseInit = {}, url = "https://www.amazon.in/product-reviews/X"): Response {
  const res = new Response(body, init);
  // Response.url is read-only; tests need it to simulate a redirect target.
  Object.defineProperty(res, "url", { value: url, configurable: true });
  return res;
}

/** Serves 10 fresh reviews per page, indefinitely. */
function endlessPages() {
  const urls: string[] = [];
  const fetchPage = async (url: string) => {
    urls.push(url);
    const page = Number(new URL(url).searchParams.get("pageNumber") ?? "2");
    const ids = Array.from({ length: 10 }, (_, i) => `R-p${page}-${i}`);
    return response(pageHtml(ids));
  };
  return { fetchPage, urls };
}

describe("collectReviews", () => {
  it("does not fetch anything when the page offers no route to more reviews", async () => {
    let called = 0;
    const result = await collectReviews({
      target: TARGET,
      initial: [review("R1"), review("R2")],
      canPaginate: false,
      fetchPage: async () => {
        called += 1;
        return response(pageHtml([]));
      },
    });
    expect(called).toBe(0);
    expect(result.stopped).toBe("no_pagination");
    expect(result.reviews).toHaveLength(2);
    expect(result.fromDom).toBe(2);
    expect(result.pagesFetched).toBe(0);
  });

  it("stops at the cap without fetching when the DOM already has enough", async () => {
    let called = 0;
    const result = await collectReviews({
      target: TARGET,
      initial: Array.from({ length: 12 }, (_, i) => review(`R${i}`)),
      canPaginate: true,
      cap: 10,
      fetchPage: async () => {
        called += 1;
        return response(pageHtml([]));
      },
    });
    expect(called).toBe(0);
    expect(result.stopped).toBe("cap");
    expect(result.reviews).toHaveLength(10);
  });

  it("pages until it reaches the cap, and never exceeds it", async () => {
    const { fetchPage, urls } = endlessPages();
    const result = await collectReviews({
      target: TARGET,
      initial: [review("R-dom-1")],
      canPaginate: true,
      cap: 25,
      fetchPage,
    });
    expect(result.stopped).toBe("cap");
    expect(result.reviews).toHaveLength(25);
    expect(result.fromDom).toBe(1);
    // 1 from the DOM + 10 per page, so three fetches reach 25.
    expect(result.pagesFetched).toBe(3);
    // Pagination starts at page 2: page 1 is what the page already rendered.
    expect(urls[0]).toContain("pageNumber=2");
    expect(urls[1]).toContain("pageNumber=3");
  });

  it("uses the default cap of 300", async () => {
    const { fetchPage } = endlessPages();
    const result = await collectReviews({ target: TARGET, initial: [], canPaginate: true, fetchPage });
    expect(result.reviews).toHaveLength(300);
    expect(result.stopped).toBe("cap");
  });

  it("stops when a page adds nothing new, rather than looping", async () => {
    // Amazon repeating page 1 content is a common end-of-list behaviour.
    const result = await collectReviews({
      target: TARGET,
      initial: [review("R1"), review("R2")],
      canPaginate: true,
      cap: 100,
      fetchPage: async () => response(pageHtml(["R1", "R2"])),
    });
    expect(result.stopped).toBe("exhausted");
    expect(result.reviews).toHaveLength(2);
    expect(result.pagesFetched).toBe(1);
  });

  it("deduplicates across pages", async () => {
    let page = 0;
    const result = await collectReviews({
      target: TARGET,
      initial: [review("RA")],
      canPaginate: true,
      cap: 100,
      fetchPage: async () => {
        page += 1;
        // Page 2 overlaps with the DOM and with page 3.
        if (page === 1) return response(pageHtml(["RA", "RB", "RC"]));
        if (page === 2) return response(pageHtml(["RC", "RD"]));
        return response(pageHtml(["RD"]));
      },
    });
    expect(result.reviews.map((r) => r.id)).toEqual(["RA", "RB", "RC", "RD"]);
    expect(result.stopped).toBe("exhausted");
  });

  describe("failing gracefully", () => {
    it("keeps what it has when Amazon redirects to sign-in", async () => {
      const result = await collectReviews({
        target: TARGET,
        initial: [review("R1")],
        canPaginate: true,
        fetchPage: async () =>
          response("<html><body>Sign in</body></html>", {}, "https://www.amazon.in/ap/signin?openid.return_to=x"),
      });
      expect(result.stopped).toBe("blocked");
      expect(result.detail).toBe("sign-in required");
      expect(result.reviews).toHaveLength(1);
    });

    it("detects a sign-in form served with a 200", async () => {
      const result = await collectReviews({
        target: TARGET,
        initial: [review("R1")],
        canPaginate: true,
        fetchPage: async () =>
          response('<html><body><form name="signIn"><input id="ap_email"></form></body></html>'),
      });
      expect(result.stopped).toBe("blocked");
      expect(result.reviews).toHaveLength(1);
    });

    it("treats a 429 as blocked, not an error", async () => {
      const result = await collectReviews({
        target: TARGET,
        initial: [review("R1")],
        canPaginate: true,
        fetchPage: async () => response("", { status: 429 }),
      });
      expect(result.stopped).toBe("blocked");
      expect(result.detail).toBe("HTTP 429");
    });

    it("reports a server failure as an error and keeps the visible reviews", async () => {
      const result = await collectReviews({
        target: TARGET,
        initial: [review("R1"), review("R2")],
        canPaginate: true,
        fetchPage: async () => response("", { status: 500 }),
      });
      expect(result.stopped).toBe("error");
      expect(result.detail).toBe("HTTP 500");
      expect(result.reviews).toHaveLength(2);
    });

    it("survives a thrown network failure", async () => {
      const result = await collectReviews({
        target: TARGET,
        initial: [review("R1")],
        canPaginate: true,
        fetchPage: async () => {
          throw new TypeError("Failed to fetch");
        },
      });
      expect(result.stopped).toBe("error");
      expect(result.detail).toBe("Failed to fetch");
      expect(result.reviews).toHaveLength(1);
    });

    it("keeps pages fetched before the block", async () => {
      let page = 0;
      const result = await collectReviews({
        target: TARGET,
        initial: [],
        canPaginate: true,
        cap: 100,
        fetchPage: async () => {
          page += 1;
          if (page <= 2) return response(pageHtml([`R${page}a`, `R${page}b`]));
          return response("", { status: 403 });
        },
      });
      expect(result.stopped).toBe("blocked");
      expect(result.pagesFetched).toBe(2);
      expect(result.reviews).toHaveLength(4);
    });
  });
});
