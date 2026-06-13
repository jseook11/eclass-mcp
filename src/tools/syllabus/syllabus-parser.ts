import type {
  SyllabusDocument,
  SyllabusAssessment,
  SyllabusTextbook,
  SyllabusScheduleWeek,
} from './types.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

// 평가 항목 라벨(국문) → 정규화 키. 라벨 라인은 "출결(Attendance)" 형태.
const ASSESSMENT_LABELS = ['출결', '중간시험', '기말시험', '과제', '퀴즈', '발표', '참여', '기타'];

function lines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim());
}

function parseAssessment(ls: string[]): SyllabusAssessment[] {
  const out: SyllabusAssessment[] = [];
  for (let i = 0; i < ls.length; i += 1) {
    const label = ASSESSMENT_LABELS.find((k) => ls[i].startsWith(k + '('));
    if (!label) continue;
    // 라벨 다음 비어있지 않은 줄에서 숫자(%) 탐색
    for (let j = i + 1; j < Math.min(i + 3, ls.length); j += 1) {
      const m = /^(\d{1,3})$/.exec(ls[j]);
      if (m) {
        out.push({ item: label, ratio: Number(m[1]), description: null });
        break;
      }
    }
  }
  return out;
}

// 시작 앵커 다음 줄부터 끝 앵커 전까지의 비어있지 않은 줄을 반환.
function sectionBetween(ls: string[], startIncludes: RegExp, endIncludes: RegExp): string[] {
  const start = ls.findIndex((l) => startIncludes.test(l));
  if (start < 0) return [];
  let end = ls.findIndex((l, i) => i > start && endIncludes.test(l));
  if (end < 0) end = ls.length;
  return ls.slice(start + 1, end).filter((l) => l.length > 0);
}

// ───────────────────────────── -layout 표 파서 ─────────────────────────────
// pdftotext 기본(reading-order) 모드는 2-D 표를 열별 조각으로 평탄화해 셀이 뒤섞인다.
// -layout 모드는 컬럼을 공간적으로 보존하므로, 헤더에서 각 컬럼의 시작 위치를 잡고
// 데이터 행을 앵커(주차번호/교재종류)로 분할한 뒤 각 셀을 가장 가까운 컬럼에 버킷팅한다.
// 한 행이 여러 물리 라인으로 래핑돼도(제목/강사명/주제 줄바꿈) 같은 컬럼끼리 병합된다.

interface ColumnSpec { key: string; tokens: string[] }
interface Column { key: string; start: number }

// 한 라인을 2칸 이상 공백으로 구분되는 셀들로 분리하고 각 셀의 시작 열 위치를 기록.
// 셀 내부의 단일 공백(예: "1장과 2 장", "Conte nt" 같은 글리프 잡공백)은 보존한다.
function splitCells(line: string): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = [];
  const n = line.length;
  let i = 0;
  while (i < n) {
    while (i < n && line[i] === ' ') i += 1; // 셀 앞 공백 건너뜀
    if (i >= n) break;
    const start = i;
    let j = i;
    while (j < n && !(line[j] === ' ' && line[j + 1] === ' ')) j += 1; // 2칸 이상 공백에서 분리
    const text = line.slice(start, j).trim();
    if (text.length > 0) out.push({ text, start });
    i = j;
  }
  return out;
}

// 헤더 라인들에서 각 컬럼 토큰의 최좌측 시작 열을 찾는다. anchor 컬럼(start 0)은 항상 포함.
function detectColumns(headerLines: string[], specs: ColumnSpec[]): Column[] {
  const cols: Column[] = [{ key: '__anchor__', start: 0 }];
  for (const spec of specs) {
    let start = -1;
    for (const line of headerLines) {
      for (const tok of spec.tokens) {
        const idx = line.indexOf(tok);
        if (idx >= 0 && (start < 0 || idx < start)) start = idx;
      }
    }
    if (start >= 0) cols.push({ key: spec.key, start });
  }
  return cols.sort((a, b) => a.start - b.start);
}

