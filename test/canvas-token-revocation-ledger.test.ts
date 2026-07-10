import test from 'node:test';
import assert from 'node:assert/strict';

import type { CanvasTokenLock } from '../src/canvas-token-lock.js';
import {
  CanvasTokenRevocationLedger,
  parseCanvasTokenRevocationLedgerCredential,
  type CanvasTokenRevocationLedgerCredentialStore,
} from '../src/canvas-token-revocation-ledger.js';
import type { CachedTokenV1, CachedTokenV2 } from '../src/types.js';

const lock: CanvasTokenLock = {
  bucketPath: '/test/owned-lock',
  assertOwned: async () => undefined,
  release: async () => undefined,
};

const activeToken: CachedTokenV2 = {
  version: 2,
  token: 'active-secret',
  id: 'active-id',
  token_hint: 'activ',
  issued_at: '2026-01-01T00:00:00.000Z',
  expires_at: '2026-04-01T00:00:00.000Z',
  pending_revocations: [],
};

class MemoryCredentialStore implements CanvasTokenRevocationLedgerCredentialStore {
  value: string | null;
  getFailure: Error | null = null;
  setFailure: 'before' | 'after' | null = null;
  deleteFailure: 'before' | 'after' | null = null;

  constructor(value: string | null = null) {
    this.value = value;
  }

  async get(): Promise<string | null> {
    if (this.getFailure) throw this.getFailure;
    return this.value;
  }

  async set(_service: string, _account: string, value: string): Promise<void> {
    if (this.setFailure === 'before') throw new Error('secure set unavailable');
    this.value = value;
    if (this.setFailure === 'after') throw new Error('secure set post-write failure');
  }

  async delete(): Promise<void> {
    if (this.deleteFailure === 'before') throw new Error('secure delete unavailable');
    this.value = null;
    if (this.deleteFailure === 'after') throw new Error('secure delete post-write failure');
  }
}

function readStored(store: MemoryCredentialStore) {
  return parseCanvasTokenRevocationLedgerCredential(store.value).pending_revocations;
}

test('initial issuance can durably retain failed compensation without an active cache', async () => {
  const store = new MemoryCredentialStore();
  const ledger = new CanvasTokenRevocationLedger('initial-user', store);

  assert.deepEqual(await ledger.append(lock, { id: 'initial-issued-id' }, null), [
    { id: 'initial-issued-id' },
  ]);
  assert.deepEqual(readStored(store), [{ id: 'initial-issued-id' }]);
});

test('legacy V1 migration retains an exact failed-compensation id independently', async () => {
  const store = new MemoryCredentialStore();
  const ledger = new CanvasTokenRevocationLedger('legacy-user', store);
  const legacy: CachedTokenV1 = {
    token: 'legacy-secret',
    expires_at: '2099-01-01T00:00:00.000Z',
  };

  await ledger.append(lock, { id: 'newly-issued-id' }, legacy);
  assert.deepEqual(readStored(store), [{ id: 'newly-issued-id' }]);

  // A hint matching even a legacy active token is never queued for later
  // bearer-authenticated deletion, because that could self-revoke the cache.
  await ledger.append(lock, { token_hint: 'legac' }, legacy);
  assert.deepEqual(readStored(store), [{ id: 'newly-issued-id' }]);
});

test('retry merges and deduplicates ledger/cache work, excludes active token, and clears', async () => {
  const store = new MemoryCredentialStore(JSON.stringify({
    version: 1,
    pending_revocations: [
      { id: 'ledger-id' },
      { id: 'duplicate-id' },
      { id: 'active-id' },
      { token_hint: 'activ' },
    ],
  }));
  const ledger = new CanvasTokenRevocationLedger('merge-user', store);
  const calls: string[] = [];
  const fakeFetch = (async (input: string | URL | Request) => {
    calls.push(decodeURIComponent(new URL(String(input)).pathname.split('/').at(-1) ?? ''));
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  const remaining = await ledger.retry(
    lock,
    activeToken,
    [{ id: 'cache-id' }, { id: 'duplicate-id' }],
    fakeFetch,
  );

  assert.deepEqual(remaining, []);
  assert.deepEqual(calls, ['ledger-id', 'duplicate-id', 'cache-id']);
  assert.equal(store.value, null, 'a fully drained ledger is deleted');
});

test('retry durably carries network failures before token-cache compaction', async () => {
  const store = new MemoryCredentialStore(JSON.stringify({
    version: 1,
    pending_revocations: [{ id: 'ledger-failure' }],
  }));
  const ledger = new CanvasTokenRevocationLedger('failure-user', store);
  const fakeFetch = (async (input: string | URL | Request) => {
    const id = decodeURIComponent(new URL(String(input)).pathname.split('/').at(-1) ?? '');
    return new Response(null, { status: id === 'cache-success' ? 404 : 503 });
  }) as typeof fetch;

  assert.deepEqual(
    await ledger.retry(lock, activeToken, [{ id: 'cache-success' }], fakeFetch),
    [{ id: 'ledger-failure' }],
  );
  assert.deepEqual(readStored(store), [{ id: 'ledger-failure' }]);
});

test('backend and corrupt-ledger reads fail closed without exposing stored values', async () => {
  const backendFailure = new MemoryCredentialStore();
  backendFailure.getFailure = new Error('keychain unavailable');
  await assert.rejects(
    () => new CanvasTokenRevocationLedger('backend-user', backendFailure).read(lock),
    /keychain unavailable/,
  );

  const corrupt = new MemoryCredentialStore('{"version":1,"pending_revocations":[{"bad":"secret"}]}');
  await assert.rejects(
    () => new CanvasTokenRevocationLedger('corrupt-user', corrupt).read(lock),
    (err: Error) => {
      assert.match(err.message, /corrupt or unsupported schema/);
      assert.doesNotMatch(err.message, /secret/);
      return true;
    },
  );
});

test('the production ledger refuses the plaintext credential backend', async () => {
  const previous = process.env.ECLASS_CREDENTIAL_BACKEND;
  process.env.ECLASS_CREDENTIAL_BACKEND = 'file';
  try {
    await assert.rejects(
      () => new CanvasTokenRevocationLedger('plaintext-user').read(lock),
      /requires a secure credential backend/,
    );
  } finally {
    if (previous === undefined) delete process.env.ECLASS_CREDENTIAL_BACKEND;
    else process.env.ECLASS_CREDENTIAL_BACKEND = previous;
  }
});

test('failed ledger writes do not pretend compensation metadata was retained', async () => {
  const store = new MemoryCredentialStore();
  store.setFailure = 'before';
  const ledger = new CanvasTokenRevocationLedger('write-failure-user', store);
  await assert.rejects(
    () => ledger.append(lock, { id: 'must-retain' }, null),
    /secure set unavailable/,
  );
  assert.equal(store.value, null);
});

test('post-write and post-delete backend errors are resolved by crash-safe readback', async () => {
  const store = new MemoryCredentialStore();
  store.setFailure = 'after';
  const ledger = new CanvasTokenRevocationLedger('ambiguous-user', store);
  await ledger.append(lock, { id: 'ambiguous-id' }, null);
  assert.deepEqual(readStored(store), [{ id: 'ambiguous-id' }]);

  store.setFailure = null;
  store.deleteFailure = 'after';
  const fakeFetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
  assert.deepEqual(await ledger.retry(lock, activeToken, [], fakeFetch), []);
  assert.equal(store.value, null);
});
