// Settle every worker before leaving a read observation, including failures.
export async function mapReads(items, work, concurrency = 4) {
  let cursor = 0;
  const results = new Array(items.length);
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await work(items[index], index);
    }
  });
  const settled = await Promise.allSettled(workers);
  const failure = settled.find(r => r.status === 'rejected');
  if (failure) throw failure.reason;
  return results;
}
