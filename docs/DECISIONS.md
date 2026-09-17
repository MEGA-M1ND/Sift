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
