import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CANVAS_JSON_ACCEPT,
  CANVAS_TOKEN_PURPOSE_PREFIX,
  canAdoptCachedToken,
  createCanvasTokenPurpose,
  createCachedTokenV2,
  deriveCanvasTokenHint,
  extractCreatedCanvasTokenCandidate,
  extractCreatedCanvasTokenRevocation,
  isCachedTokenUsable,
  normalizePendingRevocations,
  parseCachedToken,
  parseCachedTokenCredential,
  pendingRevocationsForRotation,
  retryPendingCanvasTokenRevocations,
  revokeCanvasToken,
  revocationForCachedToken,
  revocationForCreatedCanvasTokenCompensation,
  sameCachedTokenGeneration,
  sameCachedTokenSnapshot,
  selectCanvasTokenForRecovery,
  withPendingCanvasTokenRevocation,
} from '../src/canvas-token-lifecycle.js';
import type { CachedTokenV2 } from '../src/types.js';

const issuedAt = '2026-01-01T00:00:00.000Z';
const requestedExpiresAt = '2026-04-01T00:00:00.000Z';

test('token creation purposes are unique correlations under Canvas limits', () => {
  const first = createCanvasTokenPurpose();
  const second = createCanvasTokenPurpose();
  assert.ok(first.startsWith(CANVAS_TOKEN_PURPOSE_PREFIX));
  assert.ok(second.startsWith(CANVAS_TOKEN_PURPOSE_PREFIX));
  assert.notEqual(first, second);
  assert.ok(first.length <= 255);
  assert.ok(second.length <= 255);
});

test('ambiguous-create recovery selects only one exact correlated active token', () => {
  const criteria = {
    purpose: 'eclass-mcp:exact-correlation',
    request_started_at: issuedAt,
    requested_expires_at: requestedExpiresAt,
    observed_at: '2026-01-01T00:01:00.000Z',
  };
  assert.deepEqual(
    selectCanvasTokenForRecovery([
      {
        id: 'broad-match-must-not-delete',
        purpose: 'eclass-mcp',
        created_at: issuedAt,
        expires_at: requestedExpiresAt,
        workflow_state: 'active',
      },
      {
        id: 'recovered-id',
        token_hint: 'recov',
        purpose: criteria.purpose,
        created_at: '2026-01-01T00:00:01.000Z',
        expires_at: '2026-03-31T23:59:59.000Z',
        workflow_state: 'active',
      },
      {
        id: 'inactive-match',
        purpose: criteria.purpose,
        created_at: issuedAt,
        expires_at: requestedExpiresAt,
        workflow_state: 'deleted',
      },
    ], criteria),
    { kind: 'found', revocation: { id: 'recovered-id' } },
  );
});

test('ambiguous-create recovery distinguishes no match, ambiguity, and invalid metadata', () => {
  const criteria = {
    purpose: 'eclass-mcp:exact-correlation',
    request_started_at: issuedAt,
    requested_expires_at: requestedExpiresAt,
    observed_at: '2026-01-01T00:01:00.000Z',
  };
  const token = (id?: string) => ({
    ...(id ? { id } : {}),
    purpose: criteria.purpose,
    created_at: '2026-01-01T00:00:01.000Z',
    expires_at: '2026-03-31T23:59:59.000Z',
    workflow_state: 'active',
  });

  assert.deepEqual(selectCanvasTokenForRecovery([], criteria), { kind: 'none' });
  assert.deepEqual(
    selectCanvasTokenForRecovery([{
      ...token('outside-window'),
      created_at: '2025-12-31T23:50:00.000Z',
    }], criteria),
    { kind: 'none' },
  );
  assert.deepEqual(
    selectCanvasTokenForRecovery([{
      ...token('overlong-expiry'),
      expires_at: '2026-04-01T00:00:00.001Z',
    }], criteria),
    { kind: 'none' },
  );
  assert.deepEqual(
    selectCanvasTokenForRecovery([token('first-id'), token('second-id')], criteria),
    { kind: 'ambiguous' },
  );
  assert.deepEqual(selectCanvasTokenForRecovery([token()], criteria), { kind: 'invalid' });
  assert.deepEqual(selectCanvasTokenForRecovery({ tokens: [token('id')] }, criteria), {
    kind: 'invalid',
  });
});

test('extracts visible_token first and normalizes numeric ids', () => {
  const candidate = extractCreatedCanvasTokenCandidate({
    visible_token: ' visible-secret ',
    token: 'fallback-secret',
    id: 42,
    expires_at: '2026-03-31T23:00:00.000Z',
  });

  assert.deepEqual(candidate, {
    token: 'visible-secret',
    id: '42',
    expires_at: '2026-03-31T23:00:00.000Z',
  });
});

