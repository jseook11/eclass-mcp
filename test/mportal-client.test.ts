import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSyllabusSearch } from '../src/mportal-client.ts';

test('normalizeSyllabusSearch maps selectList rows and splits college/department', () => {
  const body = { result: [{
    year: '2026', shtm: '1', campcd: '1', sbjtno1: '15841', clssno1: '01',
    sbjtno: '15841-01', kornm: '운영체제', sust: '3B510',
    colgnm: '소프트웨어대학<br>소프트웨어학부', corscd: '0', shtnm: '전필',
    profnm: '박재현', ltbdrm: '310관 728호 <강의실>월3,4 / 금3', fileusefg: null,
  }], msgCode: 'success' };
  const items = normalizeSyllabusSearch(body);
  assert.equal(items.length, 1);
  assert.equal(items[0].course_code, '15841');
  assert.equal(items[0].section, '01');
  assert.equal(items[0].college, '소프트웨어대학');
  assert.equal(items[0].department, '소프트웨어학부');
  assert.equal(items[0].has_file, false);
});
