import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeFileName } from '../src/utils.js';

test('sanitizeFileName preserves Korean filenames', () => {
  assert.equal(sanitizeFileName('확률통계 3주차.pdf'), '확률통계 3주차.pdf');
  assert.equal(sanitizeFileName('일반물리(1) 기말과제.pdf'), '일반물리_1_ 기말과제.pdf');
});

test('sanitizeFileName keeps distinct Korean names distinct (no overwrite collision)', () => {
  const a = sanitizeFileName('확률통계.pdf');
  const b = sanitizeFileName('선형대수.pdf');
  assert.ok(a && b);
  assert.notEqual(a, b);
});

test('sanitizeFileName blocks path traversal and empty names', () => {
  assert.equal(sanitizeFileName('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFileName('..'), null);
  assert.equal(sanitizeFileName(''), null);
  assert.equal(sanitizeFileName('a/b/c.txt'), 'c.txt');
});

test('sanitizeFileName replaces unsafe characters', () => {
  assert.equal(sanitizeFileName('a<b>:c?.pdf'), 'a_b__c_.pdf');
});
