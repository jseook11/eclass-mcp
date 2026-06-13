import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

import { ExamCache, type CourseMetadataRecord } from '../src/exam-cache.js';
import { parseCseNoticeHtml, parseGeNoticeHtml, selectSourcesForCourse, BUILTIN_EXAM_SOURCES } from '../src/tools/exams/notice-sources.js';
import { parseExamScheduleTsv } from '../src/tools/exams/pdf-parser.js';
import { normalizeSisCourseInfo, parseSisSourceId } from '../src/learningx-client.js';
import { syncCourseMetadata, parseCanvasAccountName } from '../src/tools/exams/course-metadata.js';
import { getExamSchedule } from '../src/tools/exams/get-exam-schedule.js';
import type { CanvasClient } from '../src/canvas-client.js';

function word(page: number, left: number, top: number, text: string, width = 8): string {
  return `5\t${page}\t0\t0\t0\t0\t${left}\t${top}\t${width}\t5\t100\t${text}`;
}

function tsv(words: string[]): string {
  return [
    'level\tpage_num\tpar_num\tblock_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
    ...words,
  ].join('\n');
}

function withTempExamDb<T>(fn: (dbPath: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-cache-'));
  const dbPath = path.join(dir, 'exams.db');
  const prev = process.env.ECLASS_EXAM_DB_PATH;
  process.env.ECLASS_EXAM_DB_PATH = dbPath;
  try {
    return fn(dbPath);
  } finally {
    if (prev === undefined) delete process.env.ECLASS_EXAM_DB_PATH;
    else process.env.ECLASS_EXAM_DB_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function sampleMetadata(overrides: Partial<CourseMetadataRecord> = {}): CourseMetadataRecord {
  return {
    course_id: 10,
    course_name: '소프트웨어공학',
    term: '2026-1',
    canvas_course_code: '2026-1-11708-01',
    canvas_sis_course_id: '2026-10-11708-01',
    college: '소프트웨어대학',
    department: '소프트웨어학부',
    instructor: '이찬근',
    course_code: '11708',
    section: '01',
    source: 'learningx_sis',
    sis_error: null,
    fetched_at: '2026-06-13T00:00:00.000Z',
    ...overrides,
  };
}

function insertSampleSchedule(cache: ExamCache): number {
  const sourceId = cache.upsertExamSource({
    college: '소프트웨어대학',
    department: '소프트웨어학부',
    homepage_url: 'https://cse.cau.ac.kr/',
    notice_board_url: 'https://cse.cau.ac.kr/sub05/sub0501.php',
    adapter_type: 'cse_notice',
  });
  const documentId = cache.upsertExamDocument({
    term: '2026-1',
    exam_type: 'final',
    source_id: sourceId,
    notice_url: 'https://cse.cau.ac.kr/sub05/sub0501.php',
    title: '시험',
    posted_at: '2026-06-09',
    body_hash: 'body1',
    attachment_url: 'https://cse.cau.ac.kr/a.pdf',
    attachment_name: 'a.pdf',
    file_hash: 'file1',
    local_pdf_path: '/tmp/a.pdf',
    diff_status: 'new',
    fetched_at: '2026-06-13T00:00:00.000Z',
  });
  cache.replaceSchedules(documentId, [{
    term: '2026-1',
    exam_type: 'final',
    course_code: '11708',
    course_name: '소프트웨어공학',
    section: '01',
    lecture_time: '월7 / 수7,8',
    instructor: '이찬근',
    exam_method: '1. 대면시험',
    exam_date: '2026-06-17',
    start_time: '15:00',
    end_time: '16:40',
    building: '310',
    rooms: '727',
    note: null,
    raw_text: null,
  }, {
    term: '2026-1',
    exam_type: 'final',
    course_code: '40989',
    course_name: '자료구조',
    section: '03',
    lecture_time: null,
    instructor: '김범수',
    exam_method: '1. 대면시험',
    exam_date: '2026-06-18',
    start_time: '10:00',
    end_time: '11:40',
    building: '310',
    rooms: '512',
    note: null,
    raw_text: null,
  }, {
    // 교양대학 PDF row: course_code가 없고 이름은 분반 표기 없이 저장된다
    term: '2026-1',
    exam_type: 'final',
    course_code: null,
    course_name: '과학기술과현대사회',
    section: '02',
    lecture_time: '월1,2,3',
    instructor: '김광호',
    exam_method: '1.대면시험',
    exam_date: '2026-06-22',
    start_time: '10:00',
    end_time: '10:50',
    building: '310',
    rooms: 'B602',
    note: null,
    raw_text: null,
  }]);
  return documentId;
}

test('parseGeNoticeHtml extracts attachment metadata', () => {
  const html = `
    <p class="tit"><img /><strong>2026-1학기 서울캠퍼스 교양과목 기말시험 시간표 공지</strong></p>
    <li><strong>작성일</strong><span class="r">2026-06-04</span></li>
    <div class="view_file"><a href="download.php?filename=test.pdf&filepath=NOTICE"><b>교양 기말.pdf</b></a></div>
    <div class="view_con">변경사항(2026.6.12.) : 강의실 변경</div> <!-- // view_con -->
  `;
  const parsed = parseGeNoticeHtml(html, 'https://ge.cau.ac.kr/board_notice_view.php?no=1');
  assert.ok(parsed);
  assert.equal(parsed.title, '2026-1학기 서울캠퍼스 교양과목 기말시험 시간표 공지');
  assert.equal(parsed.posted_at, '2026-06-04');
  assert.equal(parsed.attachment_name, '교양 기말.pdf');
  assert.equal(parsed.attachment_url, 'https://ge.cau.ac.kr/download.php?filename=test.pdf&filepath=NOTICE');
  assert.match(parsed.body_text, /강의실 변경/);
});

test('parseCseNoticeHtml extracts goLocation download link', () => {
  const html = `
    <div class="header"><h3>2026-1학기 기말시험 시간표 안내</h3><div><span>2026-06-09</span></div></div>
    <div class="detail"><div class="files">
      <span onclick="goLocation('/_module/bbs/download.php','9280','oktomato_bbs05')">2026-1학기 소프트웨어대학 기말시험 시간표(공지용).pdf</span>
    </div></div>
  `;
  const parsed = parseCseNoticeHtml(html, 'https://cse.cau.ac.kr/sub05/sub0501.php?nmode=view&code=oktomato_bbs05&uid=3396');
  assert.ok(parsed);
  assert.equal(parsed.title, '2026-1학기 기말시험 시간표 안내');
  assert.equal(parsed.posted_at, '2026-06-09');
  assert.equal(parsed.attachment_url, 'https://cse.cau.ac.kr/_module/bbs/download.php?uid=9280&code=oktomato_bbs05');
});

test('parseExamScheduleTsv parses software-college rows', () => {
  const input = tsv([
    word(1, 188, 50, '2026-1학기', 40),
    word(1, 245, 50, '소프트웨어학부', 50),
    word(1, 31, 72, '교과목', 12),
    word(1, 33, 76, '코드', 8),
    word(1, 55, 72, '분반', 8),
    word(1, 99, 72, '교과목명', 20),
    word(1, 32, 90, '11708', 10),
    word(1, 58, 90, '01', 4),
    word(1, 94, 90, '소프트웨어공학', 30),
    word(1, 148, 90, '월7', 6),
    word(1, 156, 90, '/', 2),
    word(1, 160, 90, '수7,8', 10),
    word(1, 192, 90, '이찬근', 12),
    word(1, 225, 90, '40', 4),
    word(1, 247, 90, '1.', 4),
    word(1, 253, 90, '대면시험', 18),
    word(1, 288, 90, '2026-06-17', 24),
    word(1, 331, 90, '15:00', 12),
    word(1, 366, 90, '16:40', 12),
    word(1, 401, 90, '310', 8),
    word(1, 434, 90, '727', 8),
  ]);

  const result = parseExamScheduleTsv(input, { term: '2026-1', exam_type: 'final' });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.layout, 'software_college');
    assert.equal(result.schedules.length, 1);
    assert.equal(result.schedules[0].course_code, '11708');
    assert.equal(result.schedules[0].course_name, '소프트웨어공학');
    assert.equal(result.schedules[0].exam_date, '2026-06-17');
    assert.equal(result.schedules[0].rooms, '727');
  }
});

test('parseExamScheduleTsv parses general-education rows including online exams', () => {
  const input = tsv([
    word(1, 20, 17, '[서울캠퍼스]', 80),
    word(1, 104, 39, '교양대학', 40),
    word(1, 19, 66, '교과목명', 30),
    word(1, 162, 66, '분반', 14),
    word(1, 382, 66, '기말시험', 30),
    word(1, 419, 66, '유형', 14),
    word(1, 19, 110, '4차산업혁명과인재개발', 90),
    word(1, 166, 110, '01', 9),
    word(1, 220, 110, '월11', 18),
    word(1, 301, 110, '송해덕', 25),
    word(1, 367, 110, '2.', 7),
    word(1, 378, 110, '온라인(비대면)시험', 74),
    word(1, 491, 110, '2026-06-22', 44),
    word(1, 591, 110, '19:00', 21),
    word(1, 660, 110, '19:50', 21),
  ]);

  const result = parseExamScheduleTsv(input, { term: '2026-1', exam_type: 'final' });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.layout, 'general_education');
    assert.equal(result.schedules[0].course_name, '4차산업혁명과인재개발');
    assert.equal(result.schedules[0].section, '01');
    assert.equal(result.schedules[0].exam_method, '2. 온라인(비대면)시험');
    assert.equal(result.schedules[0].building, null);
  }
});