test('accepts token fallback and preserves the actual Canvas expiry', () => {
  const candidate = extractCreatedCanvasTokenCandidate({
    token: 'fallback-secret',
    id: 'token-id',
    expires_at: '2026-03-31T23:59:59.000Z',
  });
  assert.ok(candidate);

  const cached = createCachedTokenV2(candidate, issuedAt, requestedExpiresAt);
  assert.equal(cached.version, 2);
  assert.equal(cached.expires_at, '2026-03-31T23:59:59.000Z');
  assert.equal(cached.issued_at, issuedAt);
  assert.equal(cached.id, 'token-id');
  assert.equal(cached.token_hint, 'fallb');
});

test('extracts a compensation revocation id without a visible token', () => {
  assert.deepEqual(
    extractCreatedCanvasTokenRevocation({ id: 314, expires_at: null }),
    { id: '314' },
  );
});

test('a same-origin non-2xx creation body with an id is still compensated', () => {
  assert.deepEqual(
    revocationForCreatedCanvasTokenCompensation({
      ok: false,
      responseUrl: 'https://eclass3.cau.ac.kr/api/v1/users/self/tokens',
      body: { id: 'issued-despite-error' },
    }, false),
    { id: 'issued-despite-error' },
  );
  assert.equal(
    revocationForCreatedCanvasTokenCompensation({
      ok: false,
      responseUrl: 'https://attacker.example/api/v1/users/self/tokens',
      body: { id: 'untrusted-id' },
    }, false),
    null,
  );
  assert.equal(
    revocationForCreatedCanvasTokenCompensation({
      ok: false,
      responseUrl: 'https://eclass3.cau.ac.kr/api/v1/users/self/tokens',
      body: { id: 'active-persisted-id' },
    }, true),
    null,
    'a durably persisted active token must never be compensation-revoked',
  );
});

test('rejects null server expiry', () => {
  const candidate = extractCreatedCanvasTokenCandidate({
    visible_token: 'secret',
    id: '12',
    expires_at: null,
  });
  assert.ok(candidate);
  assert.throws(
    () => createCachedTokenV2(candidate, issuedAt, requestedExpiresAt),
    /did not include expires_at/,
  );
});

test('rejects an expiry later than the requested 90-day server lifetime', () => {
  const candidate = extractCreatedCanvasTokenCandidate({
    visible_token: 'secret',
    id: '12',
    expires_at: '2026-04-01T00:00:00.001Z',
  });
  assert.ok(candidate);
  assert.throws(
    () => createCachedTokenV2(candidate, issuedAt, requestedExpiresAt),
    /exceeds the requested 90-day lifetime/,
  );
});

test('legacy V1 caches always force rotation even with a future expiry', () => {
  const legacy = parseCachedToken({
    token: 'legacy-token',
    expires_at: '2099-01-01T00:00:00.000Z',
  });
  assert.ok(legacy);
  assert.equal(isCachedTokenUsable(legacy, Date.parse(issuedAt)), false);
  assert.deepEqual(revocationForCachedToken(legacy), { token_hint: 'legac' });
});

test('credential decoding returns null only for a truly missing token', () => {
  assert.equal(parseCachedTokenCredential(null), null);
  assert.throws(
    () => parseCachedTokenCredential(''),
    /invalid JSON; refusing to create a replacement token/,
  );
  assert.throws(
    () => parseCachedTokenCredential('{"unexpected":true}'),
    /corrupt or unsupported schema; refusing to create a replacement token/,
  );
});

test('credential decoding accepts legacy V1 but rejects malformed versioned caches', () => {
  assert.deepEqual(
    parseCachedTokenCredential(JSON.stringify({
      token: 'legacy-token',
      expires_at: '2099-01-01T00:00:00.000Z',
    })),
    { token: 'legacy-token', expires_at: '2099-01-01T00:00:00.000Z' },
  );

  assert.throws(
    () => parseCachedTokenCredential(JSON.stringify({
      version: 2,
      token: 'secret-that-must-not-be-downgraded',
      expires_at: '2099-01-01T00:00:00.000Z',
    })),
    /corrupt or unsupported schema/,
  );
  assert.throws(
    () => parseCachedTokenCredential('{"token":"tiny","expires_at":"not-a-date"}'),
    /corrupt or unsupported schema/,
  );
  assert.throws(
    () => parseCachedTokenCredential(JSON.stringify({
      version: 2,
      token: 'current-secret',
      id: '99',
      token_hint: 'curre',
      issued_at: issuedAt,
      expires_at: '2099-01-01T00:00:00.000Z',
      pending_revocations: [],
    })),
    /corrupt or unsupported schema/,
  );
});

test('a complete unexpired V2 cache is usable', () => {
  const cached = parseCachedToken({
    version: 2,
    token: 'current-secret',
    id: '99',
    token_hint: 'curre',
    issued_at: issuedAt,
    expires_at: requestedExpiresAt,
    pending_revocations: [{ id: '12' }],
  });
  assert.ok(cached);
  assert.equal(isCachedTokenUsable(cached, Date.parse(issuedAt)), true);
});

