/**
 * The only place that talks to api.typesafe.ai. Content scripts message the
 * service worker; the service worker calls this. Two jobs beyond the SDK:
 * a hard cap on in-flight requests, and turning every failure into a value
 * instead of an exception so one dead review never breaks the page.
 */
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  PermissionDeniedError,
  RateLimitError,
  TypeSafeClient,
  UnprocessableEntityError,
  type Fetch,
  type Questions,
  type RequestOptions,
} from "@typesafe-ai/sdk";
import type { ReviewState, ScoreResult } from "../shared/types.js";

/** Spec: three retries, 250ms backoff, on 429 and 5xx. */
export const RETRY = {
  maxRetries: 3,
  backoffInitialMs: 250,
  backoffMaxMs: 4000,
} as const;

/** Spec: at most 8 requests in flight at once. */
export const DEFAULT_CONCURRENCY = 8;

export interface SiftClientConfig {
  apiKey?: string;
  baseURL?: string;
  /** Max in-flight requests. */
  concurrency?: number;
  /** Per-attempt timeout in ms. */
  timeout?: number;
  /** Injected in tests so no test touches the network. */
  fetch?: Fetch;
  /** Set 0 in tests to make backoff deterministic. */
  backoffJitter?: number;
}

/**
 * Counting semaphore. Queue is FIFO so the reviews nearest the top of the page,
 * which are enqueued first, are also scored first.
 */
class Semaphore {
  #free: number;
  #waiting: Array<() => void> = [];

  constructor(permits: number) {
    this.#free = permits;
  }

  get inFlight(): number {
    return this.#waiting.length === 0 ? -this.#free : 0;
  }

  async acquire(): Promise<void> {
    if (this.#free > 0) {
      this.#free -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.#waiting.push(resolve));
  }

  release(): void {
    const next = this.#waiting.shift();
    if (next) next();
    else this.#free += 1;
  }
}

/** Map any thrown value onto the closed set of reasons the UI knows how to show. */
function classify(error: unknown): { reason: ScoreResult<Questions>["ok"] extends never ? never : Extract<ScoreResult<Questions>, { ok: false }>["reason"]; message: string } {
  if (error instanceof RateLimitError) return { reason: "rate_limited", message: "rate limited" };
  if (error instanceof AuthenticationError) return { reason: "auth", message: "API key rejected" };
  if (error instanceof PermissionDeniedError) {
    // A network egress proxy also answers 403, with a plain-text body rather than the
    // API's JSON error. Telling these apart stops us blaming the user's key for a
    // firewall. Seen in this container: "Host not in allowlist: api.typesafe.ai".
    if (typeof error.body === "string") {
      return { reason: "blocked", message: "api.typesafe.ai blocked by the network" };
    }
    return { reason: "auth", message: "API key rejected" };
  }
  if (error instanceof BadRequestError || error instanceof UnprocessableEntityError) {
    return { reason: "bad_request", message: error.message };
  }
  if (error instanceof InternalServerError) return { reason: "server_error", message: "server error" };
  if (error instanceof APIError) return { reason: "server_error", message: `HTTP ${error.status}` };
  if (error instanceof APIUserAbortError) return { reason: "aborted", message: "aborted" };
  if (error instanceof APITimeoutError) return { reason: "network", message: "timed out" };
  if (error instanceof APIConnectionError) return { reason: "network", message: "connection failed" };
  return { reason: "unknown", message: error instanceof Error ? error.message : String(error) };
}

export class SiftClient {
  readonly #client: TypeSafeClient;
  readonly #gate: Semaphore;
  #attempts = 0;
  /** Highest number of simultaneous in-flight fetches observed; asserted in tests. */
  #peak = 0;
  #live = 0;

  constructor(config: SiftClientConfig = {}) {
    const inner = config.fetch ?? ((input, init) => fetch(input, init));
    const counting: Fetch = async (input, init) => {
      this.#attempts += 1;
      this.#live += 1;
      if (this.#live > this.#peak) this.#peak = this.#live;
      try {
        return await inner(input, init);
      } finally {
        this.#live -= 1;
      }
    };

    this.#client = new TypeSafeClient({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      timeout: config.timeout ?? 10_000,
      fetch: counting,
      retry: {
        maxRetries: RETRY.maxRetries,
        backoffInitialMs: RETRY.backoffInitialMs,
        backoffMaxMs: RETRY.backoffMaxMs,
        ...(config.backoffJitter === undefined ? {} : { backoffJitter: config.backoffJitter }),
      },
    });
    this.#gate = new Semaphore(config.concurrency ?? DEFAULT_CONCURRENCY);
  }

  /** Peak simultaneous in-flight requests since construction. */
  get peakInFlight(): number {
    return this.#peak;
  }

  /**
   * Score one review against all active questions. Never throws: a failure
   * becomes `{ ok: false }` and the caller marks that review unscored.
   */
  async score<const Q extends Questions>(
    state: ReviewState,
    questions: Q,
    options?: RequestOptions,
  ): Promise<ScoreResult<Q>> {
    const before = this.#attempts;
    const started = Date.now();
    await this.#gate.acquire();
    try {
      const result = await this.#client.systemOne({ state, questions }, options);
      return {
        ok: true,
        answers: result.answers,
        usage: result.usage,
        latencyMs: Date.now() - started,
        attempts: this.#attempts - before,
      };
    } catch (error) {
      const { reason, message } = classify(error);
      return { ok: false, reason, message, latencyMs: Date.now() - started, attempts: this.#attempts - before };
    } finally {
      this.#gate.release();
    }
  }
}
