/**
 * Settings page.
 *
 * The only place the API key is entered. It goes straight into
 * chrome.storage.local and is read only by the service worker.
 */
import { AnswerCache, MAX_ENTRIES, type StorageArea } from "../background/cache.js";
import { loadSettings, saveSettings, type Settings } from "../shared/settings.js";

const storage: StorageArea = {
  get: (keys) => chrome.storage.local.get(keys),
  set: (items) => chrome.storage.local.set(items),
  remove: (keys) => chrome.storage.local.remove(keys),
};

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing element #${id}`);
  return found as T;
}

function flash(node: HTMLElement, message: string, warn = false): void {
  node.textContent = message;
  node.classList.toggle("warn", warn);
  setTimeout(() => {
    node.textContent = "";
  }, 2500);
}

async function main(): Promise<void> {
  const key = el<HTMLInputElement>("key");
  const reveal = el<HTMLInputElement>("reveal");
  const cap = el<HTMLInputElement>("cap");
  const threshold = el<HTMLInputElement>("threshold");
  const thresholdValue = el("thresholdValue");
  const siteIn = el<HTMLInputElement>("site-in");
  const siteCom = el<HTMLInputElement>("site-com");
  const save = el<HTMLButtonElement>("save");
  const status = el("status");
  const clearCache = el<HTMLButtonElement>("clearCache");
  const cacheStatus = el("cacheStatus");
  const cacheInfo = el("cacheInfo");

  const settings = await loadSettings();
  key.value = settings.apiKey;
  cap.value = String(settings.reviewCap);
  threshold.value = String(settings.defaultThreshold);
  thresholdValue.textContent = settings.defaultThreshold.toFixed(2);
  siteIn.checked = settings.enabledSites["amazon.in"];
  siteCom.checked = settings.enabledSites["amazon.com"];

  reveal.addEventListener("change", () => {
    key.type = reveal.checked ? "text" : "password";
  });

  threshold.addEventListener("input", () => {
    thresholdValue.textContent = Number(threshold.value).toFixed(2);
  });

  const cache = new AnswerCache(storage);
  const showCacheSize = async () => {
    const size = await cache.size();
    cacheInfo.textContent =
      `${size.toLocaleString()} of ${MAX_ENTRIES.toLocaleString()} cached answers. ` +
      `Answers are cached so a repeat visit costs nothing; the oldest are dropped first.`;
  };
  await showCacheSize();

  clearCache.addEventListener("click", () => {
    void cache.clear().then(async () => {
      await showCacheSize();
      flash(cacheStatus, "Cache cleared.");
    });
  });

  save.addEventListener("click", () => {
    const capValue = Number.parseInt(cap.value, 10);
    if (!Number.isFinite(capValue) || capValue < 10) {
      flash(status, "Review cap must be at least 10.", true);
      return;
    }

    const next: Settings = {
      apiKey: key.value.trim(),
      reviewCap: capValue,
      defaultThreshold: Number(threshold.value),
      enabledSites: { "amazon.in": siteIn.checked, "amazon.com": siteCom.checked },
    };

    void saveSettings(next).then(() => {
      flash(status, next.apiKey ? "Saved." : "Saved, but no API key: Sift will not score.", !next.apiKey);
    });
  });
}

void main();
