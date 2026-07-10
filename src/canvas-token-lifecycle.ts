import { randomUUID } from 'node:crypto';
import type {
  CachedToken,
  CachedTokenRevocation,
  CachedTokenV2,
} from './types.js';

export const CANVAS_BASE_URL = 'https://eclass3.cau.ac.kr';
export const CANVAS_JSON_ACCEPT = 'application/json+canvas-string-ids, application/json';
export const CANVAS_TOKEN_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
export const CANVAS_TOKEN_VALIDITY_BUFFER_MS = 60 * 60 * 1000;
export const CANVAS_TOKEN_PURPOSE_PREFIX = 'eclass-mcp:';
export const CANVAS_TOKEN_RECOVERY_CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface CreatedCanvasTokenCandidate {
  token: string;
  id: string | null;
  expires_at: string | null;
}

export interface CanvasTokenRecoveryCriteria {
  purpose: string;
  request_started_at: string;
  requested_expires_at: string;
  observed_at: string;
}

export type CanvasTokenRecoverySelection =
  | { kind: 'found'; revocation: CachedTokenRevocation }
  | { kind: 'none' | 'ambiguous' | 'invalid' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return nonEmptyString(value);
}

export function createCanvasTokenPurpose(): string {
  const purpose = `${CANVAS_TOKEN_PURPOSE_PREFIX}${Date.now().toString(36)}:${randomUUID()}`;
  if (purpose.length > 255) {
    throw new Error('Canvas token purpose correlation exceeded 255 characters');
  }
  return purpose;
}

export function deriveCanvasTokenHint(token: string): string {
  return token.slice(0, 5);
}

/**
 * Tolerantly extracts the newly-created secret before validating metadata so a
 * malformed response can still be compensated with a best-effort revocation.
 */
export function extractCreatedCanvasTokenCandidate(
  responseBody: unknown,
): CreatedCanvasTokenCandidate | null {
  if (!isRecord(responseBody)) return null;
  const token = nonEmptyString(responseBody.visible_token) ?? nonEmptyString(responseBody.token);
  if (!token) return null;

  return {
    token,
    id: normalizeId(responseBody.id),
    expires_at: nonEmptyString(responseBody.expires_at),
  };
}

/** Extracts a revocation target even when the response omitted the secret. */
export function extractCreatedCanvasTokenRevocation(
  responseBody: unknown,
): CachedTokenRevocation | null {
  if (!isRecord(responseBody)) return null;
  const id = normalizeId(responseBody.id);
  if (id) return { id };
  const token = nonEmptyString(responseBody.visible_token) ?? nonEmptyString(responseBody.token);
  const tokenHint = token ? deriveCanvasTokenHint(token) : null;
  return tokenHint?.length === 5 ? { token_hint: tokenHint } : null;
}

export interface CanvasTokenCreationResponseForCompensation {
  ok: boolean;
  responseUrl: string;
  body: unknown;
}

/**
 * A non-2xx response may still describe a token Canvas actually issued. HTTP
 * status is therefore deliberately not a compensation gate; only durable
 * persistence, same-origin provenance, and revocable response metadata are.
 */
export function revocationForCreatedCanvasTokenCompensation(
  response: CanvasTokenCreationResponseForCompensation,
  persisted: boolean,
): CachedTokenRevocation | null {
  if (persisted || !response.responseUrl) return null;
  try {
    if (new URL(response.responseUrl).origin !== CANVAS_BASE_URL) return null;
  } catch {
    return null;
  }
  return extractCreatedCanvasTokenRevocation(response.body);
}

/**
 * Reconcile an ambiguous create by selecting only a single, exact correlation
 * purpose whose server metadata fits the request window. Broad purpose matches
 * or multiple targets are never deleted.
 */
