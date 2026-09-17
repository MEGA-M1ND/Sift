/**
 * Answer cache, so a repeat visit to a product page costs nothing.
 *
 * Lives in the service worker beside the client. Storage is injected rather
 * than calling `chrome.storage.local` directly, so the eviction policy can be
 * tested without a browser.
 */
import type { NoulResponse, ScoreResponse } from "@typesafe-ai/sdk";
import { cacheKey, isCacheKey } from "../shared/hashing.js";

/** Spec: at most this many cached answers, evicting least-recently-used first. */
export const MAX_ENTRIES = 5_000;

/**
 * Evict in batches. Removing one entry per write would mean a storage write on
 * every single scored review once the cache is full.
 */
const EVICTION_BATCH = 250;

export type CachedAnswer = NoulResponse | ScoreResponse;

/** One stored entry: the answer, and when it was last used. */
interface Entry {
  /** The answer, exactly as the API returned it. */
  a: CachedAnswer;
  /** Last-used timestamp, milliseconds. */
  t: number;
}

/** The subset of `chrome.storage.local` this needs. */
export interface StorageArea {
  get(keys: string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

/** In-memory storage, used by tests and as a fallback when storage is unavailable. */
export class MemoryStorage implements StorageArea {
  readonly data = new Map<string, unknown>();

  async get(keys: string[] | null): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    if (keys === null) {
      for (const [key, value] of this.data) out[key] = value;
      return out;
    }
    for (const key of keys) {
      if (this.data.has(key)) out[key] = this.data.get(key);
    }
    return out;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) this.data.set(key, value);
  }

  async remove(keys: string[]): Promise<void> {
    for (const key of keys) this.data.delete(key);
  }
}

function isEntry(value: unknown): value is Entry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<Entry>;
  return typeof entry.t === "number" && typeof entry.a === "object" && entry.a !== null;
}

export class AnswerCache {
  readonly #storage: StorageArea;
  /** key -> last-used time. Mirrors what is in storage, rebuilt on first use. */
  #index: Map<string, number> | null = null;
  #hits = 0;
  #misses = 0;

  constructor(storage: StorageArea) {
    this.#storage = storage;
  }

  get hits(): number {
    return this.#hits;
  }

  get misses(): number {
    return this.#misses;
  }

  /**
   * The service worker is killed and restarted freely, so the index is rebuilt
   * from storage on first use rather than kept across sessions.
   */
  async #loadIndex(): Promise<Map<string, number>> {
    if (this.#index) return this.#index;
    const index = new Map<string, number>();
    const all = await this.#storage.get(null);
    for (const [key, value] of Object.entries(all)) {
      if (isCacheKey(key) && isEntry(value)) index.set(key, value.t);
    }
    this.#index = index;
    return index;
  }

  /** Cached answers for the given (reviewId, questionText) pairs. */
  async getMany(
    lookups: ReadonlyArray<{ reviewId: string; questionText: string; key: string }>,
  ): Promise<Map<string, CachedAnswer>> {
    if (lookups.length === 0) return new Map();
    const index = await this.#loadIndex();

    const storageKeys: string[] = [];
    const byStorageKey = new Map<string, string>();
    for (const lookup of lookups) {
      const storageKey = await cacheKey(lookup.reviewId, lookup.questionText);
      // Not in the index means not in storage; skip the read entirely.
      if (!index.has(storageKey)) continue;
      storageKeys.push(storageKey);
      byStorageKey.set(storageKey, lookup.key);
    }

    const found = new Map<string, CachedAnswer>();
    if (storageKeys.length > 0) {
      const stored = await this.#storage.get(storageKeys);
      const now = Date.now();
      for (const [storageKey, value] of Object.entries(stored)) {
        if (!isEntry(value)) continue;
        const questionKey = byStorageKey.get(storageKey);
        if (!questionKey) continue;
        found.set(questionKey, value.a);
        // Touch in memory only: persisting a timestamp on every read would
        // double the write volume for no benefit the user can see.
        index.set(storageKey, now);
      }
    }

    this.#hits += found.size;
    this.#misses += lookups.length - found.size;
    return found;
  }

  /** Store answers, then evict if we are over the cap. */
  async putMany(
    entries: ReadonlyArray<{ reviewId: string; questionText: string; answer: CachedAnswer }>,
  ): Promise<void> {
    if (entries.length === 0) return;
    const index = await this.#loadIndex();
    const now = Date.now();

    const items: Record<string, Entry> = {};
    for (const entry of entries) {
      const storageKey = await cacheKey(entry.reviewId, entry.questionText);
      items[storageKey] = { a: entry.answer, t: now };
      index.set(storageKey, now);
    }
    await this.#storage.set(items);
    await this.#evictIfNeeded();
  }

  /** Drop the least recently used entries until we are back under the cap. */
  async #evictIfNeeded(): Promise<void> {
    const index = await this.#loadIndex();
    if (index.size <= MAX_ENTRIES) return;

    const overBy = index.size - MAX_ENTRIES;
    // Evict a batch beyond what is strictly needed, so this runs rarely.
    const toRemove = Math.min(index.size, overBy + EVICTION_BATCH);

    const oldestFirst = [...index.entries()].sort((a, b) => a[1] - b[1]);
    const doomed = oldestFirst.slice(0, toRemove).map(([key]) => key);

    await this.#storage.remove(doomed);
    for (const key of doomed) index.delete(key);
  }

  /** Number of cached answers. */
  async size(): Promise<number> {
    return (await this.#loadIndex()).size;
  }

  /** Remove everything this project owns. Used by the settings page. */
  async clear(): Promise<void> {
    const index = await this.#loadIndex();
    await this.#storage.remove([...index.keys()]);
    index.clear();
  }
}
