import type { BrowserSession } from './browser-session.js';
import type { SyllabusSearchItem } from './tools/syllabus/types.js';
import { extractSyllabusPdfText, parseSyllabusText } from './tools/syllabus/syllabus-parser.js';
import type { SyllabusDocument } from './tools/syllabus/types.js';

interface RawSyllabusRow {
  year?: string; shtm?: string; campcd?: string; sbjtno1?: string; clssno1?: string;
  sbjtno?: string; kornm?: string; sust?: string; colgnm?: string; corscd?: string;
  shtnm?: string; profnm?: string; ltbdrm?: string; fileusefg?: string | null;
}

export function normalizeSyllabusSearch(body: unknown): SyllabusSearchItem[] {
  const rows = (body as { result?: RawSyllabusRow[] })?.result;
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => {
    const [college, department] = (r.colgnm ?? '').split(/<br\s*\/?>/i).map((s) => s.trim());
    return {
      year: r.year ?? '', term: r.shtm ?? '', campus_code: r.campcd ?? '',
      course_code: r.sbjtno1 ?? '', section: r.clssno1 ?? '',
      course_no_full: r.sbjtno ?? '', course_name: r.kornm ?? '', sust_code: r.sust ?? '',
      college: college || null, department: department || null,
      classification: r.shtnm ?? null, professor: r.profnm ?? null, time_room: r.ltbdrm ?? null,
      has_file: r.fileusefg != null,
    };
  });
}

export interface SearchSyllabusInput {
  year?: string; term?: string; query: string; by?: 'subject' | 'professor';
}

export async function searchSyllabusList(
  session: BrowserSession, input: SearchSyllabusInput,
): Promise<{ ok: true; items: SyllabusSearchItem[] } | { ok: false; error_code: string; message: string }> {
  // year/term 미지정 시 현재 학기 조회
  let year = input.year, term = input.term;
  if (!year || !term) {
    const cur = await session.mportalPostJson<{ year?: Array<{ year?: string; shtm?: string }> }>(
      '/std/usk/sUskSif002/selectCurYear.ajax', {});
    year = year ?? cur.year?.[0]?.year;
    term = term ?? cur.year?.[0]?.shtm;
  }
  if (!year || !term) return { ok: false, error_code: 'SYLLABUS_TERM_UNRESOLVED', message: '현재 학기 조회 실패' };
  const choice = input.by === 'professor' ? 'prof' : 'sbjt';
  const body = await session.mportalPostJson<{ msgCode?: string }>(
    '/std/usk/sUskSif002/selectList.ajax',
    { year, shtm: term, choice, searchnm: input.query });
  if (body?.msgCode !== 'success') {
    return { ok: false, error_code: 'SYLLABUS_SEARCH_FAILED', message: `msgCode=${body?.msgCode}` };
  }
  return { ok: true, items: normalizeSyllabusSearch(body) };
}

const OZ_VIEWER = 'https://rpt80.cau.ac.kr/oz80/ozhViewer2.jsp';

export interface GetSyllabusInput {
  year: string; term: string; sbjtno1: string; clssno1: string;
  campcd?: string; sust?: string;
}

export async function getSyllabus(
  session: BrowserSession, input: GetSyllabusInput,
): Promise<{ ok: true; document: SyllabusDocument } | { ok: false; error_code: string; message: string }> {
  const paramOdi =
    `year=${input.year},shtm=${input.term},camp_cd=${input.campcd ?? '1'},` +
    `sust=${input.sust ?? ''},sbjt_no=${input.sbjtno1},clss_no=${input.clssno1}`;
  const viewerUrl =
    `${OZ_VIEWER}?ozr_path=TIS/prof/usk&ozr_nm=pUskLei008` +
    `&param_odi=${encodeURIComponent(paramOdi)}&param_form=new`;
  let pdf: Buffer;
  try {
    pdf = await session.fetchOzPdf(viewerUrl, {});
  } catch (err) {
    return { ok: false, error_code: 'SYLLABUS_OZ_UNAVAILABLE',
      message: err instanceof Error ? err.message : String(err) };
  }
  const extracted = await extractSyllabusPdfText(pdf);
  if (!extracted.ok) return { ok: false, error_code: extracted.error_code, message: extracted.message };
  return { ok: true, document: parseSyllabusText(extracted.text, extracted.layout) };
}
