# The five things most likely to break in the first week

Ranked by how likely they are to bite, multiplied by how bad it is when they do.
Written after building the thing, so these are the parts I am least confident in,
not a generic checklist.

---

## 1. The selectors do not match live Amazon

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
3. Add a console warning when `detectPage()` matched but `scrapeReviewCards()`
   returned nothing — that combination is always a selector failure, never a normal
   page, and it is the signal you want in a bug report.
4. Longer term: widen each candidate list rather than replacing entries, so one
   markup variant does not break the other.

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

1. Send reviews in chunks of about 50 instead of one message for the whole page.
   Each chunk is a short message round trip, the worker stays busy, and partial
   results paint as they arrive.
2. On a null response, retry once automatically before showing the error. Most
   evictions are recoverable on the next message.
3. Change the error text to say what to do ("scoring was interrupted — click to
   resume") and make the status line clickable, rather than requiring a reload.

---

## 5. Request amplification from filter churn and preset stacking

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

1. Debounce adding a filter, or require Enter rather than scoring on every keystroke
   — Enter is already the behaviour, so the remaining gap is rapid successive
   filters.
2. Show the estimated cost before scoring when it exceeds a threshold: "score 300
   reviews against 11 questions, about $0.004?" with a confirm. Cheap to add, and it
   makes the economics visible rather than surprising.
3. Add a per-page spend ceiling in settings that stops the run and says why.
4. Consider scoring visible reviews first and the rest on demand. Most users look at
   the top twenty.

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
