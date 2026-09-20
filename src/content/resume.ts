/**
 * Deciding what to send, in what order, and how far to go.
 *
 * All pure, so the rules that decide how someone's money is spent can be tested
 * without a browser:
 *
 *   - Score in chunks, so the worker is messaged repeatedly rather than once for
 *     a whole page. MV3 evicts an idle service worker after roughly 30 seconds,
 *     so an eviction then costs one chunk, not the run.
 *   - Retry a message that found no worker. Sending to a dead worker rejects
 *     rather than waking it in time, so the second attempt is the wake-up.
 *   - Send what the user is looking at first, so a run that stops early still
 *     covers the reviews on screen.
 *   - Stop before crossing the page's spend ceiling, rather than after.
 */

/** Split a list into runs of at most `size`, preserving order. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new RangeError("chunk size must be at least 1");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Send once, and if nothing came back, wait and send again.
 *
 * One retry, not a loop: a second failure means something other than an
 * eviction, and hammering a broken channel helps nobody. The caller offers the
 * user a Resume button instead, which is cheap because the cache means a resumed
 * run re-asks only what was never answered.
 */
export async function sendWithRetry<T>(
  send: () => Promise<T | null>,
  waitMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T | null> {
  const first = await send();
  if (first) return first;
  await sleep(waitMs);
  return send();
}

/**
 * Order work so the reviews on screen are scored first.
 *
 * `top` is the card's offset from the top of the viewport, as
 * `getBoundingClientRect().top` gives it: negative above, positive below.
 * Anything currently visible comes first, in page order. Then everything below
 * the fold, nearest first, because that is where the user is heading. Then what
 * has scrolled past, nearest last.
 *
 * This matters because of the spend ceiling: a run that stops half way should
 * have spent its money on what the person was actually reading.
 */
export function orderByViewport<T>(
  items: readonly T[],
  top: (item: T) => number | null,
  viewportHeight: number,
): T[] {
  type Ranked = { item: T; band: number; distance: number; index: number };

  const ranked: Ranked[] = items.map((item, index) => {
    const offset = top(item);
    // A card we cannot measure (detached, or never rendered) sorts last, but is
    // never dropped: unmeasurable is not the same as unwanted.
    if (offset === null) return { item, band: 3, distance: 0, index };
    if (offset >= 0 && offset < viewportHeight) return { item, band: 0, distance: offset, index };
    if (offset >= viewportHeight) return { item, band: 1, distance: offset - viewportHeight, index };
    return { item, band: 2, distance: -offset, index };
  });

  ranked.sort((a, b) => {
    if (a.band !== b.band) return a.band - b.band;
    if (a.distance !== b.distance) return a.distance - b.distance;
    // Stable within a band, so repeated runs do not reshuffle the queue.
    return a.index - b.index;
  });

  return ranked.map((entry) => entry.item);
}

/**
 * Whether the next chunk fits under the page's ceiling.
 *
 * Checked against the estimate BEFORE sending, not the real cost after: a
 * ceiling you only notice having crossed is not a ceiling. A ceiling of 0 means
 * the user turned it off.
 */
export function withinBudget(spentUsd: number, nextUsd: number, ceilingUsd: number): boolean {
  if (ceilingUsd <= 0) return true;
  return spentUsd + nextUsd <= ceilingUsd;
}
