/**
 * Bounded-concurrency map — like `Promise.allSettled(items.map(fn))`
 * but never has more than `limit` calls to `fn` in flight at once.
 *
 * Why this exists: `loadAllContributions`/`loadAllEvents` used to fan
 * out ALL file reads for a directory in one `Promise.allSettled` call
 * (up to 70+ simultaneous outbound fetches in a single Worker
 * invocation). `listExpenses` never had this problem because it reads
 * files sequentially in a plain loop — and expenses always listed
 * reliably while contributions/events intermittently came back
 * incomplete. Cloudflare Workers cap concurrent open connections per
 * invocation; firing dozens of fetches at once risks silently
 * exceeding that cap, which looks exactly like "some files just
 * didn't come back" with no thrown error to catch. Batching at a
 * safe width keeps the speed benefit of parallelism without risking
 * the ceiling.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      try {
        const value = await fn(items[i], i);
        results[i] = { status: 'fulfilled', value };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, () => worker());
  await Promise.all(workers);
  return results;
}