test('normalizeSisCourseInfo maps known field aliases', () => {
  const fixture = {
    data: {
      colg_nm: '소프트웨어대학',
      sust_nm: '소프트웨어학부',
      prof_nm: '이찬근',
      subj_no: '11708',
      class_no: '01',
      shtm_nm: '2026-1',
      sis_course_id: '2026-10-11708-01',
    },
  };
  const result = normalizeSisCourseInfo(fixture);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.info.college, '소프트웨어대학');
    assert.equal(result.info.department, '소프트웨어학부');
    assert.equal(result.info.instructor, '이찬근');
    assert.equal(result.info.course_code, '11708');
    assert.equal(result.info.section, '01');
    assert.equal(result.info.term, '2026-1');
    assert.equal(result.info.raw_sis_course_id, '2026-10-11708-01');
  }
});

test('normalizeSisCourseInfo parses live LearningX course response via sis_source_id', () => {
  // /learningx/api/v1/courses/{id} live 응답 형태 (2026-06-13 검증).
  // course_code가 표시명이므로 sis_source_id 구조 파싱이 우선해야 한다.
  const fixture = {
    id: 139260,
    name: '컴퓨터시스템및어셈블리언어 01분반',
    course_code: '컴퓨터시스템및어셈블리언어 01분반',
    sis_source_id: '2026_1_1_3B510_32734_01',
    enrollment_term_id: 93,
  };
  const result = normalizeSisCourseInfo(fixture);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.info.course_code, '32734');
    assert.equal(result.info.section, '01');
    assert.equal(result.info.term, '2026-1');
    assert.equal(result.info.raw_sis_course_id, '2026_1_1_3B510_32734_01');
    assert.equal(result.info.college, null);
    assert.equal(result.info.department, null);
  }
});

