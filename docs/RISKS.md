# The five things most likely to break in the first week

Ranked by how likely they are to bite, multiplied by how bad it is when they do.
Written after building the thing, so these are the parts I am least confident in,
not a generic checklist.

---

## 1. The selectors do not match live Amazon

**Status: partly addressed.** Sift now detects its own breakage and says so.
The underlying risk is unchanged, because detection is not verification: the
selectors still have never met a live Amazon page.

**Likelihood: high. Impact: total.**

Every selector in `src/content/selectors.ts` is either `[corroborated]` (seen in a
published scraper) or `[unverified]`. None has met a live Amazon page, because
amazon.in and amazon.com were blocked by network policy where this was built. The
fixtures are synthetic, so the parser tests pass whether or not the selectors are
right.

Amazon also runs A/B tests on review markup, so "it worked yesterday" and "it works
for me" are both weak evidence. Two users on the same product can get different DOM.

When it breaks the panel either never appears or appears saying "0 reviews found",
which reads as "this extension is broken" rather than "this page is unusual".

**Fix, in order:**

1. Before anything else, save two real pages and run
   `npm run check-fixture -- <file>`. Every `MISS` is a selector to correct. This is
   twenty minutes of work and it retires the single largest risk here.
2. Replace the synthetic fixtures with those real pages so the tests start meaning
   something.
3. ~~Add a console warning when the page matched but nothing was found~~ — done,
   and wider than originally planned. `diagnose()` checks every selector on every
   page load and reports:

   - nothing found at all (warning, since the product may genuinely have no
     reviews yet)
   - cards found but none parsed (error, and it names the body selector as the
     likeliest cause)
   - an expected field missing from more than half the cards (error)

   That third case is the one worth having. It catches a selector that broke
   *without* emptying the page — ratings silently gone while everything still
   appears to work — which would otherwise never be reported by anyone.

   `verified` and `helpful` are deliberately excluded from that check: plenty of
   genuine reviews have neither, so judging them by coverage would cry wolf on a
   healthy page. A warning that fires on working pages gets ignored, and then the
   real one gets ignored too.

   The same `diagnose()` powers `npm run check-fixture`, so the script and the
   runtime cannot drift apart. `__sift.report()` and `__sift.state()` in the
   console give the same output on demand, for pasting into a bug report.

4. Still open, and still the only thing that actually retires this risk: run
   `check-fixture` against a real saved page and fix what it reports. Detection
   tells you when it breaks; only verification tells you whether it works.
5. ~~Widen each candidate list rather than replacing entries~~ — done, but the
   widening was the smaller half of the work. Two mechanisms had to be fixed
   first, because adding candidates on top of them would have made things worse:

   - `textOf` took the first matching *element* even when it had no text. Amazon's
     title anchor holds a spacer span, so a broader candidate matched it, found
     nothing, and returned an empty title while a good later candidate went
     untried. It now tries every element of every candidate until one yields text.
   - A list container that matched but held no cards blocked the document-wide
     fallback entirely. Each container candidate is now accepted only if it
     actually contains cards.

   Both were demonstrated with failing tests before being fixed. Ratings work the
   same way now: candidates are tried until one yields a parseable value, so a
   star element with neither readable text nor a star class is skipped rather
   than accepted as "no rating".

   Selectors are also run through a guard that treats an unusable selector as a
   miss. The lists now contain `:has()`, and on an engine that does not support
   it an uncaught throw would take out scraping entirely rather than costing one
   candidate.

   Speculative entries sit last in every list, so they only fire once everything
   better has missed. `test/selectors.test.ts` covers both directions: the
   markup variants the widening is meant to survive, and the things a broad
   candidate must NOT match — product descriptions, sponsored carousels, Q&A
   entries, the product title. Wrong data is worse than missing data, because it
   gets scored, billed and believed.

---

## 2. Calibration is unknown, so the 0.70 default may be meaningless

**Likelihood: high. Impact: the product feels wrong rather than broken.**

No request has ever reached Jev. Every probability in every screenshot came from a
keyword stub I wrote. The defaults — threshold 0.70, unsure band 0.40–0.60, colour
steps at 0.5/0.7/0.85 — were chosen from the spec, not from data.

If Jev's real answers cluster (say most land between 0.3 and 0.7), the unsure band
swallows the middle, the 0.70 threshold hides nearly everything, and the user
concludes the filter does not work. That is worse than an obvious failure because
there is nothing to report.

**Fix:**

1. Run `npm run smoke` against the real API and read the five rows against their
   expected column. That takes one minute and tells you the shape of the
   distribution.
2. Then score one real product page and look at the spread before touching
   anything. Move `NOUL_UNSURE_BAND` and the default threshold to fit what you see;
   both are one constant each and neither requires re-scoring, because changing them
   does not invalidate a single cached answer.
3. If answers really do cluster, switch the default view from an absolute threshold
   to "top N by match strength" and keep the slider as an advanced control. Ranking
   survives poor calibration; thresholds do not.

---

## 3. Amazon throttles or CAPTCHAs the user over pagination

**Likelihood: medium. Impact: high, and it lands on the user's account.**

Collecting 300 reviews means up to 30 same-origin fetches of `/product-reviews/`.
Those carry the user's own session, so anything Amazon does about it happens to
them, not to us. A CAPTCHA wall on someone's shopping account because an extension
looked like a scraper is the worst outcome in this document.

I added pacing for exactly this reason — roughly 600–1000ms of jittered delay
between pages, about the rate of a fast human clicking "next". That reduces the risk
but does not remove it, and it has never been tested against the live site.

