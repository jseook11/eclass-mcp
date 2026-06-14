import test from 'node:test';
import assert from 'node:assert/strict';

import {
  registerHandoff,
  getHandoff,
  pruneHandoffs,
  clearHandoffs,
} from '../src/file-handoff-registry.js';

test('registerHandoff returns an opaque token resolvable via getHandoff', () => {
  clearHandoffs();
  const token = registerHandoff(
    { localPath: '/d/a.pdf', displayName: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 3 },
    { now: 1000, ttlMs: 5000 },
  );
  assert.ok(token.length > 0);
  const entry = getHandoff(token, 2000);
  assert.equal(entry?.localPath, '/d/a.pdf');
  assert.equal(entry?.displayName, 'a.pdf');
});

test('getHandoff returns undefined past the TTL and evicts the entry', () => {
  clearHandoffs();
  const token = registerHandoff(
    { localPath: '/d/a.pdf', displayName: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 3 },
    { now: 1000, ttlMs: 5000 },
  );
  assert.equal(getHandoff(token, 6001), undefined);
  // A second lookup still undefined (evicted), even at a valid time.
  assert.equal(getHandoff(token, 2000), undefined);
});

test('tokens are unique across registrations', () => {
  clearHandoffs();
  const t1 = registerHandoff({ localPath: '/a', displayName: 'a', mimeType: 'x', sizeBytes: 1 });
  const t2 = registerHandoff({ localPath: '/b', displayName: 'b', mimeType: 'x', sizeBytes: 1 });
  assert.notEqual(t1, t2);
});

test('pruneHandoffs drops only expired entries', () => {
  clearHandoffs();
  const fresh = registerHandoff({ localPath: '/a', displayName: 'a', mimeType: 'x', sizeBytes: 1 }, { now: 1000, ttlMs: 10000 });
  const stale = registerHandoff({ localPath: '/b', displayName: 'b', mimeType: 'x', sizeBytes: 1 }, { now: 1000, ttlMs: 100 });
  pruneHandoffs(2000);
  assert.ok(getHandoff(fresh, 2000));
  assert.equal(getHandoff(stale, 2000), undefined);
});
