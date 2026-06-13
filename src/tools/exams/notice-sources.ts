import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { sanitizeFileName, expandTilde } from '../../utils.js';
import type { ExamSourceRecord } from '../../exam-cache.js';

const REQUEST_TIMEOUT_MS = 30_000;
const SOURCE_LIST_URL = 'https://www.cau.ac.kr/cms/FR_CON/index.do?MENU_ID=800';

export interface ParsedNoticeDocument {
  notice_url: string;
  title: string;
  posted_at: string | null;
  body_text: string;
  body_hash: string;
  attachment_url: string;
  attachment_name: string;
}

export interface DownloadedNoticeDocument extends ParsedNoticeDocument {
  file_hash: string;
  local_pdf_path: string;
  size_bytes: number;
}

export interface NoticeFetchIssue {
  scope: string;
  reason: string;
  retryable: boolean;
}

export const BUILTIN_EXAM_SOURCES: ExamSourceRecord[] = [
  {
    college: '교양대학',
    department: null,
    homepage_url: 'https://ge.cau.ac.kr/',
    notice_board_url: 'https://ge.cau.ac.kr/board_notice_view.php?no=1578&page=1',
    adapter_type: 'ge_notice',
  },
  {
    college: '소프트웨어대학',
    department: '소프트웨어학부',
    homepage_url: 'https://cse.cau.ac.kr/',
    notice_board_url: 'https://cse.cau.ac.kr/sub05/sub0501.php?nmode=view&code=oktomato_bbs05&uid=3396',
    adapter_type: 'cse_notice',
  },
];

function isAllowedPublicCauUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return (url.protocol === 'https:' || url.protocol === 'http:') &&
      (url.hostname === 'cau.ac.kr' || url.hostname === 'www.cau.ac.kr' || url.hostname.endsWith('.cau.ac.kr'));
  } catch {
    return false;
  }
}

function assertAllowedPublicCauUrl(rawUrl: string): void {
  if (!isAllowedPublicCauUrl(rawUrl)) {
    throw new Error(`Public CAU URL rejected: ${rawUrl}`);
  }
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function stripHtml(value: string): string {
  return decodeHtmlEntities(value)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .trim();
}

function firstMatch(html: string, pattern: RegExp): string | null {
  const match = pattern.exec(html);
  return match ? decodeHtmlEntities(match[1]).trim() : null;
}

function sha256(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function absoluteUrl(baseUrl: string, href: string): string {
  return new URL(decodeHtmlEntities(href).trim(), baseUrl).toString();
}

async function fetchText(url: string): Promise<string> {
  assertAllowedPublicCauUrl(url);
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/pdf,application/octet-stream',
      'User-Agent': 'eclass-mcp/0.1 exam-schedule-sync',
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.text();
}

async function fetchBuffer(url: string): Promise<Buffer> {
  assertAllowedPublicCauUrl(url);
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Accept: 'application/pdf,application/octet-stream,*/*',
      'User-Agent': 'eclass-mcp/0.1 exam-schedule-sync',
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

export function parseGeNoticeHtml(html: string, noticeUrl: string): ParsedNoticeDocument | null {
  const title = firstMatch(html, /<p class="tit">[\s\S]*?<strong>([\s\S]*?)<\/strong>/i)
    ?? firstMatch(html, /<title>([\s\S]*?)<\/title>/i)
    ?? '교양대학 시험 공지';
  const postedAt = firstMatch(html, /<li><strong>작성일<\/strong><span class="r">([^<]+)<\/span><\/li>/i);
  const bodyHtml = firstMatch(html, /<div class="view_con">([\s\S]*?)<\/div>\s*<!-- \/\/ view_con -->/i) ?? '';
  const fileMatch = /<div class="view_file">[\s\S]*?<a\s+href="([^"]+)">[\s\S]*?<b>([\s\S]*?)<\/b>/i.exec(html);
  if (!fileMatch) return null;
  const attachmentUrl = absoluteUrl(noticeUrl, fileMatch[1]);
  const attachmentName = stripHtml(fileMatch[2]);
  return {
    notice_url: noticeUrl,
    title,
    posted_at: postedAt,
    body_text: stripHtml(bodyHtml),
    body_hash: sha256(stripHtml(bodyHtml)),
    attachment_url: attachmentUrl,
    attachment_name: attachmentName,
  };
}

export function parseCseNoticeHtml(html: string, noticeUrl: string): ParsedNoticeDocument | null {
  const title = firstMatch(html, /<div class="header">\s*<h3>([\s\S]*?)<\/h3>/i)
    ?? firstMatch(html, /<title>([\s\S]*?)<\/title>/i)
    ?? '소프트웨어대학 시험 공지';
  const postedAt = firstMatch(html, /<div class="header">[\s\S]*?<span>(\d{4}-\d{2}-\d{2})<\/span>/i);
  const bodyHtml = firstMatch(html, /<div class="detail">([\s\S]*?)<!--<!-- 덧글 Start -->/i)
    ?? firstMatch(html, /<div class="detail">([\s\S]*?)<\/div>\s*<\/div>/i)
    ?? '';
  const onclickMatch = /goLocation\('([^']+)','([^']+)','([^']+)'\)[\s\S]*?>([^<]+\.pdf)<\/span>/i.exec(html);
  if (!onclickMatch) return null;
  const attachmentUrl = absoluteUrl(noticeUrl, `${onclickMatch[1]}?uid=${encodeURIComponent(onclickMatch[2])}&code=${encodeURIComponent(onclickMatch[3])}`);
  return {
    notice_url: noticeUrl,
    title,
    posted_at: postedAt,
    body_text: stripHtml(bodyHtml),
    body_hash: sha256(stripHtml(bodyHtml)),
    attachment_url: attachmentUrl,
    attachment_name: stripHtml(onclickMatch[4]),
  };
}