**Fix:**

1. Watch the first real runs for a sign-in redirect or a 429. Both are already
   handled as normal outcomes (collection stops, visible reviews are kept), so the
   signal is in the console line, not a crash.
2. Consider lowering the default cap from 300 to around 100. Most of the value is in
   the first hundred reviews, and it cuts the request count by two thirds.
3. Make pagination opt-in — a "load more reviews" button in the panel — rather than
   automatic. The user then owns the decision to make thirty requests.
4. Never reduce the delay to speed things up. The reviews already on screen are
   scored while pagination runs, so the wait is not visible anyway.

---

## 4. The MV3 service worker is killed in the middle of a scoring run

**Status: addressed.** All three fixes below are implemented. The failure mode is
now a resumable stop rather than a dead end. Still not observed against a real
eviction, because a content script's `chrome` object lives in an isolated world
that a test page cannot reach; the retry and chunking are unit-tested instead
(`test/resume.test.ts`).

**Likelihood: medium. Impact: a confusing dead end.**

Chrome terminates an idle service worker after about 30 seconds. A 300-review page
at eight concurrent requests should finish in seconds, but that assumes the API is
fast. If it is slow, rate-limiting, or the user has a poor connection, the worker
can be evicted with requests in flight. `chrome.runtime.sendMessage` then rejects,
the content script shows "Sift could not reach its background worker", and the user
is stuck until they reload.

The cache makes this less painful than it sounds — answers already stored survive,
so a retry is cheap — but the current code has no retry. It gives up.

**Fix:**

1. ~~Send reviews in chunks of about 50~~ — done. `CHUNK_SIZE = 50` in
   `src/content/index.ts`; each chunk paints before the next is requested, so an
   eviction costs one chunk rather than the run.
2. ~~On a null response, retry once~~ — done. `sendWithRetry` waits 300ms and
   sends again; the first message is what wakes the worker. One retry only, since
   a second failure is not an eviction.
3. ~~Make the status actionable~~ — done. The status line reads "Scoring stopped
   after N of M reviews" with a **Resume** button. Resume skips what was already
   scored, and the cache makes the rest nearly free.

One thing this also fixed: the service worker built a new `SiftClient` per
message, each with its own concurrency gate. Chunking would have meant two
in-flight messages running sixteen requests instead of eight. The client is now
memoised per key.

---

## 5. Request amplification from filter churn and preset stacking

**Status: addressed.** The confirmation, the hard per-page ceiling and
viewport-first ordering are all implemented. What remains is a product question
rather than a defect: near-identical filter wordings are still separate cache
keys, and probably should be.

**Likelihood: medium. Impact: money, and it is the user's money.**

Five custom filters plus all four presets is eleven questions per review. At 300
reviews that is 300 requests carrying eleven questions each, and every new filter
re-scores every review — the cache covers the questions that did not change, but the
new one is a genuine miss on all 300.

A user experimenting with wording ("battery dies", no, "battery fails within a
year", no, "battery degrades quickly") pays for a full pass each time, because each
rewording is a different question with a different cache key. Nothing currently
warns them, and nothing caps the spend.

**Fix:**

1. ~~Show the estimated cost before scoring when it exceeds a threshold~~ — done.
   Above "Ask before spending more than" (default $0.01) the panel shows
   "Score N reviews against M questions? About $X." and waits. Doing nothing is the
   cancel; there is no modal over someone's shopping. Set it to 0 to be asked every
   time. The estimate is characters over four, calibrated against real
   `usage.input_tokens`; the figure shown after a run is the real one.
2. ~~A hard per-page ceiling~~ — done. "Hard limit per page" (default $0.05) is
   checked against the estimate *before* each chunk is sent, because a limit you
   only notice having crossed is not a limit. When it stops, it says how much was
   spent and offers **Continue**.

   Continue grants `max(ceiling, next chunk)` rather than exactly one more
   ceiling. The e2e caught why: with a ceiling smaller than a single chunk, a
   fixed grant left the user clicking Continue forever without ever scoring a
   review. Continue must always buy progress.

3. ~~Score visible reviews first~~ — done. `orderByViewport` sorts the queue into
   on-screen, then below the fold nearest-first, then scrolled-past. The order is
   recomputed on every run, so resuming after a scroll picks up where the user
   now is.

   This is what makes the ceiling tolerable rather than arbitrary: a run that
   stops half way has spent its money on the reviews the person was reading. The
   "rest on demand" half of this idea is covered by the same mechanism — the
   ceiling stops, Continue resumes.

4. Still open, and possibly should stay open: rewording a filter is a new cache
   key, so each experiment pays in full. Nothing dedupes near-identical filter
   text, and nothing obviously should — "battery dies" and "battery degrades
   quickly" are genuinely different questions. The confirmation makes the cost
   visible each time, which may be the right answer.

---

## Honourable mentions

Not in the top five, but worth knowing about:

- **Amazon re-renders review cards** on interaction (expanding "read more", voting).
  The MutationObserver repaints on a replaced card, and that path is tested, but only
  against synthetic markup.
- **The panel anchor may be missing** on some layouts, in which case the panel is
  prepended to `document.body` and appears at the very top of the page. Ugly, not
  broken.
- **Storage quota.** 5,000 cached answers is well inside `chrome.storage.local`'s
  limit, but a user who browses hundreds of products will hit the LRU eviction more
  often than expected and lose the "repeat visits are free" property.
- **The Chrome Web Store publish job has never run.** First tag will be the first
  real exercise of that path.
