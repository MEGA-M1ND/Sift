// @vitest-environment node
// The API client runs in the MV3 service worker, which has no `window`. The SDK
// refuses to construct in a page context, so these tests must not run in a DOM.
import { describe, expect, it } from "vitest";
import { noul } from "@typesafe-ai/sdk";
import { DEFAULT_CONCURRENCY, SiftClient } from "../src/background/client.js";
import { toState } from "../src/shared/types.js";
import type { Review } from "../src/shared/types.js";

const REVIEW: Review = {
  id: "R1",
  title: "Died after ten months",
  body: "Battery held a charge for about ten months, then dropped to an hour.",
  rating: 2,
  verified_purchase: true,
  date: "2026-03-04",
  helpful_votes: 17,
};

const STATE = toState({ title: "Cordless drill", category: "Tools" }, REVIEW);
const QUESTIONS = { battery: noul("Does `review.body` describe the battery failing within a year?") };

function ok(noulValue = 0.91) {
  return new Response(
    JSON.stringify({
      model: "jev-latest",
      answers: { battery: { type: "noul", noul: noulValue } },
      usage: { input_tokens: 120, output_tokens: 0 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function err(status: number) {
  return new Response(JSON.stringify({ error: `status ${status}` }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A client whose transport replays `responses` in order. Backoff jitter off for determinism. */
function clientOver(responses: Array<() => Response | Promise<Response>>) {
  let i = 0;
  const client = new SiftClient({
    apiKey: "test-key",
    baseURL: "https://api.invalid",
    backoffJitter: 0,
    fetch: async () => {
      const next = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return next!();
    },
  });
  return { client, attempts: () => i };
}

describe("SiftClient", () => {
  it("returns the answer on a clean call, in one attempt", async () => {
    const { client } = clientOver([() => ok(0.91)]);
    const result = await client.score(STATE, QUESTIONS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.answers.battery.noul).toBe(0.91);
    expect(result.usage.input_tokens).toBe(120);
    expect(result.attempts).toBe(1);
  });

  it("retries a 429 and succeeds on the next attempt", async () => {
    const { client } = clientOver([() => err(429), () => ok(0.77)]);
    const result = await client.score(STATE, QUESTIONS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.answers.battery.noul).toBe(0.77);
    expect(result.attempts).toBe(2);
  });

  it("retries a 500 and succeeds on the next attempt", async () => {
    const { client } = clientOver([() => err(500), () => ok(0.4)]);
    const result = await client.score(STATE, QUESTIONS);
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it("gives up after exactly three retries and reports unscored, without throwing", async () => {
    const { client } = clientOver([() => err(503)]);
    const result = await client.score(STATE, QUESTIONS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("server_error");
    expect(result.attempts).toBe(1 + 3);
  });

  it("does not retry a 400", async () => {
    const { client } = clientOver([() => err(400)]);
    const result = await client.score(STATE, QUESTIONS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("bad_request");
    expect(result.attempts).toBe(1);
  });

  it("does not retry a bad key, and says so", async () => {
    const { client } = clientOver([() => err(401)]);
    const result = await client.score(STATE, QUESTIONS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("auth");
    expect(result.attempts).toBe(1);
  });

  it("turns a transport failure into a value, not an exception", async () => {
    const client = new SiftClient({
      apiKey: "test-key",
      baseURL: "https://api.invalid",
      backoffJitter: 0,
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const result = await client.score(STATE, QUESTIONS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("network");
  });

  it("waits at least the 250ms backoff before the first retry", async () => {
    const { client } = clientOver([() => err(429), () => ok()]);
    const started = Date.now();
    const result = await client.score(STATE, QUESTIONS);
    const elapsed = Date.now() - started;
    expect(result.ok).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(240);
    expect(elapsed).toBeLessThan(1200);
  });

  it("backs off exponentially across successive retries", async () => {
    const { client } = clientOver([() => err(500), () => err(500), () => ok()]);
    const started = Date.now();
    await client.score(STATE, QUESTIONS);
    // 250ms then 500ms.
    expect(Date.now() - started).toBeGreaterThanOrEqual(720);
  });

  it("never exceeds the concurrency cap, however many reviews are queued", async () => {
    const client = new SiftClient({
      apiKey: "test-key",
      baseURL: "https://api.invalid",
      fetch: async () => {
        await new Promise((r) => setTimeout(r, 15));
        return ok();
      },
    });
    const results = await Promise.all(
      Array.from({ length: 40 }, () => client.score(STATE, QUESTIONS)),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(client.peakInFlight).toBeLessThanOrEqual(DEFAULT_CONCURRENCY);
    expect(client.peakInFlight).toBeGreaterThan(1);
  });

  it("keeps scoring the rest of the queue when one review fails", async () => {
    let n = 0;
    const client = new SiftClient({
      apiKey: "test-key",
      baseURL: "https://api.invalid",
      backoffJitter: 0,
      fetch: async () => {
        n += 1;
        return n === 1 ? err(400) : ok(0.5);
      },
    });
    const results = await Promise.all([
      client.score(STATE, QUESTIONS),
      client.score(STATE, QUESTIONS),
      client.score(STATE, QUESTIONS),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
  });
});

describe("failure classification", () => {
  /** A network egress proxy answers 403 with plain text; the API answers 403 with JSON. */
  it("blames the network, not the key, for a proxy 403", async () => {
    const client = new SiftClient({
      apiKey: "test-key",
      baseURL: "https://api.invalid",
      fetch: async () =>
        new Response("Host not in allowlist: api.typesafe.ai.", {
          status: 403,
          headers: { "content-type": "text/plain" },
        }),
    });
    const result = await client.score(STATE, QUESTIONS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("blocked");
  });

  it("still blames the key for a genuine API 403", async () => {
    const client = new SiftClient({
      apiKey: "test-key",
      baseURL: "https://api.invalid",
      fetch: async () =>
        new Response(JSON.stringify({ error: "forbidden" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    });
    const result = await client.score(STATE, QUESTIONS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("auth");
  });
});
