/**
 * Messages between the content script and the service worker.
 *
 * The content script owns the DOM and never sees the API key. The service
 * worker owns the key, the API client and the cache, and never touches the DOM.
 */
import type { ActiveFilters } from "../questions/buildQuestions.js";
import type { AnswerMap } from "../questions/combine.js";
import type { PageSummary } from "../background/pipeline.js";
import type { ProductContext, Review } from "./types.js";

export interface ScoreRequest {
  type: "sift:score";
  product: ProductContext;
  reviews: Review[];
  active: ActiveFilters;
}

export interface ScoreResponse {
  type: "sift:scored";
  /** Answers per review id. */
  answers: Record<string, AnswerMap>;
  summary: PageSummary;
  /** Set when the whole run could not start, e.g. no API key configured. */
  error?: { reason: "no_api_key" | "unavailable"; message: string };
}

export interface SettingsRequest {
  type: "sift:settings";
}

export interface SettingsResponse {
  type: "sift:settings:ok";
  /** Never includes the key itself: the panel only needs to know it exists. */
  hasApiKey: boolean;
  reviewCap: number;
  defaultThreshold: number;
  enabledSites: Record<string, boolean>;
  confirmAboveUsd: number;
  maxPageSpendUsd: number;
}

export type Request = ScoreRequest | SettingsRequest;
export type Response = ScoreResponse | SettingsResponse;

/** Send a message to the service worker, never throwing at the call site. */
export async function sendMessage<T extends Response>(request: Request): Promise<T | null> {
  try {
    return (await chrome.runtime.sendMessage(request)) as T;
  } catch {
    // The worker can be asleep or the extension reloading; the page must survive.
    return null;
  }
}