export function parseGenericNoticeHtml(html: string, noticeUrl: string): ParsedNoticeDocument | null {
  const title = firstMatch(html, /<h[123][^>]*>([\s\S]*?(?:기말|시험|시간표)[\s\S]*?)<\/h[123]>/i)
    ?? firstMatch(html, /<title>([\s\S]*?)<\/title>/i)
    ?? '시험 공지';
  const postedAt = firstMatch(html, /(\d{4}[-.]\d{2}[-.]\d{2})/);
  const anchorPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorPattern)) {
    const text = stripHtml(match[2]);
    const href = decodeHtmlEntities(match[1]);
    const target = `${text} ${href}`.toLowerCase();
    if (!target.includes('pdf') && !target.includes('download')) continue;
    if (!/(기말|시험|시간표|final|exam)/i.test(target)) continue;
    return {
      notice_url: noticeUrl,
      title,
      posted_at: postedAt?.replaceAll('.', '-') ?? null,
      body_text: stripHtml(html),
      body_hash: sha256(stripHtml(html)),
      attachment_url: absoluteUrl(noticeUrl, href),
      attachment_name: text || path.basename(href),
    };
  }
  return null;
}

export function parseNoticeHtml(html: string, noticeUrl: string, adapterType: string): ParsedNoticeDocument | null {
  if (adapterType === 'ge_notice') return parseGeNoticeHtml(html, noticeUrl);
  if (adapterType === 'cse_notice') return parseCseNoticeHtml(html, noticeUrl);
  return parseGenericNoticeHtml(html, noticeUrl);
}

export async function fetchNoticeDocument(source: ExamSourceRecord): Promise<ParsedNoticeDocument | null> {
  const html = await fetchText(source.notice_board_url);
  return parseNoticeHtml(html, source.notice_board_url, source.adapter_type);
}

export async function downloadNoticePdf(
  document: ParsedNoticeDocument,
  input: { term: string; exam_type: string; download_dir?: string },
): Promise<DownloadedNoticeDocument> {
  const buffer = await fetchBuffer(document.attachment_url);
  if (buffer.length < 4 || buffer.subarray(0, 4).toString('latin1') !== '%PDF') {
    throw new Error('Downloaded attachment is not a PDF');
  }
  const safeName = sanitizeFileName(document.attachment_name) ?? `${sha256(document.attachment_url).slice(0, 12)}.pdf`;
  const dir = path.join(
    expandTilde(input.download_dir ?? process.env.ECLASS_EXAM_DOWNLOAD_DIR ?? '~/Downloads/eclass-exams'),
    input.term,
    input.exam_type,
  );
  await fs.mkdir(dir, { recursive: true });
  const localPath = path.join(dir, safeName.toLowerCase().endsWith('.pdf') ? safeName : `${safeName}.pdf`);
  await fs.writeFile(localPath, buffer);
  return {
    ...document,
    file_hash: sha256(buffer),
    local_pdf_path: localPath,
    size_bytes: buffer.length,
  };
}

export async function discoverExamSources(): Promise<{ sources: ExamSourceRecord[]; issues: NoticeFetchIssue[] }> {
  const sources = [...BUILTIN_EXAM_SOURCES];
  const issues: NoticeFetchIssue[] = [];
  try {
    const html = await fetchText(SOURCE_LIST_URL);
    const collegeLinkPattern = /<a\s+[^>]*href=["']([^"']*MENU_ID=\d+[^"']*)["'][^>]*title=["']([^"']*대학[^"']*)["'][^>]*>/gi;
    for (const match of html.matchAll(collegeLinkPattern)) {
      const college = decodeHtmlEntities(match[2]).replace(/\s+/g, ' ').trim();
      if (!college || sources.some((s) => s.college === college)) continue;
      const noticeBoardUrl = absoluteUrl(SOURCE_LIST_URL, match[1]);
      sources.push({
        college,
        department: null,
        homepage_url: noticeBoardUrl,
        notice_board_url: noticeBoardUrl,
        adapter_type: 'generic_cau_college_page',
      });
    }
  } catch (err) {
    issues.push({
      scope: SOURCE_LIST_URL,
      reason: err instanceof Error ? err.message : String(err),
      retryable: true,
    });
  }
  return { sources, issues };
}

// SIS 확정 college/department로만 소스를 좁힌다. college가 없으면(canvas_only) 전체를 본다.
export function selectSourcesForCourse(
  allSources: ExamSourceRecord[],
  course: { college?: string | null; department?: string | null } | undefined,
): ExamSourceRecord[] {
  if (!course?.college && !course?.department) return allSources;
  const selected = allSources.filter((source) =>
    (course.college !== null && course.college !== undefined && source.college === course.college) ||
    (course.department !== null && course.department !== undefined && source.department === course.department),
  );
  return selected.length > 0 ? selected : allSources;
}