test('parseSisSourceId rejects non-structured ids', () => {
  assert.equal(parseSisSourceId('2026-10-11708-01'), null);
  assert.equal(parseSisSourceId('not_an_id'), null);
  assert.deepEqual(parseSisSourceId('2026_1_1_3B510_32734_01'), {
    term: '2026-1',
    campus_code: '1',
    department_code: '3B510',
    course_code: '32734',
    section: '01',
  });
});

test('normalizeSisCourseInfo rejects responses without course_code/section', () => {
  const result = normalizeSisCourseInfo({ status: 'ok', message: 'no course info here' });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.message, /course_code\/section/);
    assert.match(result.message, /status/);
  }
});

test('exam DB migrates v1 schema (confidence column) to current version', () => {
  withTempExamDb((dbPath) => {
    const v1 = new Database(dbPath);
    v1.exec(`
      CREATE TABLE course_metadata (
        course_id   INTEGER PRIMARY KEY,
        course_name TEXT NOT NULL,
        course_code TEXT,
        section     TEXT,
        instructor  TEXT,
        college     TEXT,
        department  TEXT,
        term        TEXT,
        source      TEXT NOT NULL,
        confidence  REAL NOT NULL,
        fetched_at  TEXT NOT NULL
      );
    `);
    v1.prepare(`
      INSERT INTO course_metadata (course_id, course_name, source, confidence, fetched_at)
      VALUES (1, '운영체제', 'canvas_course_metadata', 0.75, '2026-06-01T00:00:00.000Z')
    `).run();
    v1.close();

    const cache = new ExamCache();
    const db = cache.getDb();
    assert.equal(Number(db.pragma('user_version', { simple: true })), 3);
    const columns = (db.pragma('table_info(course_metadata)') as Array<{ name: string }>).map((c) => c.name);
    assert.ok(!columns.includes('confidence'));
    assert.ok(columns.includes('source'));
    assert.ok(columns.includes('sis_error'));
    assert.ok(columns.includes('canvas_course_code'));
    assert.ok(columns.includes('canvas_account_name'));
    // v1 행은 재생성으로 비워진다 (로컬 캐시라 유실 허용)
    assert.equal(cache.listCourseMetadata().length, 0);

    cache.upsertCourseMetadata([sampleMetadata()]);
    const stored = cache.getCourseMetadata(10);
    assert.ok(stored);
    assert.equal(stored.source, 'learningx_sis');
    assert.ok(!('confidence' in stored));

    // source CHECK 제약: 허용값 외에는 저장 불가
    assert.throws(() => {
      cache.upsertCourseMetadata([{ ...sampleMetadata(), course_id: 11, source: 'bogus' as never }]);
    });
    db.close();
  });
});

