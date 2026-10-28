// Reused from Kairo d1b47d5e073cf15bdcdc1fbbec098401649878d9.
export function credentialStrings(value) {
  if (typeof value === 'string') return value.length >= 20 ? [value] : [];
  if (value && typeof value === 'object') return Object.values(value).flatMap(credentialStrings);
  return [];
}
export function redactCredentials(text, secrets) {
  let result = text;
  for (const secret of secrets.filter(s => typeof s === 'string' && s.length)) {
    const bytes=Buffer.from(secret);
    for (const form of new Set([secret, JSON.stringify(secret).slice(1,-1), bytes.toString('base64'),bytes.toString('base64url'),bytes.toString('hex'),bytes.toString('hex').toUpperCase(),encodeURIComponent(secret)])) result = result.split(form).join('[REDACTED CREDENTIAL]');
  }
  return result;
}
export function containsCredentials(text, secrets) { return redactCredentials(text, secrets) !== text; }