function nearestColumn(cols: Column[], start: number): string {
  let best = cols[0];
  let bestDist = Infinity;
  for (const c of cols) {
    const d = Math.abs(c.start - start);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best.key;
}

// 컬럼 헤더 라인 식별용(첫 행 시작 위치 계산에 사용).
const HEADER_TOKEN_RE =
  /제목\(|저자\(|출판일|출판사|판차사항|호정보|of Edition|of Journal|Publication|Textbook\/Referen|수업주제 및 내용|강사명|학습과제|추가설명|Instructor Assignment|\(Instructor\)|\(Student|\(Additional/;

// 잡음 셀(반복 헤더/섹션 마커)인지 판정.
function isNoiseCell(text: string): boolean {
  return (
    /^\[\d+\]/.test(text) ||
    /수업주제 및 내용|강사명|학습과제|추가설명|수강생 학습|^주\(|^eek\)|Instructor\)|Student\)|Additional|제목\(|저자\(|수업 자료|Textbook\/Referen|출판일|출판사|판차사항|호정보|Year of|Publisher\/Name|Publication|of Journal|of Edition|^ce\)$/.test(
      text,
    ) ||
    /^\d+\s*\/\s*\d+$/.test(text) // 페이지 번호 "3/4"
  );
}

// 데이터 영역을 앵커 라인 기준으로 행 단위로 분할해, 각 행의 컬럼별 텍스트를 반환.
function parseGridRows(
  rawLines: string[],
  startRe: RegExp,
  endRe: RegExp,
  columns: ColumnSpec[],
  isAnchor: (cells: { text: string; start: number }[]) => boolean,
): { cells: Record<string, string>; anchorText: string }[] {
  const startIdx = rawLines.findIndex((l) => startRe.test(l));
  if (startIdx < 0) return [];
  let endIdx = rawLines.findIndex((l, i) => i > startIdx && endRe.test(l));
  if (endIdx < 0) endIdx = rawLines.length;

  const region = rawLines.slice(startIdx + 1, endIdx);
  const splitRegion = region.map(splitCells);

  // 앵커 라인 인덱스 수집.
  const anchors: number[] = [];
  for (let i = 0; i < splitRegion.length; i += 1) {
    if (splitRegion[i].length > 0 && isAnchor(splitRegion[i])) anchors.push(i);
  }
  if (anchors.length === 0) return [];

  // 헤더 라인 = 영역 시작 ~ 첫 앵커 전.
  const headerLines = region.slice(0, anchors[0]);
  const cols = detectColumns(headerLines, columns);

  // 첫 앵커 위쪽에는 컬럼 헤더 + (래핑된) 첫 행 내용이 섞여 있다. 헤더 토큰이 마지막으로
  // 나타난 라인 다음부터를 첫 행 시작으로 잡아, 헤더가 첫 행 값으로 새지 않게 한다.
  let headerEnd = -1;
  for (let i = 0; i < anchors[0]; i += 1) {
    if (HEADER_TOKEN_RE.test(region[i])) headerEnd = i;
  }
  const firstStart = headerEnd >= 0 ? headerEnd + 1 : 0;

  // 앵커 사이 중점을 행 경계로 사용(래핑된 라인을 가까운 행에 귀속).
  const bounds: number[] = [firstStart];
  for (let i = 1; i < anchors.length; i += 1) {
    bounds.push(Math.ceil((anchors[i - 1] + anchors[i]) / 2));
  }
  bounds.push(region.length);

  const rows: { cells: Record<string, string>; anchorText: string }[] = [];
  for (let r = 0; r < anchors.length; r += 1) {
    const buckets: Record<string, string[]> = {};
    for (let li = bounds[r]; li < bounds[r + 1]; li += 1) {
      for (const cell of splitRegion[li]) {
        if (isNoiseCell(cell.text)) continue;
        const key = nearestColumn(cols, cell.start);
        (buckets[key] ??= []).push(cell.text);
      }
    }
    const cells: Record<string, string> = {};
    for (const [k, v] of Object.entries(buckets)) {
      cells[k] = v.join(' ').replace(/\s+/g, ' ').trim();
    }
    rows.push({ cells, anchorText: splitRegion[anchors[r]][0]?.text ?? '' });
  }
  return rows;
}

// 값에서 한글 접두부("운영체제(OPERATING" → "운영체제")만 떼어낸다.
function koreanPrefix(value: string | null): string | null {
  if (!value) return null;
  const m = /^([가-힣A-Za-z0-9·\s]+?)\s*\(/.exec(value);
  const head = (m ? m[1] : value).trim();
  return head.length > 0 ? head : null;
}

const TEXTBOOK_KIND_RE = /^(주교재|부교재|참고도서|참고문헌|주참고문헌|부참고문헌|기타)/;

function parseTextbooks(layoutLines: string[]): SyllabusTextbook[] {
  const rows = parseGridRows(
    layoutLines,
    /수업 자료\(Te|수업 자료\(텍|■ 수업 자료/,
    /\[4\]|학습 평가 방법/,
    [
      { key: 'title', tokens: ['제목('] },
      { key: 'author', tokens: ['저자('] },
      { key: 'year', tokens: ['출판일', '(Year'] },
      { key: 'publisher', tokens: ['출판사', '(Publisher'] },
      { key: 'edition', tokens: ['판차', '호정보', 'of Edition'] },
    ],
    (cells) => TEXTBOOK_KIND_RE.test(cells[0].text),
  );

  const out: SyllabusTextbook[] = [];
  for (const { cells, anchorText } of rows) {
    const kind = koreanPrefix(anchorText) ?? anchorText.trim();
    const title = cells.title || null;
    const author = cells.author || null;
    // 제목/저자가 모두 비면 빈 행(잡음)으로 보고 건너뛴다.
    if (!title && !author) continue;
    out.push({
      kind,
      title,
      author,
      year: cells.year || null,
      publisher: cells.publisher || null,
      edition: cells.edition || null,
    });
  }
  return out;
}

function parseSchedule(layoutLines: string[]): SyllabusScheduleWeek[] {
  const rows = parseGridRows(
    layoutLines,
    /수업 일정/,
    /\[6\]|수강생 학습/,
    [
      { key: 'instructor', tokens: ['강사명', '(Instructor'] },
      { key: 'topic', tokens: ['수업주제'] },
      { key: 'student', tokens: ['학습과제', '(Student'] },
      { key: 'instructor_assignment', tokens: ['추가설명', '(Additional', 'Instructor Assignment'] },
    ],
    (cells) => {
      const m = /^(\d{1,2})$/.exec(cells[0].text);
      return m != null && Number(m[1]) >= 1 && Number(m[1]) <= 30;
    },
  );

  const seen = new Set<number>();
  const out: SyllabusScheduleWeek[] = [];
  for (const { cells, anchorText } of rows) {
    const week = Number(anchorText);
    if (!Number.isFinite(week) || seen.has(week)) continue;
    seen.add(week);
    out.push({
      week,
      instructor: cells.instructor || null,
      topic: cells.topic || null,
      student_assignment: cells.student || null,
      instructor_assignment: cells.instructor_assignment || null,
    });
  }
  return out.sort((a, b) => a.week - b.week);
}

// ───────────────────────────── plain 모드 scalar 파서 ─────────────────────────────
// 파서가 앵커로 삼는 국문 라벨들 + 값으로 새는 비추출 라벨들.
// pdftotext 컬럼 인터리브 때문에 라벨 라인 자체가 "값"인 척 따라붙는 경우가 있어,
// 기본 모드에서 이 접두부로 시작하는 후보 라인을 값에서 제외한다.
const KNOWN_LABELS = [
  '개설년도/학기',
  '교과목번호',
  '개설 캠퍼스',
  '분반번호',
  '학점',
  '교과목명',
  '강의시간/강의실',
  '이수구분',
  '과목구분',
  '강의유형',
  '원어강의',
  '개설대학',
  '개설학과',
  'e-class 활용여부',
  'E-mail 주소',
  '연구실전화번호',
  '연락처',
  '상담가능시간',
  '연구실위치',
  '홈페이지',
  '교수명',
  '소속',
  '학과전화번호',
  // 추출 대상은 아니지만 컬럼 인터리브로 값 자리에 새는 라벨들.
  '공학인증 여부',
  '대학 자체 인증',
];

const HANGUL = /[가-힣]/;

// 라벨 라인 다음의 값 라인. pattern을 주면 lookahead 창 내 첫 매칭 라인을, 없으면 첫 비어있지
// 않고 영문 괄호라벨도 아니고 알려진 라벨로 시작하지도 않는 라인을 반환(컬럼 인터리브 대응).
// requireHangul: 후보가 한글을 포함해야 값으로 인정(영문 라벨 연속 조각 예: "Instruction)" 거부).
function valueAfterLabel(
  ls: string[],
  labelStartsWith: string,
  opts?: { pattern?: RegExp; lookahead?: number; requireHangul?: boolean },
): string | null {
  const i = ls.findIndex((l) => l.startsWith(labelStartsWith));
  if (i < 0) return null;
  const end = Math.min(i + 1 + (opts?.lookahead ?? 4), ls.length);
  for (let j = i + 1; j < end; j += 1) {
    if (opts?.pattern) {
      if (opts.pattern.test(ls[j])) return ls[j];
      continue;
    }
    const cand = ls[j];
    if (cand.length === 0) continue;
    if (/^\(/.test(cand)) continue;
    if (KNOWN_LABELS.some((label) => cand.startsWith(label))) continue;
    if (opts?.requireHangul && !HANGUL.test(cand)) continue;
    return cand;
  }
  return null;
}

const PHONE = /[\d][\d-]{5,}/;
const URLISH = /https?:\/\/|www\.|\.(com|ac|kr|edu|net|org)/i;

function parseBasic(ls: string[]): SyllabusDocument['basic'] {
  // 개설년도/학기: "2026 / S" → year=2026, term=S
  const yearTerm = valueAfterLabel(ls, '개설년도/학기');
  let year: string | null = null;
  let term: string | null = null;
  if (yearTerm) {
    const parts = yearTerm.split('/').map((p) => p.trim());
    year = parts[0] || null;
    term = parts[1] || null;
  }

  return {
    year,
    term,
    // pdftotext가 분반번호 라벨/영문 라벨을 사이에 끼워 넣어 실제 값(서울...)이 멀리 밀린다.
    campus: koreanPrefix(valueAfterLabel(ls, '개설 캠퍼스', { requireHangul: true, lookahead: 6 })),
    course_code: valueAfterLabel(ls, '교과목번호', { pattern: /^\d{4,5}$/, lookahead: 4 }),
    section: valueAfterLabel(ls, '분반번호', { pattern: /^\d{2}$/, lookahead: 8 }),
    credit: valueAfterLabel(ls, '학점', { pattern: /^\d$/, lookahead: 8 }),
    title_ko: koreanPrefix(valueAfterLabel(ls, '교과목명')),
    title_en: null,
    time_room: valueAfterLabel(ls, '강의시간/강의실'),
    classification: koreanPrefix(valueAfterLabel(ls, '이수구분', { requireHangul: true })),
    lecture_type: koreanPrefix(valueAfterLabel(ls, '과목구분', { requireHangul: true })),
    course_type: koreanPrefix(valueAfterLabel(ls, '강의유형', { requireHangul: true })),
    medium: koreanPrefix(valueAfterLabel(ls, '원어강의', { requireHangul: true })),
    college: koreanPrefix(valueAfterLabel(ls, '개설대학', { requireHangul: true })),
    department: koreanPrefix(valueAfterLabel(ls, '개설학과', { requireHangul: true })),
    // e-class 활용여부: pdftotext 컬럼 인터리브로 라벨 다음에 다른 행 조각(예: "공학주제...")이
    // 끼어들어 신뢰할 수 없다. 라벨/그럴듯한 오답을 내보내느니 정직하게 null로 두고 raw_text에 맡긴다.
    eclass_usage: null,
  };
}

function parseInstructor(ls: string[]): SyllabusDocument['instructor'] {
  // name: 교수명 라벨 값(한글) 우선. 없으면(예: 운영체제는 라벨에 값이 비고 헤더 직후에 옴)
  // "■ 교수자 정보" 헤더 직후 "홍철호(Ch e ol-..." 형태의 첫 한글(이름) 줄에서 접두부.
  let name = koreanPrefix(valueAfterLabel(ls, '교수명', { requireHangul: true }));
  if (!name) {
    const headerIdx = ls.findIndex((l) => /교수자 정보/.test(l));
    const searchFrom = headerIdx >= 0 ? headerIdx + 1 : 0;
    const nameLine = ls.slice(searchFrom).find((l) => /^[가-힣]{2,5}\(/.test(l));
    name = koreanPrefix(nameLine ?? null);
  }

  return {
    name,
    email: valueAfterLabel(ls, 'E-mail 주소'),
    // 전화 필드: 값이 빈 셀이면 다음 행 라벨/값이 새므로, 전화번호 패턴 + 짧은 lookahead로 한정.
    office_phone: valueAfterLabel(ls, '연구실전화번호', { pattern: PHONE, lookahead: 3 }),
    contact: valueAfterLabel(ls, '연락처', { pattern: PHONE, lookahead: 3 }),
    office_hour: valueAfterLabel(ls, '상담가능시간', { requireHangul: true }),
    office_location: valueAfterLabel(ls, '연구실위치'),
    // 홈페이지: 값이 비면 페이지번호("1/4")가 새므로 URL 형태만 인정.
    homepage: valueAfterLabel(ls, '홈페이지', { pattern: URLISH, lookahead: 3 }),
  };
}

function parseDescription(ls: string[]): string | null {
  const body = sectionBetween(ls, /과목 설명/, /선수과목|학습 목표/);
  if (body.length === 0) return null;
  return body.join('\n');
}

// plain = reading-order 텍스트(scalar 추출용), layout = -layout 텍스트(표 추출 + raw_text용).
// layout 미지정 시 plain으로 폴백한다.
export function parseSyllabusText(plain: string, layout?: string): SyllabusDocument {
  const ls = lines(plain);
  const layoutText = layout ?? plain;
  const layoutLines = layoutText.split(/\r?\n/);
  return {
    basic: parseBasic(ls),
    instructor: parseInstructor(ls),
    objectives: {
      description: parseDescription(ls),
      prerequisites: null,
      learning_objectives: null,
      learning_outcomes: null,
    },
    textbooks: parseTextbooks(layoutLines),
    assessment: parseAssessment(ls),
    schedule: parseSchedule(layoutLines),
    raw_text: layoutText,
  };
}

export type ExtractResult =
  | { ok: true; text: string; layout: string }
  | { ok: false; error_code: 'SYLLABUS_PARSER_UNAVAILABLE' | 'SYLLABUS_EXTRACT_FAILED'; message: string };

// OZ가 내려준 PDF buffer를 pdftotext로 두 번 텍스트화한다:
// text=reading-order(scalar 파싱용), layout=-layout(표 파싱 + raw_text용).
export async function extractSyllabusPdfText(pdf: Buffer): Promise<ExtractResult> {
  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'eclass-syllabus-'));
    const pdfPath = join(dir, 'syllabus.pdf');
    await writeFile(pdfPath, pdf);
    const [{ stdout: text }, { stdout: layout }] = await Promise.all([
      execFileAsync('pdftotext', [pdfPath, '-']),
      execFileAsync('pdftotext', ['-layout', pdfPath, '-']),
    ]);
    return { ok: true, text, layout };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/ENOENT/.test(message)) {
      return { ok: false, error_code: 'SYLLABUS_PARSER_UNAVAILABLE', message: 'pdftotext(poppler) 미설치' };
    }
    return { ok: false, error_code: 'SYLLABUS_EXTRACT_FAILED', message };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