export function selectCanvasTokenForRecovery(
  responseBody: unknown,
  criteria: CanvasTokenRecoveryCriteria,
): CanvasTokenRecoverySelection {
  if (!Array.isArray(responseBody)) return { kind: 'invalid' };
  const requestStartedAtMs = Date.parse(criteria.request_started_at);
  const requestedExpiresAtMs = Date.parse(criteria.requested_expires_at);
  const observedAtMs = Date.parse(criteria.observed_at);
  if (
    !criteria.purpose ||
    criteria.purpose.length > 255 ||
    !Number.isFinite(requestStartedAtMs) ||
    !Number.isFinite(requestedExpiresAtMs) ||
    !Number.isFinite(observedAtMs) ||
    requestedExpiresAtMs <= requestStartedAtMs ||
    observedAtMs < requestStartedAtMs
  ) {
    return { kind: 'invalid' };
  }

  const metadataMatches: unknown[] = [];
  for (const value of responseBody) {
    if (!isRecord(value) || value.purpose !== criteria.purpose) continue;
    const createdAt = nonEmptyString(value.created_at);
    const expiresAt = nonEmptyString(value.expires_at);
    const createdAtMs = createdAt ? Date.parse(createdAt) : Number.NaN;
    const expiresAtMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
    if (
      value.workflow_state !== 'active' ||
      !Number.isFinite(createdAtMs) ||
      !Number.isFinite(expiresAtMs) ||
      createdAtMs < requestStartedAtMs - CANVAS_TOKEN_RECOVERY_CLOCK_SKEW_MS ||
      createdAtMs > observedAtMs + CANVAS_TOKEN_RECOVERY_CLOCK_SKEW_MS ||
      expiresAtMs <= requestStartedAtMs ||
      expiresAtMs > requestedExpiresAtMs
    ) {
      continue;
    }
    metadataMatches.push(value);
  }

  if (metadataMatches.length === 0) return { kind: 'none' };
  const targets: CachedTokenRevocation[] = [];
  for (const match of metadataMatches) {
    const normalized = normalizePendingRevocations([match as CachedTokenRevocation]);
    if (normalized.length !== 1) return { kind: 'invalid' };
    if (!targets.some((target) => revocationKey(target) === revocationKey(normalized[0]))) {
      targets.push(normalized[0]);
    }
  }
  if (targets.length !== 1) return { kind: 'ambiguous' };
  return { kind: 'found', revocation: targets[0] };
}

export function createCachedTokenV2(
  candidate: CreatedCanvasTokenCandidate,
  issuedAt: string,
  requestedExpiresAt: string,
  pendingRevocations: CachedTokenRevocation[] = [],
): CachedTokenV2 {
  if (!candidate.id) {
    throw new Error('Canvas token creation response did not include an id');
  }
  if (!candidate.expires_at) {
    throw new Error('Canvas token creation response did not include expires_at');
  }
  if (deriveCanvasTokenHint(candidate.token).length !== 5) {
    throw new Error('Canvas token creation response contained an invalid token');
  }

  const issuedAtMs = Date.parse(issuedAt);
  const requestedExpiresAtMs = Date.parse(requestedExpiresAt);
  const actualExpiresAtMs = Date.parse(candidate.expires_at);
  if (
    !Number.isFinite(issuedAtMs) ||
    !Number.isFinite(requestedExpiresAtMs) ||
    !Number.isFinite(actualExpiresAtMs)
  ) {
    throw new Error('Canvas token creation response contained an invalid expiry');
  }
  if (actualExpiresAtMs <= issuedAtMs) {
    throw new Error('Canvas token creation response contained an already-expired token');
  }
  const maximumExpiresAtMs = issuedAtMs + CANVAS_TOKEN_LIFETIME_MS;
  if (requestedExpiresAtMs > maximumExpiresAtMs || actualExpiresAtMs > requestedExpiresAtMs) {
    throw new Error('Canvas token expiry exceeds the requested 90-day lifetime');
  }

  return {
    version: 2,
    token: candidate.token,
    id: candidate.id,
    token_hint: deriveCanvasTokenHint(candidate.token),
    issued_at: issuedAt,
    // Preserve the authoritative value supplied by Canvas.
    expires_at: candidate.expires_at,
    pending_revocations: normalizePendingRevocations(pendingRevocations),
  };
}

