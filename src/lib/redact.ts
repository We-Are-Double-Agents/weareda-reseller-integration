/**
 * Secrets must never reach the console or the local event history.
 *
 * The sandbox prints full request/response bodies on purpose - that is the
 * whole point of a reference implementation - so the redaction list below is
 * what keeps that safe.
 */
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'x-reseller-key',
  'x-weareda-signature',
  'cookie',
  'set-cookie',
]);

export function isSensitiveHeader(name: string): boolean {
  return SENSITIVE_HEADERS.has(name.toLowerCase());
}

export function redactHeaders(headers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const rendered = Array.isArray(value) ? value.join(', ') : String(value ?? '');
    out[name] = isSensitiveHeader(name) ? mask(rendered) : rendered;
  }
  return out;
}

/**
 * Masks a credential so that logs stay useful ("is it the value I think it
 * is?") without ever disclosing it.
 */
export function mask(value: string | undefined | null): string {
  if (!value) return '(not set)';
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}${'*'.repeat(Math.min(12, value.length - 8))}${value.slice(-4)}`;
}

/** Masks the credential part of a URL and any query-string secret. */
export function maskUrl(url: string): string {
  if (!url) return '(not set)';
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '****';
    if (parsed.username) parsed.username = '****';
    for (const key of ['key', 'secret', 'token', 'signature']) {
      if (parsed.searchParams.has(key)) parsed.searchParams.set(key, '****');
    }
    return parsed.toString();
  } catch {
    return url;
  }
}
