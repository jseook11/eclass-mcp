import * as path from 'node:path';
import type { CachedCourse, DownloadRecord } from '../file-cache.js';

export interface SearchDownloadsInput {
  course_id?: number;
  query?: string;                 // matches filename OR course name (case-insensitive substring)
  extension?: string;             // e.g. "pdf" or ".pdf"
  source?: string;                // material source; only matches records saved with a source
  downloaded_after?: string;      // ISO date/datetime (inclusive)
  downloaded_before?: string;     // ISO date/datetime (inclusive)
  limit?: number;
}

export interface SearchDownloadMatch extends DownloadRecord {
  course_name: string | null;
  extension: string;
}

export interface SearchDownloadsResult {
  matches: SearchDownloadMatch[];
  total_matched: number;          // before limit
  limit: number;
}

const DEFAULT_LIMIT = 50;

function normalizeExtension(ext: string): string {
  const trimmed = ext.trim().toLowerCase();
  if (trimmed === '') return '';
  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
}

function recordExtension(record: DownloadRecord): string {
  return (path.extname(record.display_name) || path.extname(record.local_path)).toLowerCase();
}

function parseTime(value: string | undefined): number | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * Searches the local download cache only — no network. Date bounds are
 * inclusive; an unparseable bound is ignored (not an error).
 */
export function searchDownloads(
  records: DownloadRecord[],
  cachedCourses: CachedCourse[],
  input: SearchDownloadsInput,
): SearchDownloadsResult {
  const limit = input.limit && input.limit > 0 ? input.limit : DEFAULT_LIMIT;
  const courseNames = new Map<number, string>(cachedCourses.map((c) => [c.course_id, c.name]));

  const query = input.query?.trim().toLowerCase() ?? '';
  const wantExt = input.extension ? normalizeExtension(input.extension) : '';
  const wantSource = input.source?.trim().toLowerCase() ?? '';
  const after = parseTime(input.downloaded_after);
  const before = parseTime(input.downloaded_before);

  const matched: SearchDownloadMatch[] = [];

  for (const record of records) {
    if (input.course_id !== undefined && record.course_id !== input.course_id) continue;

    const courseName = courseNames.get(record.course_id) ?? null;

    if (query) {
      const haystack = `${record.display_name} ${courseName ?? ''}`.toLowerCase();
      if (!haystack.includes(query)) continue;
    }

    const ext = recordExtension(record);
    if (wantExt && ext !== wantExt) continue;

    if (wantSource && (record.source ?? '').toLowerCase() !== wantSource) continue;

    const downloadedAt = new Date(record.downloaded_at).getTime();
    if (after !== null && !Number.isNaN(downloadedAt) && downloadedAt < after) continue;
    if (before !== null && !Number.isNaN(downloadedAt) && downloadedAt > before) continue;

    matched.push({ ...record, course_name: courseName, extension: ext });
  }

  matched.sort((a, b) => b.downloaded_at.localeCompare(a.downloaded_at));

  return {
    matches: matched.slice(0, limit),
    total_matched: matched.length,
    limit,
  };
}