export function isCachedTokenV2(value: unknown): value is CachedTokenV2 {
  if (!isRecord(value) || value.version !== 2) return false;
  const token = nonEmptyString(value.token);
  const tokenHint = nonEmptyString(value.token_hint);
  const issuedAt = nonEmptyString(value.issued_at);
  const expiresAt = nonEmptyString(value.expires_at);
  const issuedAtMs = issuedAt ? Date.parse(issuedAt) : Number.NaN;
  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  if (
    !token ||
    !nonEmptyString(value.id) ||
    !tokenHint ||
    tokenHint !== deriveCanvasTokenHint(token) ||
    !Number.isFinite(issuedAtMs) ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= issuedAtMs ||
    expiresAtMs > issuedAtMs + CANVAS_TOKEN_LIFETIME_MS ||
    !Array.isArray(value.pending_revocations)
  ) {
    return false;
  }
  return value.pending_revocations.every((entry) => normalizeRevocation(entry) !== null);
}

export function parseCachedToken(value: unknown): CachedToken | null {
  if (!isRecord(value)) return null;
  if (value.version !== undefined) {
    if (!isCachedTokenV2(value)) return null;
    return {
      version: 2,
      token: value.token.trim(),
      id: String(value.id).trim(),
      token_hint: value.token_hint.trim(),
      issued_at: value.issued_at,
      expires_at: value.expires_at,
      pending_revocations: normalizePendingRevocations(value.pending_revocations),
    };
  }

  // Preserve enough of any legacy cache to revoke it after successful rotation.
  const token = nonEmptyString(value.token);
  const expiresAt = nonEmptyString(value.expires_at);
  return token &&
      deriveCanvasTokenHint(token).length === 5 &&
      expiresAt &&
      Number.isFinite(Date.parse(expiresAt))
    ? { token, expires_at: expiresAt }
    : null;
}

/**
 * Decode a credential-store value without conflating an absent credential with
 * corrupt state. Callers must fail closed here: minting a replacement after a
 * parse/schema error would lose the only revocation metadata for the old token.
 */
export function parseCachedTokenCredential(raw: string | null): CachedToken | null {
  if (raw === null) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(
      'Canvas token cache contains invalid JSON; refusing to create a replacement token',
    );
  }

  const cached = parseCachedToken(decoded);
  if (!cached) {
    throw new Error(
      'Canvas token cache has a corrupt or unsupported schema; refusing to create a replacement token',
    );
  }
  return cached;
}

export function isCachedTokenUsable(value: CachedToken, nowMs = Date.now()): value is CachedTokenV2 {
  if (!isCachedTokenV2(value)) return false;
  const expiresAtMs = Date.parse(value.expires_at);
  return Number.isFinite(expiresAtMs) && expiresAtMs > nowMs + CANVAS_TOKEN_VALIDITY_BUFFER_MS;
}

export function canAdoptCachedToken(
  value: CachedToken,
  rejectedToken?: string,
  nowMs = Date.now(),
): value is CachedTokenV2 {
  return isCachedTokenUsable(value, nowMs) &&
    (rejectedToken === undefined || value.token !== rejectedToken);
}

export function sameCachedTokenGeneration(
  left: CachedToken | null,
  right: CachedToken | null,
): boolean {
  if (!left || !right) return left === right;
  if (isCachedTokenV2(left) && isCachedTokenV2(right)) {
    return left.id === right.id && left.token === right.token;
  }
  if (isCachedTokenV2(left) || isCachedTokenV2(right)) return false;
  return left.token === right.token;
}

export function sameCachedTokenSnapshot(
  left: CachedToken | null,
  right: CachedToken | null,
): boolean {
  if (!sameCachedTokenGeneration(left, right)) return false;
  if (!left || !right) return true;
  if (!isCachedTokenV2(left) || !isCachedTokenV2(right)) {
    return !isCachedTokenV2(left) &&
      !isCachedTokenV2(right) &&
      left.expires_at === right.expires_at;
  }
  return left.token_hint === right.token_hint &&
    left.issued_at === right.issued_at &&
    left.expires_at === right.expires_at &&
    left.pending_revocations.length === right.pending_revocations.length &&
    left.pending_revocations.every((entry, index) => {
      const other = right.pending_revocations[index];
      return entry.id === other?.id && entry.token_hint === other?.token_hint;
    });
}

