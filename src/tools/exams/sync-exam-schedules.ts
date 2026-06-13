import type { ExamCache, ExamDocumentRecord, ExamSourceRecord } from '../../exam-cache.js';
import {
  BUILTIN_EXAM_SOURCES,
  discoverExamSources,
  downloadNoticePdf,
  fetchNoticeDocument,
  selectSourcesForCourse,
} from './notice-sources.js';
import { parseExamPdf } from './pdf-parser.js';

export interface SyncExamSchedulesInput {
  term: string;
  exam_type: 'final';
  course_id?: number;
  force?: boolean;
  source_url?: string;
}

export interface SyncExamSchedulesResult {
  ok: boolean;
  term: string;
  exam_type: 'final';
  sources_checked: number;
  documents: Array<{
    document_id?: number;
    title: string;
    notice_url: string;
    attachment_url: string;
    diff_status: 'new' | 'unchanged' | 'updated';
    parsed_rows: number;
    local_pdf_path: string;
  }>;
  partial_failures: Array<{ scope: string; reason: string; retryable: boolean }>;
}

function sourceFromUrl(sourceUrl: string): ExamSourceRecord {
  const url = new URL(sourceUrl);
  if (url.hostname === 'ge.cau.ac.kr') {
    return {
      college: '교양대학',
      department: null,
      homepage_url: 'https://ge.cau.ac.kr/',
      notice_board_url: sourceUrl,
      adapter_type: 'ge_notice',
    };
  }
  if (url.hostname === 'cse.cau.ac.kr') {
    return {
      college: '소프트웨어대학',
      department: '소프트웨어학부',
      homepage_url: 'https://cse.cau.ac.kr/',
      notice_board_url: sourceUrl,
      adapter_type: 'cse_notice',
    };
  }
  return {
    college: url.hostname,
    department: null,
    homepage_url: url.origin,
    notice_board_url: sourceUrl,
    adapter_type: 'generic_notice',
  };
}

function makeDocumentRecord(
  input: SyncExamSchedulesInput,
  sourceId: number,
  fetched: Awaited<ReturnType<typeof downloadNoticePdf>>,
  diffStatus: 'new' | 'unchanged' | 'updated',
  fetchedAt: string,
): ExamDocumentRecord {
  return {
    term: input.term,
    exam_type: input.exam_type,
    source_id: sourceId,
    notice_url: fetched.notice_url,
    title: fetched.title,
    posted_at: fetched.posted_at,
    body_hash: fetched.body_hash,
    attachment_url: fetched.attachment_url,
    attachment_name: fetched.attachment_name,
    file_hash: fetched.file_hash,
    local_pdf_path: fetched.local_pdf_path,
    diff_status: diffStatus,
    fetched_at: fetchedAt,
  };
}

async function resolveSources(cache: ExamCache, input: SyncExamSchedulesInput): Promise<{
  sources: ExamSourceRecord[];
  issues: SyncExamSchedulesResult['partial_failures'];
}> {
  if (input.source_url) {
    return { sources: [sourceFromUrl(input.source_url)], issues: [] };
  }

  const discovered = await discoverExamSources();
  for (const source of discovered.sources) cache.upsertExamSource(source);

  const stored = cache.listExamSources();
  const merged = stored.length > 0 ? stored : BUILTIN_EXAM_SOURCES;
  const course = input.course_id !== undefined ? cache.getCourseMetadata(input.course_id) : undefined;
  return {
    sources: selectSourcesForCourse(merged, course),
    issues: discovered.issues,
  };
}

export async function syncExamSchedules(
  cache: ExamCache,
  input: SyncExamSchedulesInput,
): Promise<SyncExamSchedulesResult> {
  const fetchedAt = new Date().toISOString();
  const partialFailures: SyncExamSchedulesResult['partial_failures'] = [];
  const documents: SyncExamSchedulesResult['documents'] = [];
  const resolved = await resolveSources(cache, input);
  partialFailures.push(...resolved.issues);

  for (const source of resolved.sources) {
    const sourceId = cache.upsertExamSource(source);
    try {
      const parsedNotice = await fetchNoticeDocument(source);
      if (!parsedNotice) {
        cache.updateExamSourceStatus(sourceId, 'no_exam_document', fetchedAt, null);
        continue;
      }

      const downloaded = await downloadNoticePdf(parsedNotice, {
        term: input.term,
        exam_type: input.exam_type,
      });
      const previous = cache.findExamDocument(input.term, input.exam_type, downloaded.attachment_url);
      const diffStatus: 'new' | 'unchanged' | 'updated' = previous
        ? (previous.file_hash === downloaded.file_hash && previous.body_hash === downloaded.body_hash ? 'unchanged' : 'updated')
        : 'new';

      const documentId = cache.upsertExamDocument(makeDocumentRecord(input, sourceId, downloaded, diffStatus, fetchedAt));
      let parsedRows = 0;
      if (input.force || diffStatus !== 'unchanged') {
        const parsedPdf = await parseExamPdf(downloaded.local_pdf_path, {
          term: input.term,
          exam_type: input.exam_type,
        });
        if (parsedPdf.ok) {
          cache.replaceSchedules(documentId, parsedPdf.schedules);
          parsedRows = parsedPdf.schedules.length;
        } else {
          partialFailures.push({
            scope: downloaded.local_pdf_path,
            reason: `${parsedPdf.error_code}: ${parsedPdf.message}`,
            retryable: parsedPdf.retryable,
          });
        }
      }

      documents.push({
        document_id: documentId,
        title: downloaded.title,
        notice_url: downloaded.notice_url,
        attachment_url: downloaded.attachment_url,
        diff_status: diffStatus,
        parsed_rows: parsedRows,
        local_pdf_path: downloaded.local_pdf_path,
      });
      cache.updateExamSourceStatus(sourceId, 'ok', fetchedAt, null);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      partialFailures.push({ scope: source.notice_board_url, reason, retryable: true });
      cache.updateExamSourceStatus(sourceId, 'failed', fetchedAt, reason);
    }
  }

  return {
    ok: documents.length > 0,
    term: input.term,
    exam_type: input.exam_type,
    sources_checked: resolved.sources.length,
    documents,
    partial_failures: partialFailures,
  };
}
