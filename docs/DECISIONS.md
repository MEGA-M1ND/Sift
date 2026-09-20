# Decisions

One line per non-obvious choice, with the reason.

## Phase 0

- Verified the API contract against `@typesafe-ai/sdk@0.6.0` type declarations and compiled
  source rather than the docs site: `docs.typesafe.ai` is blocked by this session's network
  egress policy (403 at CONNECT, whole `typesafe.ai` domain). The skill sanctions installed
  SDK types as the fallback when live docs are unreachable.
- Will depend on `@typesafe-ai/sdk` rather than hand-rolling `fetch` against `/v1/systemone`:
  the SDK already implements retry, backoff, jitter, `Retry-After` handling and typed answers,
  and it pins the wire format we cannot re-read from the docs. Fewer moving parts to get wrong.
- Noul answers carry NO `confidence` field (`{type,noul}` only) — only `choice` and `score` do.
  This contradicts the brief's "every answer carries a confidence" and breaks confidence
  routing for custom filters and presets, which are all nouls. Open question, see phase report.

## Phase 1

- Depend on `@typesafe-ai/sdk` instead of hand-rolling `fetch`: it already implements the
  retry/backoff/jitter and `Retry-After` handling the spec asks for, and it pins the wire
  format. `SiftClient` adds only what the SDK lacks — a concurrency cap and fail-soft results.
- The SDK's `isBrowser()` needs `window` AND `window.document` AND `navigator`. An MV3 service
  worker has no `window`, so the SDK runs there without `dangerouslyAllowBrowser: true` and the
  key never reaches the page. Verified in the compiled SDK source, not assumed.
- `SiftClient.score()` returns a result object and never throws. Fail-open is a hard requirement:
  one dead review must not break the page, so there is no error path for callers to forget.
- Retry policy overridden to the spec's 3 retries / 250ms initial backoff (SDK defaults are 2 /
  500ms). Retryable statuses left at the SDK default (408, 429, 5xx), which covers the spec's
  "429 or 5xx".
- Attempts are counted by wrapping the injected `fetch`, because the SDK does not report attempt
  counts. The same seam lets every test run without touching the network.
- A 403 with a plain-text body is reported as `blocked` (network egress), not `auth`. A JSON 403
  stays `auth`. Found the hard way: this container's proxy answers
  "Host not in allowlist: api.typesafe.ai", which is otherwise indistinguishable from a bad key.

## Phase 2

- Fixtures are SYNTHETIC and labelled as such in `fixtures/README.md`, because amazon.in and
  amazon.com are blocked by network egress policy here. Fabricating fixtures that match my own
  guessed selectors would make the parser tests self-confirming: they would pass while the
  extension extracted nothing from a real page. The tests cover parser logic only.
- Selector provenance is recorded per entry in `selectors.ts`. The `data-hook` scheme
  (`review-body`, `review-title`, `review-star-rating`, `review-date`) and the container
  `#cm_cr-review_list` are marked [corroborated]: they appear in the published scraper
  `amazon-buddy@2.2.45`, which parses live pages. Everything else is [unverified].
- Every field has an ordered candidate list rather than one selector, so a markup change costs
  one field instead of the whole page. `queryAll` returns matches for the first candidate that
  finds anything, which keeps fallbacks from mixing results from two different schemes.
- `scripts/check-fixture.ts` reports HIT/MISS per selector candidate against any saved page.
  This is the cheapest path from "selectors are a hypothesis" to "selectors are verified", and
  it needs no API key and no network.
- Only a missing body drops a review. Rating, date, verified badge and helpful votes each
  degrade to null/false/0, because body text is the evidence every question is asked about.
- An unparseable date is kept verbatim rather than nulled: it is still context for the model.
- Cards with no id get a content-derived synthetic id, so caching survives markup that omits it.
- Pagination starts at page 2 and stops on: the cap, a page that adds nothing new, a sign-in
  redirect or form, or 401/403/429. All of these are outcomes, not errors; the visible reviews
  are always kept and returned.
- `detectPage` matches hostnames with an anchored regex so `amazon.in.evil.example` cannot
  trigger the extension. Tested explicitly.
- Client tests are pinned to the `node` vitest environment. Under happy-dom the SDK sees a
  `window` and refuses to construct, which is the same guard that keeps the API key out of the
  page and confirms the client must live in the service worker.

## Phase 3