function normalizeRevocation(value: unknown): CachedTokenRevocation | null {
  if (!isRecord(value)) return null;
  const id = normalizeId(value.id);
  if (id) return { id };
  const tokenHint = nonEmptyString(value.token_hint);
  return tokenHint?.length === 5 ? { token_hint: tokenHint } : null;
}

function revocationKey(value: CachedTokenRevocation): string {
  return value.id ? `id:${value.id}` : `hint:${value.token_hint ?? ''}`;
}

export function revocationForCachedToken(cached: CachedToken): CachedTokenRevocation {
  if (isCachedTokenV2(cached)) return { id: cached.id };
  return { token_hint: deriveCanvasTokenHint(cached.token) };
}

export function revocationForCreatedToken(
  candidate: CreatedCanvasTokenCandidate,
): CachedTokenRevocation {
  return candidate.id
    ? { id: candidate.id }
    : { token_hint: deriveCanvasTokenHint(candidate.token) };
}

export function normalizePendingRevocations(
  values: readonly CachedTokenRevocation[],
  currentToken?: CachedTokenRevocation,
): CachedTokenRevocation[] {
  const currentKeys = currentToken
    ? new Set([
      currentToken.id ? `id:${currentToken.id}` : null,
      currentToken.token_hint ? `hint:${currentToken.token_hint}` : null,
    ].filter((key): key is string => key !== null))
    : null;
  const seen = new Set<string>();
  const normalized: CachedTokenRevocation[] = [];
  for (const value of values) {
    const entry = normalizeRevocation(value);
    if (!entry) continue;
    const key = revocationKey(entry);
    if (currentKeys?.has(key) || seen.has(key)) continue;
    seen.add(key);
    normalized.push(entry);
  }
  return normalized;
}

export function pendingRevocationsForRotation(
  previous: CachedToken | null,
  currentToken: Pick<CachedTokenV2, 'id' | 'token_hint'>,
): CachedTokenRevocation[] {
  if (!previous) return [];
  const existing = isCachedTokenV2(previous) ? previous.pending_revocations : [];
  return normalizePendingRevocations(
    [...existing, revocationForCachedToken(previous)],
    currentToken,
  );
}

export function withPendingCanvasTokenRevocation(
  cached: CachedTokenV2,
  revocation: CachedTokenRevocation,
): CachedTokenV2 {
  return {
    ...cached,
    pending_revocations: normalizePendingRevocations(
      [...cached.pending_revocations, revocation],
      cached,
    ),
  };
}

export function revocationIdentifier(value: CachedTokenRevocation): string | null {
  return normalizeId(value.id) ?? nonEmptyString(value.token_hint);
}

export async function revokeCanvasToken(
  authToken: string,
  revocation: CachedTokenRevocation,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const identifier = revocationIdentifier(revocation);
  if (!identifier) return false;
  const url = new URL(
    `/api/v1/users/self/tokens/${encodeURIComponent(identifier)}`,
    CANVAS_BASE_URL,
  );

  try {
    const response = await fetchImpl(url, {
      method: 'DELETE',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${authToken}`,
        Accept: CANVAS_JSON_ACCEPT,
      },
    });
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}

export async function retryPendingCanvasTokenRevocations(
  authToken: string,
  pending: readonly CachedTokenRevocation[],
  fetchImpl: typeof fetch = fetch,
): Promise<CachedTokenRevocation[]> {
  const remaining: CachedTokenRevocation[] = [];
  for (const revocation of normalizePendingRevocations(pending)) {
    if (!await revokeCanvasToken(authToken, revocation, fetchImpl)) {
      remaining.push(revocation);
    }
  }
  return remaining;
}
