/**
 * User settings, stored in `chrome.storage.local`.
 *
 * The API key lives here and nowhere else. It is read only by the service
 * worker; the content script never sees it and never needs to.
 */
import type { Site } from "../content/page.js";

export interface Settings {
  apiKey: string;
  /** Maximum reviews collected from one page. */
  reviewCap: number;
  /** Where the threshold slider starts. */
  defaultThreshold: number;
  /** Per-site enable toggle. */
  enabledSites: Record<Site, boolean>;
  /**
   * Ask before a page's estimated spend exceeds this, in USD. 0 always asks.
   * A run is never started without the user's say-so above this figure.
   */
  confirmAboveUsd: number;
  /**
   * Hard ceiling on what one page may spend, in USD. Scoring stops when the
   * next chunk would cross it. 0 means no ceiling.
   *
   * This is the backstop for the case the confirmation does not cover: a run
   * that was agreed to, but turns out to cost far more than expected.
   */
  maxPageSpendUsd: number;
}

export const DEFAULT_SETTINGS: Settings = {
  apiKey: "",
  reviewCap: 300,
  defaultThreshold: 0.7,
  enabledSites: { "amazon.in": true, "amazon.com": true },
  confirmAboveUsd: 0.01,
  maxPageSpendUsd: 0.05,
};

const KEY = "sift:settings";

/** Read settings, falling back to defaults for anything missing or corrupt. */
export async function loadSettings(): Promise<Settings> {
  try {
    const stored = await chrome.storage.local.get(KEY);
    const raw = stored[KEY];
    if (typeof raw !== "object" || raw === null) return { ...DEFAULT_SETTINGS };
    const partial = raw as Partial<Settings>;
    return {
      apiKey: typeof partial.apiKey === "string" ? partial.apiKey : DEFAULT_SETTINGS.apiKey,
      reviewCap:
        typeof partial.reviewCap === "number" && partial.reviewCap > 0
          ? Math.floor(partial.reviewCap)
          : DEFAULT_SETTINGS.reviewCap,
      defaultThreshold:
        typeof partial.defaultThreshold === "number" &&
        partial.defaultThreshold >= 0 &&
        partial.defaultThreshold <= 1
          ? partial.defaultThreshold
          : DEFAULT_SETTINGS.defaultThreshold,
      enabledSites: { ...DEFAULT_SETTINGS.enabledSites, ...(partial.enabledSites ?? {}) },
      confirmAboveUsd:
        typeof partial.confirmAboveUsd === "number" && partial.confirmAboveUsd >= 0
          ? partial.confirmAboveUsd
          : DEFAULT_SETTINGS.confirmAboveUsd,
      maxPageSpendUsd:
        typeof partial.maxPageSpendUsd === "number" && partial.maxPageSpendUsd >= 0
          ? partial.maxPageSpendUsd
          : DEFAULT_SETTINGS.maxPageSpendUsd,
    };
  } catch {
    // Storage can be unavailable; the extension must still not break the page.
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [KEY]: settings });
}
