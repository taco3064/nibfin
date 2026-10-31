const day = 86400000;
const headersOf = (response) =>
  Object.fromEntries(
    Object.entries(response?.headers ?? {}).map(([key, value]) => [
      key.toLowerCase(),
      String(value),
    ]),
  );

// Shared by bounded provider retries and persistent Host cooldown storage.
// This is a denial hint, never an authorization or an execution receipt.
function cooldownFromResponse(response, now) {
  const headers = headersOf(response);
  const exhausted = headers['x-ratelimit-remaining'] === '0';
  const limited = [403, 429].includes(response?.status);
  const secondary =
    limited &&
    (response.status === 429 ||
      headers['retry-after'] !== undefined ||
      /secondary rate limit/i.test(response.body ?? ''));
  if (!exhausted && !secondary) return null;
  const deadlines = [];
  if (exhausted && /^\d+$/.test(headers['x-ratelimit-reset'] ?? '')) {
    deadlines.push(Number(headers['x-ratelimit-reset']) * 1000);
  }
  if (limited && headers['retry-after'] !== undefined) {
    const raw = headers['retry-after'];
    deadlines.push(
      /^\d+(?:\.\d+)?$/.test(raw) ? now + Number(raw) * 1000 : Date.parse(raw),
    );
  }
  if (secondary && !exhausted && !deadlines.length) deadlines.push(now + 60000);
  if (
    !deadlines.length ||
    deadlines.some((value) => !Number.isSafeInteger(value) || value > now + day)
  )
    return null;
  const resetAt = Math.max(...deadlines);
  const resource = exhausted
    ? headers['x-ratelimit-resource'] === 'core'
      ? 'core'
      : 'github'
    : 'secondary';
  return {
    version: 1,
    resource,
    resetAt,
    observedAt: now,
    reason: 'github-api-rate-limit',
  };
}

export function githubRateLimit(response, { now = Date.now() } = {}) {
  const cooldown = cooldownFromResponse(response, now);
  return cooldown && cooldown.resetAt > now ? cooldown : null;
}

export function githubRetryDelay(headers, now, attempt, rateLimited) {
  let delay = Math.min(1000 * 2 ** (attempt - 1), 8000);
  if (rateLimited) {
    const hinted =
      headers['retry-after'] !== undefined ||
      headers['x-ratelimit-remaining'] === '0';
    if (!hinted) return Math.max(delay, 60000 * 2 ** (attempt - 1));
    const response = { status: 429, headers };
    const cooldown = cooldownFromResponse(response, now);
    if (cooldown) delay = Math.max(delay, cooldown.resetAt - now);
    else return Infinity;
  } else if (headers['retry-after'] !== undefined) {
    const cooldown = cooldownFromResponse({ status: 429, headers }, now);
    if (!cooldown) return Infinity;
    delay = Math.max(delay, cooldown.resetAt - now);
  }
  return delay;
}
