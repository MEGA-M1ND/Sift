/**
 * Service worker. Owns the API key, the client and the cache.
 *
 * Everything it does is fail-open: if the key is missing or the API is down, it
 * answers with an error the panel can show in one line, and the page is
 * otherwise untouched.
 */
import { AnswerCache, type StorageArea } from "./cache.js";
import { SiftClient } from "./client.js";
import { logSummary, scorePage } from "./pipeline.js";
import { loadSettings } from "../shared/settings.js";
import type { Request, ScoreResponse, SettingsResponse } from "../shared/messaging.js";

/** `chrome.storage.local` behind the small interface the cache needs. */
const storage: StorageArea = {
  get: (keys) => chrome.storage.local.get(keys),
  set: (items) => chrome.storage.local.set(items),
  remove: (keys) => chrome.storage.local.remove(keys),
};

// One cache for the worker's lifetime; it rebuilds its index after a restart.
const cache = new AnswerCache(storage);

async function handleScore(request: Extract<Request, { type: "sift:score" }>): Promise<ScoreResponse> {
  const settings = await loadSettings();

  const empty: ScoreResponse["summary"] = {
    reviews: request.reviews.length,
    scored: 0,
    unscored: 0,
    fullyCached: 0,
    cacheHits: 0,
    cacheMisses: 0,
    requests: 0,
    inputTokens: 0,
    estimatedCostUsd: 0,
    p50LatencyMs: 0,
    p95LatencyMs: 0,
    wallMs: 0,
    failures: {},
  };

  if (!settings.apiKey) {
    return {
      type: "sift:scored",
      answers: {},
      summary: empty,
      error: { reason: "no_api_key", message: "Add your TypeSafe API key in Sift's settings." },
    };
  }

  let client: SiftClient;
  try {
    client = new SiftClient({ apiKey: settings.apiKey });
  } catch (error) {
    return {
      type: "sift:scored",
      answers: {},
      summary: empty,
      error: { reason: "unavailable", message: error instanceof Error ? error.message : "Client unavailable" },
    };
  }

  const result = await scorePage({
    product: request.product,
    reviews: request.reviews,
    active: request.active,
    client,
    cache,
  });
  logSummary(result.summary);

  return {
    type: "sift:scored",
    answers: Object.fromEntries(result.answers),
    summary: result.summary,
  };
}

async function handleSettings(): Promise<SettingsResponse> {
  const settings = await loadSettings();
  return {
    type: "sift:settings:ok",
    // The key itself never leaves the worker.
    hasApiKey: settings.apiKey.length > 0,
    reviewCap: settings.reviewCap,
    defaultThreshold: settings.defaultThreshold,
    enabledSites: settings.enabledSites,
  };
}

chrome.runtime.onMessage.addListener((message: Request, _sender, sendResponse) => {
  if (message?.type === "sift:score") {
    handleScore(message).then(sendResponse);
    return true; // async response
  }
  if (message?.type === "sift:settings") {
    handleSettings().then(sendResponse);
    return true;
  }
  return false;
});

// Open the settings page on first install so the key can be entered.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") chrome.runtime.openOptionsPage();
});
