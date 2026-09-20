/**
 * Surviving a service worker that goes away mid-run.
 *
 * MV3 evicts an idle service worker after roughly 30 seconds. Two things follow
 * from that, and both live here so they can be tested without a browser:
 *
 *   - Score in chunks, so the worker is messaged repeatedly rather than once for
 *     a whole page. An eviction then costs one chunk, not the run.
 *   - Retry a message that found no worker. Sending to a dead worker rejects
 *     rather than waking it in time, so the second attempt is the wake-up.
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
