import type { ExamCache, ExamScheduleMatch } from '../../exam-cache.js';
import { syncExamSchedules } from './sync-exam-schedules.js';

export interface GetExamScheduleInput {
  course_id?: number;
  query?: string;
  term?: string;
  exam_type?: 'final';
  refresh?: boolean;
}

export type GetExamScheduleResult = {
  ok: true;
  mode: 'local' | 'refreshed';
  matches: ExamScheduleMatch[];
  // 매칭 경로. 'exact'는 course_code+section, 'name_section'은 교양 PDF처럼
  // course_code가 없는 소스에서 강의명+분반(정규화)으로 잡은 경우.
  matched_by?: 'exact' | 'name_section';
  refresh_result?: Awaited<ReturnType<typeof syncExamSchedules>>;
} | {
  ok: false;
  mode: 'local' | 'refreshed';
  reason: 'EXACT_MATCH_NOT_FOUND' | 'COURSE_METADATA_NOT_FOUND' | 'REFRESH_REQUIRES_TERM' | 'NO_SCHEDULES';
  course_metadata?: {
    course_id: number;
    course_name?: string;
    course_code?: string | null;
    section?: string | null;
    college?: string | null;
    department?: string | null;
    source?: string;
    sis_error?: string | null;
    canvas_course_code?: string | null;
    canvas_sis_course_id?: string | null;
    canvas_account_name?: string | null;
  };
  // exact match 실패 시 해당 term + exam_type의 전체 후보. 호출자 LLM이 직접 판단한다.
  candidates: ExamScheduleMatch[];
  refresh_result?: Awaited<ReturnType<typeof syncExamSchedules>>;
};

export async function getExamSchedule(
  cache: ExamCache,
  input: GetExamScheduleInput,
): Promise<GetExamScheduleResult> {
  let refreshResult: Awaited<ReturnType<typeof syncExamSchedules>> | undefined;
  const examType = input.exam_type ?? 'final';
  const mode = input.refresh ? 'refreshed' as const : 'local' as const;

  if (input.refresh) {
    if (!input.term) {
      return { ok: false, mode: 'local', reason: 'REFRESH_REQUIRES_TERM', candidates: [] };
    }
    refreshResult = await syncExamSchedules(cache, {
      term: input.term,
      exam_type: examType,
      course_id: input.course_id,
    });
  }
  const withRefresh = refreshResult ? { refresh_result: refreshResult } : {};

  if (input.course_id !== undefined) {
    const metadata = cache.getCourseMetadata(input.course_id);
    const candidates = cache.listSchedules({ term: input.term, exam_type: examType });
    if (!metadata) {
      return {
        ok: false,
        mode,
        reason: 'COURSE_METADATA_NOT_FOUND',
        course_metadata: { course_id: input.course_id },
        candidates,
        ...withRefresh,
      };
    }

    const metadataSummary = {
      course_id: metadata.course_id,
      course_name: metadata.course_name,
      course_code: metadata.course_code ?? null,
      section: metadata.section ?? null,
      college: metadata.college ?? null,
      department: metadata.department ?? null,
      source: metadata.source,
      sis_error: metadata.sis_error ?? null,
      canvas_course_code: metadata.canvas_course_code ?? null,
      canvas_sis_course_id: metadata.canvas_sis_course_id ?? null,
      canvas_account_name: metadata.canvas_account_name ?? null,
    };

    if (metadata.course_code && metadata.section) {
      const exact = cache.findSchedulesExact({
        course_code: metadata.course_code,
        section: metadata.section,
        term: input.term,
        exam_type: examType,
      });
      if (exact.length > 0) {
        return { ok: true, mode, matches: exact, matched_by: 'exact', ...withRefresh };
      }
    }

    // 교양대학 과목은 교양 PDF에 course_code가 없어 exact match가 구조적으로 불가능하다.
    // 강의명 + 분반(정규화)으로 fallback 매칭한다. 그 외 단과대(canvas_only 미확정 포함)는
    // 오매칭 위험이 있어 기존대로 candidates 전체를 반환해 호출자가 판단하게 둔다.
    if (metadata.college === '교양대학' && metadata.course_name) {
      const byNameSection = cache.findSchedulesByNameSection({
        course_name: metadata.course_name,
        section: metadata.section,
        term: input.term,
        exam_type: examType,
      });
      if (byNameSection.length > 0) {
        return { ok: true, mode, matches: byNameSection, matched_by: 'name_section', ...withRefresh };
      }
    }

    return {
      ok: false,
      mode,
      reason: 'EXACT_MATCH_NOT_FOUND',
      course_metadata: metadataSummary,
      candidates,
      ...withRefresh,
    };
  }

  const matches = cache.listSchedules({
    term: input.term,
    exam_type: examType,
    query: input.query,
  });
  if (matches.length === 0) {
    return {
      ok: false,
      mode,
      reason: 'NO_SCHEDULES',
      candidates: cache.listSchedules({ term: input.term, exam_type: examType }),
      ...withRefresh,
    };
  }
  return { ok: true, mode, matches, ...withRefresh };
}
