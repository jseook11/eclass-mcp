import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ExamScheduleRecord } from '../../exam-cache.js';

const execFileAsync = promisify(execFile);

interface TsvWord {
  page_num: number;
  left: number;
  top: number;
  width: number;
  text: string;
}

type PdfLayout = 'general_education' | 'software_college';

export type ParseExamPdfResult = {
  ok: true;
  parser: 'pdftotext-tsv';
  layout: PdfLayout;
  schedules: Omit<ExamScheduleRecord, 'id' | 'source_document_id'>[];
} | {
  ok: false;
  error_code: 'EXAM_PARSER_UNAVAILABLE' | 'EXAM_PARSER_UNSUPPORTED' | 'EXAM_PARSER_FAILED';
  message: string;
  retryable: boolean;
  next_action?: string;
  debug?: string;
};

function parseNumber(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parsePdftotextTsv(tsv: string): TsvWord[] {
  const lines = tsv.split(/\r?\n/).filter(Boolean);
  if (lines.length <= 1) return [];
  const header = lines[0].split('\t');
  const idx = (name: string): number => header.indexOf(name);
  const pageIdx = idx('page_num');
  const leftIdx = idx('left');
  const topIdx = idx('top');
  const widthIdx = idx('width');
  const textIdx = idx('text');
  if ([pageIdx, leftIdx, topIdx, widthIdx, textIdx].some((i) => i < 0)) return [];

  const words: TsvWord[] = [];
  for (const line of lines.slice(1)) {
    const cols = line.split('\t');
    const text = cols[textIdx];
    if (!text || text.startsWith('###')) continue;
    words.push({
      page_num: parseNumber(cols[pageIdx]),
      left: parseNumber(cols[leftIdx]),
      top: parseNumber(cols[topIdx]),
      width: parseNumber(cols[widthIdx]),
      text,
    });
  }
  return words;
}

function detectLayout(words: TsvWord[]): PdfLayout | null {
  const joined = words.slice(0, 200).map((w) => w.text).join(' ');
  if (joined.includes('소프트웨어') || (joined.includes('교과목') && joined.includes('코드'))) {
    return 'software_college';
  }
  if (joined.includes('교양대학') || joined.includes('기말시험 유형') || joined.includes('교과목명')) {
    return 'general_education';
  }
  return null;
}

function normalizeCell(words: TsvWord[]): string | null {
  const sorted = [...words].sort((a, b) => a.left - b.left);
  if (sorted.length === 0) return null;
  let output = '';
  let prev: TsvWord | null = null;
  for (const word of sorted) {
    if (!prev) {
      output = word.text;
    } else {
      const gap = word.left - (prev.left + prev.width);
      const needsSpace = gap > 3 || /[A-Za-z0-9)]$/.test(prev.text) || /^[A-Za-z0-9(]/.test(word.text);
      output += needsSpace ? ` ${word.text}` : word.text;
    }
    prev = word;
  }
  return output.replace(/\s+/g, ' ').trim() || null;
}

function wordsInRange(words: TsvWord[], minX: number, maxX: number): TsvWord[] {
  return words.filter((w) => w.left >= minX && w.left < maxX);
}

function groupVisualLines(words: TsvWord[]): TsvWord[][] {
  const lines: TsvWord[][] = [];
  const byPage = new Map<number, TsvWord[]>();
  for (const word of words) {
    const pageWords = byPage.get(word.page_num) ?? [];
    pageWords.push(word);
    byPage.set(word.page_num, pageWords);
  }

  for (const pageWords of byPage.values()) {
    const sorted = [...pageWords].sort((a, b) => a.top - b.top || a.left - b.left);
    for (const word of sorted) {
      const existing = lines.find((line) =>
        line[0].page_num === word.page_num && Math.abs(line[0].top - word.top) <= 2.2,
      );
      if (existing) existing.push(word);
      else lines.push([word]);
    }
  }
  return lines.map((line) => line.sort((a, b) => a.left - b.left));
}

function toIsoDate(value: string | null): string | null {
  if (!value) return null;
  const match = /(\d{4})[-.](\d{1,2})[-.](\d{1,2})/.exec(value);
  if (!match) return null;
  return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
}

function toTime(value: string | null): string | null {
  if (!value) return null;
  const match = /(\d{1,2}):(\d{2})/.exec(value);
  if (!match) return null;
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

function isExamMethod(value: string | null): boolean {
  return !!value && /(대면시험|온라인|과제물대체|미실시|기타)/.test(value);
}

function parseSoftwareLine(
  line: TsvWord[],
  term: string,
  examType: string,
): Omit<ExamScheduleRecord, 'id' | 'source_document_id'> | null {
  const courseCode = normalizeCell(wordsInRange(line, 20, 52));
  const section = normalizeCell(wordsInRange(line, 52, 78));
  const courseName = normalizeCell(wordsInRange(line, 78, 145));
  if (!courseCode || !/^\d{4,6}$/.test(courseCode) || !section || !courseName) return null;

  const lectureTime = normalizeCell(wordsInRange(line, 145, 185));
  const instructor = normalizeCell(wordsInRange(line, 185, 220));
  const examMethod = normalizeCell(wordsInRange(line, 240, 286));
  if (!isExamMethod(examMethod)) return null;

  const examDate = toIsoDate(normalizeCell(wordsInRange(line, 286, 322)));
  const startTime = toTime(normalizeCell(wordsInRange(line, 322, 356)));
  const endTime = toTime(normalizeCell(wordsInRange(line, 356, 390)));
  const building = normalizeCell(wordsInRange(line, 390, 420));
  const rooms = normalizeCell(wordsInRange(line, 420, 540));
  const note = normalizeCell(wordsInRange(line, 540, 595));

  return {
    term,
    exam_type: examType,
    course_code: courseCode,
    course_name: courseName,
    section,
    lecture_time: lectureTime,
    instructor,
    exam_method: examMethod,
    exam_date: examDate,
    start_time: startTime,
    end_time: endTime,
    building,
    rooms,
    note,
    raw_text: normalizeCell(line),
  };
}

function parseGeneralEducationLine(
  line: TsvWord[],
  term: string,
  examType: string,
): Omit<ExamScheduleRecord, 'id' | 'source_document_id'> | null {
  const courseName = normalizeCell(wordsInRange(line, 0, 160));
  const section = normalizeCell(wordsInRange(line, 160, 190));
  const lectureTime = normalizeCell(wordsInRange(line, 190, 275));
  const instructor = normalizeCell(wordsInRange(line, 275, 365));
  const examMethod = normalizeCell(wordsInRange(line, 365, 475));
  if (!courseName || !section || !/^[A-Z0-9]{2,3}$/i.test(section) || !isExamMethod(examMethod)) return null;

  const examDate = toIsoDate(normalizeCell(wordsInRange(line, 475, 560)));
  const startTime = toTime(normalizeCell(wordsInRange(line, 560, 635)));
  const endTime = toTime(normalizeCell(wordsInRange(line, 635, 705)));
  const building = normalizeCell(wordsInRange(line, 705, 760));
  const rooms = normalizeCell(wordsInRange(line, 760, 842));

  return {
    term,
    exam_type: examType,
    course_code: null,
    course_name: courseName,
    section,
    lecture_time: lectureTime,
    instructor,
    exam_method: examMethod,
    exam_date: examDate,
    start_time: startTime,
    end_time: endTime,
    building,
    rooms,
    note: null,
    raw_text: normalizeCell(line),
  };
}

export function parseExamScheduleTsv(
  tsv: string,
  input: { term: string; exam_type: string },
): ParseExamPdfResult {
  const words = parsePdftotextTsv(tsv);
  if (words.length === 0) {
    return {
      ok: false,
      error_code: 'EXAM_PARSER_UNSUPPORTED',
      message: 'PDF에서 텍스트를 추출하지 못했습니다.',
      retryable: false,
      next_action: '스캔 PDF/OCR 문서는 v1에서 지원하지 않습니다. 원본 PDF를 직접 확인하세요.',
    };
  }

  const layout = detectLayout(words);
  if (!layout) {
    return {
      ok: false,
      error_code: 'EXAM_PARSER_UNSUPPORTED',
      message: '지원하지 않는 시험 시간표 PDF 형식입니다.',
      retryable: false,
    };
  }

  const schedules = groupVisualLines(words)
    .map((line) => layout === 'software_college'
      ? parseSoftwareLine(line, input.term, input.exam_type)
      : parseGeneralEducationLine(line, input.term, input.exam_type))
    .filter((row): row is Omit<ExamScheduleRecord, 'id' | 'source_document_id'> => row !== null);

  if (schedules.length === 0) {
    return {
      ok: false,
      error_code: 'EXAM_PARSER_UNSUPPORTED',
      message: '시험 시간표 행을 식별하지 못했습니다.',
      retryable: false,
    };
  }

  return { ok: true, parser: 'pdftotext-tsv', layout, schedules };
}

export async function parseExamPdf(
  pdfPath: string,
  input: { term: string; exam_type: string },
): Promise<ParseExamPdfResult> {
  try {
    await execFileAsync('pdftotext', ['-v']);
  } catch (err) {
    return {
      ok: false,
      error_code: 'EXAM_PARSER_UNAVAILABLE',
      message: 'pdftotext 실행 파일을 찾을 수 없습니다.',
      retryable: false,
      next_action: 'poppler를 설치한 뒤 다시 실행하세요. macOS: brew install poppler',
      debug: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    const { stdout } = await execFileAsync('pdftotext', ['-tsv', pdfPath, '-'], {
      maxBuffer: 50 * 1024 * 1024,
    });
    return parseExamScheduleTsv(stdout, input);
  } catch (err) {
    return {
      ok: false,
      error_code: 'EXAM_PARSER_FAILED',
      message: 'PDF 텍스트 추출 중 오류가 발생했습니다.',
      retryable: true,
      debug: err instanceof Error ? err.message : String(err),
    };
  }
}