test('401 reconciliation adopts only a different usable cached token', () => {
  const cached = parseCachedToken({
    version: 2,
    token: 'current-secret',
    id: '99',
    token_hint: 'curre',
    issued_at: issuedAt,
    expires_at: requestedExpiresAt,
    pending_revocations: [],
  });
  assert.ok(cached);
  assert.equal(canAdoptCachedToken(cached, 'rejected-secret', Date.parse(issuedAt)), true);
  assert.equal(canAdoptCachedToken(cached, 'current-secret', Date.parse(issuedAt)), false);
});

test('cache CAS distinguishes generations and pending-queue snapshots', () => {
  const base: CachedTokenV2 = {
    version: 2,
    token: 'current-secret',
    id: '99',
    token_hint: 'curre',
    issued_at: issuedAt,
    expires_at: requestedExpiresAt,
    pending_revocations: [{ id: 'old-id' }],
  };
  const compacted: CachedTokenV2 = { ...base, pending_revocations: [] };
  const newer: CachedTokenV2 = {
    ...base,
    token: 'newer-secret',
    id: '100',
    token_hint: 'newer',
  };

  assert.equal(sameCachedTokenGeneration(base, compacted), true);
  assert.equal(sameCachedTokenSnapshot(base, compacted), false);
  assert.equal(sameCachedTokenGeneration(base, newer), false);
  assert.equal(sameCachedTokenSnapshot(base, newer), false);
});

test('a failed loser-token compensation is retained on the winning generation', () => {
  const winner: CachedTokenV2 = {
    version: 2,
    token: 'winner-secret',
    id: 'winner-id',
    token_hint: 'winne',
    issued_at: issuedAt,
    expires_at: requestedExpiresAt,
    pending_revocations: [{ id: 'older-id' }],
  };
  const updated = withPendingCanvasTokenRevocation(winner, { id: 'loser-id' });
  assert.deepEqual(updated.pending_revocations, [{ id: 'older-id' }, { id: 'loser-id' }]);
  assert.equal(sameCachedTokenGeneration(updated, winner), true);
  assert.equal(sameCachedTokenSnapshot(updated, winner), false);
});

test('ordinary failed compensation survives the next proactive rotation', () => {
  const previous: CachedTokenV2 = {
    version: 2,
    token: 'expired-secret',
    id: 'expired-id',
    token_hint: 'expir',
    issued_at: issuedAt,
    expires_at: requestedExpiresAt,
    pending_revocations: [{ id: 'older-id' }],
  };
  const retained = withPendingCanvasTokenRevocation(previous, { id: 'failed-create-id' });
  assert.deepEqual(
    pendingRevocationsForRotation(retained, { id: 'next-id', token_hint: 'next-' }),
    [{ id: 'older-id' }, { id: 'failed-create-id' }, { id: 'expired-id' }],
  );
});

test('rotation carries old pending work and queues the exact old V2 id', () => {
  const previous: CachedTokenV2 = {
    version: 2,
    token: 'old-secret',
    id: 'old-id',
    token_hint: 'old-s',
    issued_at: issuedAt,
    expires_at: requestedExpiresAt,
    pending_revocations: [{ id: 'older-id' }, { id: 'older-id' }],
  };

  assert.deepEqual(
    pendingRevocationsForRotation(previous, { id: 'new-id', token_hint: 'new-s' }),
    [{ id: 'older-id' }, { id: 'old-id' }],
  );
});

test('normalization excludes the active token and deduplicates targets', () => {
  assert.deepEqual(
    normalizePendingRevocations(
      [
        { id: 'current-id' },
        { token_hint: 'curre' },
        { id: 'old-id' },
        { id: 'old-id' },
      ],
      { id: 'current-id', token_hint: 'curre' },
    ),
    [{ id: 'old-id' }],
  );
});

test('revoke uses the exact id, string-id Accept header, and treats 404 as success', async () => {
  const calls: Array<{ url: string; method: string | undefined; accept: string | null }> = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method,
      accept: new Headers(init?.headers).get('Accept'),
    });
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  assert.equal(await revokeCanvasToken('auth-secret', { id: 'old/id' }, fakeFetch), true);
  assert.deepEqual(calls, [{
    url: 'https://eclass3.cau.ac.kr/api/v1/users/self/tokens/old%2Fid',
    method: 'DELETE',
    accept: CANVAS_JSON_ACCEPT,
  }]);
});

test('pending retry removes 204/404 results and retains failures', async () => {
  const statuses = [204, 404, 500];
  const fakeFetch = (async () => new Response(null, { status: statuses.shift() })) as typeof fetch;

  const remaining = await retryPendingCanvasTokenRevocations(
    'auth-secret',
    [{ id: 'one' }, { token_hint: 'two22' }, { id: 'three' }],
    fakeFetch,
  );
  assert.deepEqual(remaining, [{ id: 'three' }]);
});

test('five-character hints are deterministic for legacy revocation', () => {
  assert.equal(deriveCanvasTokenHint('abcdefghi'), 'abcde');
});
