export const REDACTED = '[REDACTED]';
export const UNPARSEABLE_URL = '[unparseable-url]';

// Headers whose values are safe to record verbatim. Any other header is kept by
// name only — its presence is a discovery signal, but its value may carry
// credentials (authorization, cookie, x-csrf-token, custom session headers).
const SAFE_HEADERS = new Set([
  'accept',
  'accept-language',
  'cache-control',
  'content-disposition',
  'content-length',
  'content-type',
  'location',
  'x-canvas-meta',
]);

const SENSITIVE_QUERY_PARAM = /(token|secret|password|passwd|session|cookie|auth|signature|\bsig\b|verifier|ticket|sso|jwt|key)/i;

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    result[lower] = SAFE_HEADERS.has(lower) ? value : REDACTED;
  }
  return result;
}

export function redactUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    // An unparseable URL may still embed credentials — never echo it back
    return UNPARSEABLE_URL;
  }
  for (const name of Array.from(url.searchParams.keys())) {
    if (SENSITIVE_QUERY_PARAM.test(name)) {
      url.searchParams.set(name, REDACTED);
    }
  }
  return url.toString();
}

export interface BodySummary {
  kind: 'form' | 'multipart' | 'json' | 'text';
  // Field names only — values are never recorded
  field_names: string[];
}

export function summarizeBody(
  contentType: string | null | undefined,
  postData: string | null | undefined,
): BodySummary | null {
  if (postData === null || postData === undefined || postData === '') return null;
  const normalized = (contentType ?? '').split(';')[0].trim().toLowerCase();

  if (normalized === 'application/x-www-form-urlencoded') {
    const names = Array.from(new Set(Array.from(new URLSearchParams(postData).keys())));
    return { kind: 'form', field_names: names };
  }

  if (normalized === 'multipart/form-data') {
    const names = new Set<string>();
    for (const match of postData.matchAll(/\bname="([^"]+)"/g)) {
      names.add(match[1]);
    }
    return { kind: 'multipart', field_names: Array.from(names) };
  }

  if (normalized === 'application/json' || normalized.endsWith('+json')) {
    try {
      const parsed = JSON.parse(postData) as unknown;
      const names = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? Object.keys(parsed as Record<string, unknown>)
        : [];
      return { kind: 'json', field_names: names };
    } catch {
      return { kind: 'json', field_names: [] };
    }
  }

  return { kind: 'text', field_names: [] };
}