test('findSchedulesExact matches course_code + section only', () => {
  withTempExamDb(() => {
    const cache = new ExamCache();
    insertSampleSchedule(cache);

    const exact = cache.findSchedulesExact({
      course_code: '11708',
      section: '01',
      term: '2026-1',
      exam_type: 'final',
    });
    assert.equal(exact.length, 1);
    assert.equal(exact[0].course_name, '소프트웨어공학');
    assert.equal(exact[0].source_title, '시험');

    assert.equal(cache.findSchedulesExact({ course_code: '11708', section: '02' }).length, 0);
    assert.equal(cache.listSchedules({ term: '2026-1', exam_type: 'final' }).length, 3);
    cache.getDb().close();
  });
});

test('findSchedulesByNameSection matches normalized name + section', () => {
  withTempExamDb(() => {
    const cache = new ExamCache();
    insertSampleSchedule(cache);

    // metadata 이름은 "...02분반", PDF row 이름은 분반 표기 없음 → 정규화 후 일치
    const matched = cache.findSchedulesByNameSection({
      course_name: '과학기술과현대사회 02분반',
      section: '02',
      term: '2026-1',
      exam_type: 'final',
    });
    assert.equal(matched.length, 1);
    assert.equal(matched[0].course_name, '과학기술과현대사회');
    assert.equal(matched[0].rooms, 'B602');

    // section이 다르면 매칭 안 됨
    assert.equal(cache.findSchedulesByNameSection({
      course_name: '과학기술과현대사회',
      section: '01',
      term: '2026-1',
      exam_type: 'final',
    }).length, 0);

    // leading zero 차이는 무시 (section "2" == "02")
    assert.equal(cache.findSchedulesByNameSection({
      course_name: '과학기술과현대사회',
      section: '2',
      term: '2026-1',
      exam_type: 'final',
    }).length, 1);
    cache.getDb().close();
  });
});