- Nouls carry no `confidence`, so the spec's "grey out below 0.5 confidence" cannot apply to
  custom filters or presets as written. A noul near 0.5 does mean "yes and no are about equally
  likely", which is what the grey badge was for, so a noul inside NOUL_UNSURE_BAND (0.40-0.60)
  renders as "unsure". Scores and choices use their real `confidence` against MIN_CONFIDENCE.
  One constant each, both in combine.ts. Awaiting your call; nothing else depends on the choice.
- The fake-review preset is three separate nouls combined here, never one "is this fake?"
  question. Weights live in presets.ts so they can be tuned without touching logic.
- A weighted mean alone was wrong for the free-product signal: 0.95 on an explicit disclosure
  combined to 0.43, i.e. "unsure", for a review that openly says it was given the product free.
  A signal marked `decisive` now floors the combined score at its own probability once past its
  threshold. Weighted mean for compensating signals, a floor for one that stands alone. This is
  the skill's "any serious violation needs separate conditions" point, applied to one signal.
- A missing signal renormalises over the weights actually present, so one dropped answer
  degrades a preset's score rather than voiding it.
- Unsure verdicts are damped to half their probability for sorting, so they cannot outrank a
  confident match, but they are never hidden by the threshold: we do not know that they fail.
  Reviews with no usable answer sort last and are never hidden either.
- The cache is subtracted before the request is built, so a request asks only genuinely unknown
  questions and a fully cached review makes no request at all. Cache keys include the question's
  canonical text, so editing a preset's wording correctly invalidates its cached answers.
- Cache reads touch the LRU index in memory only. Persisting a timestamp on every read would
  double write volume for something the user cannot see; a slightly stale LRU after a service
  worker restart is the better trade.
- Eviction runs in batches of 250 past the cap, so it is rare rather than once per write.
- Per-page summary counters are deltas against the cache's lifetime counters. Found by running
  the pipeline twice: the second page reported "20 hit / 20 miss" with the misses carried over
  from the first.

## Phase 4

- The `fake` preset is `flagOnly`: it badges a review but takes no part in ranking or in the
  hide-below-threshold decision. It is a warning about a review, not a reason the review answers
  what the user searched for. Without this, an incentivised review outranked the battery
  complaints someone typed a filter to find.
- Verdict keys are namespaced `custom:<id>` and `preset:<id>`, so a user filter can never collide
  with a preset id. Custom filter ids are generated with a `u_` prefix for the same reason.
- The panel lives in a Shadow root with `all: initial`. Amazon's stylesheet is enormous and would
  otherwise restyle everything we add, and our styles would leak back onto their page.
- Badges are styled inline instead. An inline style beats Amazon's selectors without an
  `!important` arms race, and a shadow root per card would be far heavier across 300 reviews.
  They are inserted directly after the star rating rather than appended to its parent, which on
  some cards would drop them at the end of the whole review.
- Reordering moves existing nodes with `append`, never clones. Amazon's own listeners, lazy
  images and "read more" expanders keep working because the nodes are never recreated.
- Threshold and hide-below are display-only and never re-score: the cached answers are unchanged,
  only their presentation is. This is the point of keeping combine.ts separate from the client.
- The MutationObserver is disconnected around every DOM write Sift makes. Without this, painting
  badges woke the observer, which repainted, forever: the e2e run measured 196 mutations in 3
  seconds on an idle page. It is now 0, and the e2e asserts that.
- A mutation pass that finds no new and no replaced cards returns without rendering, as a second
  line of defence against the same loop.
- Content script matches are host-level, because an Amazon product URL carries a slug before
  `/dp/`, which a match pattern cannot express. `detectPage()` is the real gate.
- `scripts/e2e-panel.ts` serves the fixture at a genuine amazon.in URL so the manifest's match
  patterns and detectPage() are exercised for real, rather than bypassed with a localhost page.

## Phase 5

- The settings page reads and writes `chrome.storage.local` directly rather than going through
  the service worker. It is an extension page, so it has the same access, and a round trip would
  buy nothing.
- The API key field is a password input with an explicit "Show key" toggle, so a shoulder-surfer
  or a screen recording does not capture it by default. The e2e screenshot has it masked.
- The settings page shows the live cache size and offers a clear button. Without it there is no
  way to force a re-score after editing a preset's wording, which is the one thing that
  legitimately invalidates cached answers.
- The e2e now saves settings, reloads the page, and asserts the values came back. A settings page
  that silently fails to persist looks identical to one that works.
- Icons are generated from a single SVG by rasterising it with the Chromium already installed for
  the e2e, rather than adding an image toolchain for four files.
- README states plainly what has and has not been verified. A reader seeing "149 tests passing"
  would otherwise reasonably assume the selectors work against live Amazon, which is not known.
