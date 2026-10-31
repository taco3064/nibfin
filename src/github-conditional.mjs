// Upstream uses authenticated conditional GETs, not offline authority caches.
// A 304 is a new server observation. Denials/unavailable reads never fall back
// to saved data, and mutations invalidate enclosing/in-flight generations.
export function createConditionalGithubTransport({
  send,
  onResponse = async () => {},
} = {}) {
  const cache = new Map();
  let generation = 0,
    bytes = 0,
    requests = 0,
    notModified = 0;
  const headers = (r) =>
    Object.fromEntries(
      Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]),
    );
  const invalidate = () => {
    generation++;
    cache.clear();
    bytes = 0;
  };
  async function invoke(request, actual = send, retry = true) {
    const read = request.method === 'GET';
    if (!read) invalidate();
    // Native collections depend on fresh Link headers. Leave them unconditional
    // rather than reconstructing pagination metadata from an old representation.
    const eligible = read && !/[?&](?:per_page|page)=/.test(request.endpoint),
      h = headers(request);
    const key = JSON.stringify([
        request.identity ?? null,
        h.accept,
        h['x-github-api-version'],
        request.endpoint,
      ]),
      old = eligible ? cache.get(key) : null,
      start = generation;
    requests++;
    const response = await actual(
      old
        ? { ...request, headers: { ...request.headers, 'If-None-Match': old.etag } }
        : request,
    );
    await onResponse(response);
    if (read && [200, 304].includes(response?.status) && start !== generation) {
      if (retry) return invoke(request, actual, false);
      return {
        status: 503,
        headers: {},
        body: 'Read observation invalidated by concurrent mutation',
      };
    }
    if (response?.status === 304 && old) {
      notModified++;
      return { ...response, status: 200, body: old.body };
    }
    const etag = response && headers(response).etag;
    if (
      eligible &&
      response?.status === 200 &&
      typeof response.body === 'string' &&
      typeof etag === 'string' &&
      etag.length <= 1024 &&
      !/[\r\n]/.test(etag) &&
      start === generation
    ) {
      const size = Buffer.byteLength(response.body);
      if (size <= 1048576) {
        if (cache.has(key)) {
          bytes -= cache.get(key).size;
          cache.delete(key);
        }
        while (cache.size && (cache.size >= 512 || bytes + size > 16777216)) {
          const first = cache.keys().next().value;
          bytes -= cache.get(first).size;
          cache.delete(first);
        }
        cache.set(key, { etag, body: response.body, size });
        bytes += size;
      }
    }
    return response;
  }
  const transport = (request) => invoke(request);
  if (typeof send.prepareMutation === 'function')
    Object.defineProperty(transport, 'prepareMutation', {
      value: async (options) => {
        invalidate();
        const prepared = await send.prepareMutation(options);
        return (request) => invoke(request, prepared);
      },
    });
  Object.defineProperty(transport, 'metrics', {
    value: () => ({ requests, notModified, entries: cache.size, bytes }),
  });
  return Object.freeze(transport);
}
