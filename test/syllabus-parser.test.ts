import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseSyllabusText } from '../src/tools/syllabus/syllabus-parser.ts';

// plain(reading-order) + layout(-layout) 두 텍스트를 모두 읽어 파싱한다.
function loadDoc(slug: string) {
  const base = (ext: string) =>
    fileURLToPath(new URL(`./fixtures/syllabus-${slug}.${ext}`, import.meta.url));
  const plain = readFileSync(base('txt'), 'utf8');
  const layout = readFileSync(base('layout.txt'), 'utf8');
  return parseSyllabusText(plain, layout);
}

// 값으로 라벨 문자열이 새지 않아야 한다(정직한 null 폴백 원칙).
function assertNoLabelLeak(doc: ReturnType<typeof parseSyllabusText>) {
  const labels = ['분반번호', '공학인증 여부', '개설대학', 'Instruction)', '소속', '학과전화번호'];
  for (const v of Object.values(doc.basic)) {
    if (typeof v === 'string') assert.ok(!labels.includes(v), `basic leaked label: ${v}`);
  }
}

test('운영체제(15841): assessment / basic / instructor / schedule / textbook', () => {
  const doc = loadDoc('15841-01');

  const byItem = Object.fromEntries(doc.assessment.map((a) => [a.item, a.ratio]));
  assert.equal(byItem['출결'], 10);
  assert.equal(byItem['중간시험'], 45);
  assert.equal(byItem['기말시험'], 45);

  assert.equal(doc.basic.course_code, '15841');
  assert.equal(doc.basic.section, '01');
  assert.equal(doc.basic.credit, '3');
  assert.match(doc.basic.title_ko ?? '', /운영체제/);
  assert.equal(doc.basic.campus, '서울');
  assert.equal(doc.basic.medium, null);
  assertNoLabelLeak(doc);

  assert.equal(doc.instructor.email, 'instructor1@cau.ac.kr');
  assert.match(doc.instructor.name ?? '', /홍철호/);
  assert.match(doc.instructor.homepage ?? '', /sites\.google\.com/);

  // 16주 전체가 잡히고 topic이 다음 페이지 헤더로 오염되지 않는다(week16 = Final).
  assert.equal(doc.schedule.length, 16);
  assert.match(doc.schedule.find((s) => s.week === 1)?.topic ?? '', /Introduction/);
  assert.match(doc.schedule.find((s) => s.week === 8)?.topic ?? '', /Midterm/i);
  assert.match(doc.schedule.find((s) => s.week === 16)?.topic ?? '', /Final/i);

  const main = doc.textbooks.find((t) => t.kind === '주교재');
  assert.ok(main, 'main textbook present');
  assert.match(main!.title ?? '', /Operating Systems/);
  assert.match(main!.author ?? '', /Arpaci-Dusseau/);
  assert.match(doc.objectives.description ?? '', /operating systems/i);
});

test('미적분학(47715): 한글 단일행 강사명 + 다중 교재 + scalar 누출 차단', () => {
  const doc = loadDoc('47715-01');

  // 교수명 라벨 값 경로(운영체제와 달리 라벨 직후에 이름이 온다).
  assert.match(doc.instructor.name ?? '', /남궁정일/);
  // 빈 셀이면 라벨/페이지번호가 새지 않고 null이어야 한다.
  assert.equal(doc.instructor.office_phone, null); // "소속" 누출 금지
  assert.equal(doc.instructor.homepage, null); // "1/4" 페이지번호 누출 금지
  assertNoLabelLeak(doc);

  // 주교재 + 참고도서 2권.
  assert.equal(doc.textbooks.length, 2);
  const main = doc.textbooks.find((t) => t.kind === '주교재');
  assert.match(main?.title ?? '', /미분적분학/);
  assert.match(main?.author ?? '', /Stewart/);
  const ref = doc.textbooks.find((t) => t.kind === '참고도서');
  assert.match(ref?.title ?? '', /상황 속의 미적분학/);

  // 주차 topic이 강사명/다음 주차번호/학습과제 열로 어긋나지 않는다.
  assert.equal(doc.schedule.length, 16);
  assert.match(doc.schedule.find((s) => s.week === 1)?.topic ?? '', /1장/);
  assert.match(doc.schedule.find((s) => s.week === 8)?.topic ?? '', /중간고사/);
  assert.match(doc.schedule.find((s) => s.week === 16)?.topic ?? '', /기말고사/);
});

test('경제학원론(35703): 한글 주차 topic + 단일 참고도서', () => {
  const doc = loadDoc('35703-01');

  assert.match(doc.instructor.name ?? '', /조상준/);
  assertNoLabelLeak(doc);

  // topic이 학습과제 열(잘린 "수요·")이 아니라 수업주제 열을 가리킨다.
  assert.equal(doc.schedule.length, 16);
  assert.match(doc.schedule.find((s) => s.week === 1)?.topic ?? '', /소비자 이론/);
  assert.match(doc.schedule.find((s) => s.week === 8)?.topic ?? '', /중간고사/);

  const book = doc.textbooks[0];
  assert.match(book?.title ?? '', /맨큐/);
  assert.match(book?.author ?? '', /Mankiw/);
});

test('layout 인자 생략 시 plain으로 폴백한다', () => {
  const plain = readFileSync(
    fileURLToPath(new URL('./fixtures/syllabus-15841-01.txt', import.meta.url)),
    'utf8',
  );
  const doc = parseSyllabusText(plain);
  // plain만으로도 scalar는 추출되고 raw_text는 plain이 된다.
  assert.equal(doc.basic.course_code, '15841');
  assert.equal(doc.raw_text, plain);
});