test('getExamSchedule matches general-education course by name + section', async () => {
  await withTempExamDb(async () => {
    const cache = new ExamCache();
    // 교양과목: SIS로 course_code/section은 확정되지만 교양 PDF엔 course_code가 없다
    cache.upsertCourseMetadata([sampleMetadata({
      course_id: 30,
      course_name: '과학기술과현대사회 02분반',
      college: '교양대학',
      department: null,
      instructor: '김광호',
      course_code: '40647',
      section: '02',
      source: 'learningx_sis',
    })]);
    insertSampleSchedule(cache);

    const result = await getExamSchedule(cache, { course_id: 30, term: '2026-1' });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.matches.length, 1);
      assert.equal(result.matches[0].course_name, '과학기술과현대사회');
      assert.equal(result.matches[0].rooms, 'B602');
      assert.equal(result.matched_by, 'name_section');
    }
    cache.getDb().close();
  });
});

test('getExamSchedule returns exact match for confirmed course metadata', async () => {
  await withTempExamDb(async () => {
    const cache = new ExamCache();
    cache.upsertCourseMetadata([sampleMetadata()]);
    insertSampleSchedule(cache);

    const result = await getExamSchedule(cache, { course_id: 10, term: '2026-1' });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.matches.length, 1);
      assert.equal(result.matches[0].course_code, '11708');
      assert.equal(result.matches[0].section, '01');
    }
    cache.getDb().close();
  });
});

test('getExamSchedule returns full candidate list when exact match fails', async () => {
  await withTempExamDb(async () => {
    const cache = new ExamCache();
    // canvas_only: course_code/section 미확정 → exact match 불가
    cache.upsertCourseMetadata([sampleMetadata({
      course_id: 20,
      course_name: '일반물리(1) 03분반',
      college: null,
      department: null,
      instructor: null,
      course_code: null,
      section: null,
      source: 'canvas_only',
      sis_error: 'SIS_ENDPOINT_UNAVAILABLE: probe failed',
    })]);
    insertSampleSchedule(cache);

    const result = await getExamSchedule(cache, { course_id: 20, term: '2026-1' });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'EXACT_MATCH_NOT_FOUND');
      assert.equal(result.candidates.length, 3);
      assert.equal(result.course_metadata?.source, 'canvas_only');
      assert.equal(result.course_metadata?.sis_error, 'SIS_ENDPOINT_UNAVAILABLE: probe failed');
      // fuzzy matching 미사용: confidence 류 필드가 응답에 없어야 한다
      assert.ok(!('match_confidence' in (result.candidates[0] as object)));
    }
    cache.getDb().close();
  });
});

test('parseCanvasAccountName parses live account name formats', () => {
  // live 검증된 형태 (2026-06-13): "{단과대} {학부} [{전공}]"
  assert.deepEqual(parseCanvasAccountName('소프트웨어대학 소프트웨어학부'), {
    college: '소프트웨어대학',
    department: '소프트웨어학부',
  });
  assert.deepEqual(parseCanvasAccountName('경영경제대학 경영학부(서울) 경영학'), {
    college: '경영경제대학',
    department: '경영학부(서울)',
  });
  // "대학(전체)"(교양/공통 개설 조직)는 교양대학으로 명시 매핑 → ge_notice 라우팅
  assert.deepEqual(parseCanvasAccountName('대학(전체)'), { college: '교양대학', department: null });
  // 그 외 파싱 불가 형태는 null (원문은 canvas_account_name으로 보존)
  assert.deepEqual(parseCanvasAccountName('중앙대학교'), { college: null, department: null });
  assert.deepEqual(parseCanvasAccountName(null), { college: null, department: null });
});

test('syncCourseMetadata stores learningx_sis result with confirmed fields', async () => {
  await withTempExamDb(async () => {
    const cache = new ExamCache();
    const client = {
      fetchOne: async () => ({
        id: 10,
        name: '소프트웨어공학',
        course_code: '2026-1-11708-01',
        sis_course_id: '2026-10-11708-01',
        term: { name: '2026년 1학기' },
      }),
      fetchAll: async () => [],
    } as unknown as CanvasClient;

    const result = await syncCourseMetadata(cache, client, { course_id: 10 }, async () => ({
      ok: true,
      endpoint: '/learningx/api/v1/courses/10/sis_course/check',
      info: {
        college: '소프트웨어대학',
        department: '소프트웨어학부',
        instructor: '이찬근',
        course_code: '11708',
        section: '01',
        term: '2026-1',
        raw_sis_course_id: '2026-10-11708-01',
      },
    }));
    assert.equal(result.ok, true);
    assert.equal(result.synced.length, 1);
    assert.equal(result.synced[0].source, 'learningx_sis');
    assert.equal(result.synced[0].college, '소프트웨어대학');
    assert.equal(result.synced[0].course_code, '11708');
    assert.equal(result.synced[0].section, '01');
    // term은 SIS 확정값("2026-1")이 Canvas "2026년 1학기"를 덮어쓴다
    assert.equal(result.synced[0].term, '2026-1');
    assert.ok(!('confidence' in result.synced[0]));
    cache.getDb().close();
  });
});

