// Structured error result shared by the read-only tools (and beyond).
// Tools return this JSON shape instead of throwing raw strings, so MCP clients
// get a stable, machine-readable failure contract.

export interface ToolErrorResult {
  ok: false;
  error_code: string;
  message: string;       // human-facing, Korean
  retryable: boolean;
  next_action?: string;  // what the caller should try next
  debug?: string;        // sanitized technical detail, never credentials
}

/**
 * Strips URLs of query/hash (which may carry tokens) and clamps length, so a
 * raw error message can be safely surfaced in the `debug` field.
 */
export function sanitizeDebug(reason: string): string {
  return reason
    .replace(/https?:\/\/[^\s"'<>]+/g, (raw) => {
      try {
        const url = new URL(raw);
        url.search = '';
        url.hash = '';
        return url.toString();
      } catch {
        return '[url]';
      }
    })
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

/**
 * Heuristic: Canvas/network errors that are worth retrying. Auth/permission/
 * not-found are not retryable.
 */
export function isRetryableReason(reason: string): boolean {
  const normalized = reason.toLowerCase();
  if (/\b(400|401|403|404|409|422)\b/.test(normalized)) return false;
  if (normalized.includes('not in allowlist')) return false;
  if (normalized.includes('invalid url')) return false;
  if (/\b(429|5\d\d)\b/.test(normalized)) return true;
  if (normalized.includes('timeout') || normalized.includes('timed out')) return true;
  if (normalized.includes('network') || normalized.includes('econnreset') || normalized.includes('etimedout')) return true;
  if (normalized.includes('net::')) return true;
  return true;
}

export function toErrorResult(
  errorCode: string,
  message: string,
  options: { err?: unknown; retryable?: boolean; nextAction?: string } = {},
): ToolErrorResult {
  const rawReason = options.err instanceof Error ? options.err.message : options.err !== undefined ? String(options.err) : '';
  const debug = rawReason ? sanitizeDebug(rawReason) : undefined;
  const retryable = options.retryable ?? (rawReason ? isRetryableReason(rawReason) : false);
  return {
    ok: false,
    error_code: errorCode,
    message,
    retryable,
    ...(options.nextAction ? { next_action: options.nextAction } : {}),
    ...(debug ? { debug } : {}),
  };
}
