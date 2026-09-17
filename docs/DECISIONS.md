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