test('syncCourseMetadata falls back to canvas_only and preserves Canvas fields', async () => {
  await withTempExamDb(async () => {
    const cache = new ExamCache();
    const client = {
      fetchOne: async () => ({
        id: 20,
        name: '일반물리(1) 03분반',
        course_code: '2026-1-39202-03',
        sis_course_id: '2026-20-39202-03',
        term: { name: '2026년 1학기' },
        teachers: [{ display_name: '홍길동 / Gil Dong Hong' }],
        account: { name: '소프트웨어대학 소프트웨어학부' },
      }),
      fetchAll: async () => [],
    } as unknown as CanvasClient;

    const result = await syncCourseMetadata(cache, client, { course_id: 20 }, async () => ({
      ok: false,
      error_code: 'SIS_ENDPOINT_UNAVAILABLE',
      message: 'LearningX API error 404',
    }));
    assert.equal(result.ok, true);
    const record = result.synced[0];
    assert.equal(record.source, 'canvas_only');
    // SIS 실패여도 Canvas account/teachers 기반 사실값은 채운다
    assert.equal(record.college, '소프트웨어대학');
    assert.equal(record.department, '소프트웨어학부');
    assert.equal(record.instructor, '홍길동 / Gil Dong Hong');
    assert.equal(record.canvas_account_name, '소프트웨어대학 소프트웨어학부');
    assert.equal(record.course_code, null);
    assert.equal(record.section, null);
    assert.equal(record.canvas_course_code, '2026-1-39202-03');
    assert.equal(record.canvas_sis_course_id, '2026-20-39202-03');
    // canvas_only는 SIS 확정 term이 없으므로 Canvas term을 그대로 유지
    assert.equal(record.term, '2026년 1학기');
    assert.match(record.sis_error ?? '', /SIS_ENDPOINT_UNAVAILABLE/);
    cache.getDb().close();
  });
});

test('selectSourcesForCourse filters by confirmed college only', () => {
  const sources = BUILTIN_EXAM_SOURCES;
  assert.deepEqual(
    selectSourcesForCourse(sources, { college: '소프트웨어대학', department: '소프트웨어학부' }).map((s) => s.college),
    ['소프트웨어대학'],
  );
  // 교양과목("대학(전체)"→교양대학 매핑)은 ge_notice로 정확히 라우팅
  assert.deepEqual(
    selectSourcesForCourse(sources, { college: '교양대학', department: null }).map((s) => s.college),
    ['교양대학'],
  );
  // canvas_only(미확정)는 전체 소스 반환
  assert.equal(selectSourcesForCourse(sources, { college: null, department: null }).length, sources.length);
  assert.equal(selectSourcesForCourse(sources, undefined).length, sources.length);
  // 등록 안 된 단과대도 전체 반환 (강의명 추론 없음)
  assert.equal(selectSourcesForCourse(sources, { college: '자연과학대학', department: null }).length, sources.length);
});

test('exam docs exist and reflect v2 contract', () => {
  const docsDir = path.resolve(import.meta.dirname, '..', 'docs');
  const tools = fs.readFileSync(path.join(docsDir, 'TOOLS.md'), 'utf8');
  assert.match(tools, /learningx_sis/);
  assert.match(tools, /canvas_only/);
  assert.match(tools, /EXACT_MATCH_NOT_FOUND/);
  const discovery = fs.readFileSync(path.join(docsDir, 'DISCOVERY.md'), 'utf8');
  assert.match(discovery, /sis_course\/check/);
  assert.ok(fs.existsSync(path.join(docsDir, 'SELF_REPAIR.md')));
});
