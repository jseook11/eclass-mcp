import type { CachedCourse, DownloadRecord } from '../file-cache.js';

export interface DownloadStatusSummaryRow {
  course_id: number;
  course_name: string;
  file_count: number;
  total_size_bytes: number;
  last_downloaded_at: string | null;
}

export interface DownloadStatusSummary {
  mode: 'summary';
  courses: DownloadStatusSummaryRow[];
  total_file_count: number;
  total_size_bytes: number;
}

export interface DownloadStatusDetail {
  mode: 'detail';
  course_id: number;
  course_name: string;
  downloads: DownloadRecord[];
  total_file_count: number;
  total_size_bytes: number;
}

export type DownloadStatusResult = DownloadStatusSummary | DownloadStatusDetail;

function getCourseName(courseId: number, courseNames: Map<number, string>): string {
  return courseNames.get(courseId) ?? `course_id: ${courseId}`;
}

export function getDownloadStatus(
  downloads: DownloadRecord[],
  cachedCourses: CachedCourse[],
  courseId?: number,
): DownloadStatusResult {
  const courseNames = new Map<number, string>(
    cachedCourses.map((course) => [course.course_id, course.name]),
  );

  if (courseId !== undefined) {
    const totalSizeBytes = downloads.reduce((sum, record) => sum + record.size_bytes, 0);
    return {
      mode: 'detail',
      course_id: courseId,
      course_name: getCourseName(courseId, courseNames),
      downloads,
      total_file_count: downloads.length,
      total_size_bytes: totalSizeBytes,
    };
  }

  const grouped = new Map<number, DownloadStatusSummaryRow>();
  for (const record of downloads) {
    const existing = grouped.get(record.course_id);
    if (existing) {
      existing.file_count += 1;
      existing.total_size_bytes += record.size_bytes;
      if (!existing.last_downloaded_at || record.downloaded_at > existing.last_downloaded_at) {
        existing.last_downloaded_at = record.downloaded_at;
      }
      continue;
    }

    grouped.set(record.course_id, {
      course_id: record.course_id,
      course_name: getCourseName(record.course_id, courseNames),
      file_count: 1,
      total_size_bytes: record.size_bytes,
      last_downloaded_at: record.downloaded_at,
    });
  }

  const courses = Array.from(grouped.values()).sort((a, b) => {
    if (a.course_name === b.course_name) return a.course_id - b.course_id;
    return a.course_name.localeCompare(b.course_name, 'ko');
  });

  return {
    mode: 'summary',
    courses,
    total_file_count: downloads.length,
    total_size_bytes: downloads.reduce((sum, record) => sum + record.size_bytes, 0),
  };
}
