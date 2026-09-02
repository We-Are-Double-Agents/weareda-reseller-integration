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

/* -------------------------------------------------------------------------- */
/* Fiscal identifiers (contract 4.3, 11.8)                                     */
/* -------------------------------------------------------------------------- */

/**
 * Masks a customer's fiscal identifier (`customer.tax_id.value`).
 *
 * A tax id is not a credential, so the redaction list above does not cover it -
 * it is ordinary payload data that happens to be sensitive personal data. The
 * contract asks both sides to mask it wherever it reaches an operational log
 * (11.8), and WeAreDA uses exactly this shape:
 *
 *     20-12345678-9  ->  20-******78-9
 *
 * The first two and last three ALPHANUMERICS survive, every separator is
 * preserved, and the length is not disclosed by the separators alone. That is
 * enough to answer "is this the id I think it is?" while disclosing nothing
 * usable. A value too short to mask that way is hidden completely rather than
 * leaked in part.
 *
 * IDEMPOTENT: masking an already-masked value returns it unchanged. That
 * matters because two layers mask independently - the request logger and the
 * event log - and a second pass over `20-******78-9` would otherwise see five
 * alphanumerics and blank the lot. No real identifier contains an asterisk.
 */
export function maskTaxId(value: string | null | undefined): string {
  if (!value) return '(none)';
  if (value.includes('*')) return value;

  const positions: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (isAlphanumeric(value[index] as string)) positions.push(index);
  }

  if (positions.length <= 5) return value.replace(/[a-z0-9]/gi, '*');

  const keep = new Set([...positions.slice(0, 2), ...positions.slice(-3)]);
  return [...value]
    .map((char, index) => (isAlphanumeric(char) && !keep.has(index) ? '*' : char))
    .join('');
}

function isAlphanumeric(char: string): boolean {
  return /[a-z0-9]/i.test(char);
}

/**
 * True for every spelling of a tax-id key this repository can meet:
 * `tax_id` (the pushed payload, 4.3), `taxId` (the read API, 11.3) and the
 * `customer_tax_id` column the sandbox stores for its invoice flow.
 */
function isTaxIdKey(key: string): boolean {
  return key.toLowerCase().replace(/_/g, '').endsWith('taxid');
}

/**
 * Returns a COPY of any JSON-ish value with every fiscal identifier masked.
 *
 * Applied at the boundary of everything that renders a payload - the request
 * log, the local event history, the debug views and the CLI - so that no code
 * path has to remember. The reseller's own `orders` table deliberately keeps
 * the real value: you cannot invoice against a masked id.
 */
export function maskTaxIds<T>(value: T): T {
  return maskNode(value) as T;
}

function maskNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map((entry) => maskNode(entry));
  if (node === null || typeof node !== 'object') return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (!isTaxIdKey(key)) {
      out[key] = maskNode(value);
      continue;
    }
    // `{ type, value, country }` on the wire, a bare string in the column.
    if (typeof value === 'string') {
      out[key] = maskTaxId(value);
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const taxId = { ...(value as Record<string, unknown>) };
      if (typeof taxId.value === 'string') taxId.value = maskTaxId(taxId.value);
      out[key] = taxId;
    } else {
      out[key] = maskNode(value);
    }
  }
  return out;
}
