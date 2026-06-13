import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { BrowserSession } from './browser-session.js';
import { FileCache } from './file-cache.js';
import type { CachedCourse } from './file-cache.js';
import { ExamCache } from './exam-cache.js';
import { getCourses } from './tools/get-courses.js';
import { getAssignments } from './tools/get-assignments.js';
import { getAnnouncements } from './tools/get-announcements.js';
import { getMaterials, isGetMaterialsToolError } from './tools/get-materials.js';
import type { MaterialSource } from './tools/get-materials.js';
import { getDownloadStatus } from './tools/get-download-status.js';
import { getAssignmentDetail } from './tools/get-assignment-detail.js';
import { getGrades } from './tools/get-grades.js';
import { searchDownloads } from './tools/search-downloads.js';
import { exportCourseSnapshot } from './tools/export-snapshot.js';
import { submitAssignment } from './tools/submit-assignment.js';
import { downloadOne } from './tools/download.js';
import { downloadMaterialsBatch } from './tools/download-batch.js';
import { downloadVideo } from './tools/download-video.js';
import { syncCourseMetadata } from './tools/exams/course-metadata.js';
import { syncExamSchedules } from './tools/exams/sync-exam-schedules.js';
import { getExamSchedule } from './tools/exams/get-exam-schedule.js';
import { listExamSources } from './tools/exams/list-exam-sources.js';
import { searchSyllabusList, getSyllabus } from './mportal-client.js';
import { runDoctor } from './doctor.js';
import { getEclassPassword, getSecretEnvWarning } from './secrets.js';
import { sanitizeDebug } from './errors.js';

// --- Process safety net ---
// stdio MCP 서버는 unhandled rejection 하나로 전체 세션이 죽으면 안 된다.
// (예: Playwright waitForResponse가 컨텍스트 종료 후 늦게 reject되는 경우)
process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  process.stderr.write(`[eclass-mcp] Unhandled rejection: ${sanitizeDebug(message)}\n`);
});
process.on('uncaughtException', (err) => {
  process.stderr.write(`[eclass-mcp] Uncaught exception: ${sanitizeDebug(err.message)}\n`);
});

// --- Auth init ---
const username = process.env.ECLASS_USERNAME;
if (!username) {
  process.stderr.write(
    '[eclass-mcp] ERROR: ECLASS_USERNAME이 설정되지 않았습니다.\n' +
    '  eclass MCP 설정을 위해 다음을 실행하세요:\n' +
    '  npm -C .worktrees/mcp-eclass/mcp-server run setup\n',
  );
  process.exit(1);
}

if (process.env.ECLASS_PASSWORD) {
  process.stderr.write(getSecretEnvWarning('ECLASS_PASSWORD', '비밀번호') ?? '');
}

// Password factory — read from Keychain at login time only, not stored in memory
const credentialFactory = (): Promise<string> => {
  return getEclassPassword(username);
};

const session = new BrowserSession(username, credentialFactory);
const fileCache = new FileCache();
const examCache = new ExamCache();

// --- Server setup ---
const server = new Server(
  { name: 'eclass-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

// --- Tool schemas ---
const GetCoursesSchema = z.object({});
const GetCachedCoursesSchema = z.object({
  course_id: z.number().int().positive().optional(),
});
const DoctorSchema = z.object({});

const GetAssignmentsSchema = z.object({
  course_id: z.number().int().positive().optional(),
  days_ahead: z.number().int().min(1).max(365).optional().default(30),
  include_submitted: z.boolean().optional().default(true),
});

const GetAnnouncementsSchema = z.object({
  course_id: z.number().int().positive(),
  limit: z.number().int().min(1).max(100).optional().default(20),
});

const GetMaterialsSchema = z.object({
  course_id: z.number().int().positive(),
  sources: z.array(z.enum(['modules', 'files', 'courseresource', 'external', 'modulebuilder', 'announcements'])).nonempty().optional(),
});

const GetDownloadFileSchema = z.object({
  file_id: z.string().min(1).max(256),
  course_id: z.number().int().positive(),
  url: z.string().url().nullable().optional(),  // null for courseresource files (Playwright download)
  display_name: z.string().min(1).max(512),
  type: z.string().min(1).max(256).optional(),
});

const ListDownloadsSchema = z.object({
  course_id: z.number().int().positive().optional(),
});

const DownloadStatusSchema = z.object({
  course_id: z.number().int().positive().optional(),
});

const RemoveDownloadSchema = z.object({
  file_id: z.string().min(1).max(256).optional(),
  course_id: z.number().int().positive().optional(),
});

const GetAssignmentDetailSchema = z.object({
  course_id: z.number().int().positive(),
  assignment_id: z.number().int().positive(),
});

const GetGradesSchema = z.object({
  course_id: z.number().int().positive().optional(),
  include_assignments: z.boolean().optional().default(true),
});

const SubmitAssignmentSchema = z.object({
  course_id: z.number().int().positive(),
  assignment_id: z.number().int().positive(),
  file_paths: z.array(z.string().min(1).max(2048)).min(1).max(20).optional(),
  body: z.string().min(1).max(200000).optional(),
  comment: z.string().max(10000).optional(),
  dry_run: z.boolean().optional().default(true),
  confirm_resubmit: z.boolean().optional().default(false),
});

const SearchDownloadsSchema = z.object({
  course_id: z.number().int().positive().optional(),
  query: z.string().min(1).max(256).optional(),
  extension: z.string().min(1).max(32).optional(),
  source: z.string().min(1).max(64).optional(),
  downloaded_after: z.string().min(1).max(64).optional(),
  downloaded_before: z.string().min(1).max(64).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

const DownloadBatchSchema = z.object({
  course_id: z.number().int().positive(),
  materials: z.array(z.object({
    file_id: z.string().min(1).max(256),
    url: z.string().url().nullable().optional(),
    display_name: z.string().min(1).max(512),
    type: z.string().min(1).max(256).optional(),
    source: z.string().min(1).max(64).optional(),
  })).min(1).max(200),
  continue_on_error: z.boolean().optional().default(true),
});

const DownloadVideoSchema = z.object({
  video_id: z.string().min(1).max(256),
  course_id: z.number().int().positive(),
  url: z.string().url(),
  display_name: z.string().min(1).max(512),
  type: z.string().min(1).max(256).optional(),
  source: z.string().min(1).max(64).optional(),
});

const ExportSnapshotSchema = z.object({
  course_id: z.number().int().positive(),
  format: z.enum(['json', 'markdown']).optional().default('json'),
  include_grades: z.boolean().optional().default(false),
  output_path: z.string().min(1).max(1024).optional(),
  overwrite: z.boolean().optional().default(false),
});

const SyncCourseMetadataSchema = z.object({
  course_id: z.number().int().positive().optional(),
  force: z.boolean().optional().default(false),
});

const SyncExamSchedulesSchema = z.object({
  term: z.string().min(1).max(32),
  exam_type: z.enum(['final']).optional().default('final'),
  course_id: z.number().int().positive().optional(),
  force: z.boolean().optional().default(false),
  source_url: z.string().url().optional(),
});

const GetExamScheduleSchema = z.object({
  course_id: z.number().int().positive().optional(),
  query: z.string().min(1).max(256).optional(),
  term: z.string().min(1).max(32).optional(),
  exam_type: z.enum(['final']).optional().default('final'),
  refresh: z.boolean().optional().default(false),
});

const ListExamSourcesSchema = z.object({
  refresh: z.boolean().optional().default(false),
});

const SearchSyllabusSchema = z.object({
  year: z.string().optional(),
  term: z.string().optional(),
  query: z.string().min(1),
  by: z.enum(['subject', 'professor']).optional().default('subject'),
});
const GetSyllabusSchema = z.object({
  year: z.string().min(1),
  term: z.string().min(1),
  sbjtno1: z.string().min(1),
  clssno1: z.string().min(1),
  campcd: z.string().optional(),
  sust: z.string().optional(),
});

// --- List tools handler ---
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'eclass_get_courses',
        description: '[네트워크] 수강 중인 강의 목록을 e-Class에서 새로 가져오고 로컬 캐시를 갱신합니다. course_id ↔ 강의명 매핑이 목적이면 네트워크 없는 eclass_get_courses_cached를 먼저 사용하세요.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'eclass_get_courses_cached',
        description: '[로컬] 캐시에 저장된 강의 목록을 조회합니다. 네트워크 호출 없이 course_id ↔ 강의명 매핑에 사용. 캐시가 비어 있거나 학기가 바뀐 경우에만 eclass_get_courses로 갱신하세요.',
        inputSchema: {
          type: 'object',
          properties: {
            course_id: { type: 'number', description: '특정 강의 ID만 조회' },
          },
        },
      },
      {
        name: 'eclass_doctor',
        description: '[로컬] 진단 도구. Playwright Chromium 실행 가능 여부를 빠르게 확인합니다. 다른 도구가 인증/브라우저 오류로 실패할 때 원인 파악용으로 사용하세요.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'eclass_get_assignments',
        description: '[네트워크] 과제 및 퀴즈 목록을 가져옵니다. course_id 지정 시 submission_types가 포함되며(external_tool=LTI 과제는 API 제출 불가), days_ahead 상한 없이 해당 강의의 미래 마감 과제가 전부 반환됩니다.',
        inputSchema: {
          type: 'object',
          properties: {
            course_id: { type: 'number', description: '강의 ID (생략하면 전체 강의)' },
            days_ahead: { type: 'number', description: '몇 일 이내 마감 과제를 가져올지 (기본값: 30)', default: 30 },
            include_submitted: { type: 'boolean', description: '제출한 과제 포함 여부 (기본값: true)', default: true },
          },
        },
      },
      {
        name: 'eclass_get_assignment_detail',
        description: '[네트워크] 단일 과제의 상세 정보를 가져옵니다 (제출 유형, 마감/잠금 일시, 배점, 허용 확장자, 제출 여부/일시, 시도 횟수, 점수). 과제 제출 전 확인용.',
        inputSchema: {
          type: 'object',
          properties: {
            course_id: { type: 'number', description: '강의 ID' },
            assignment_id: { type: 'number', description: '과제 ID (eclass_get_assignments의 url에서 확인하거나 과제 목록 참고)' },
          },
          required: ['course_id', 'assignment_id'],
        },
      },
      {
        name: 'eclass_get_grades',
        description: '[네트워크] 성적을 가져옵니다. 강의 단위 점수(current/final)와 과제별 점수/제출여부/채점일시를 포함합니다.',
        inputSchema: {
          type: 'object',
          properties: {
            course_id: { type: 'number', description: '특정 강의만 조회 (생략하면 전체 강의)' },
            include_assignments: { type: 'boolean', description: '과제별 점수 포함 여부 (기본값: true)', default: true },
          },
        },
      },
      {
        name: 'eclass_sync_course_metadata',
        description: '[네트워크] 시험 시간표 매칭용 강의 메타데이터를 동기화합니다. LearningX SIS(개설강좌 정보)에서 개설대학/학과/교수/과목코드/분반 확정값을 받아 저장하고(source=learningx_sis), SIS 조회 실패 시 Canvas 기본 정보만 보존합니다(source=canvas_only, sis_error 포함).',
        inputSchema: {
          type: 'object',
          properties: {
            course_id: { type: 'number', description: '특정 강의만 동기화 (생략하면 현재 수강 강의 전체)' },
            force: { type: 'boolean', description: '기존 캐시가 있어도 다시 조회 (기본값: false)', default: false },
          },
        },
      },
      {
        name: 'eclass_sync_exam_schedules',
        description: '[네트워크] 기말고사 공지 소스를 확인하고 PDF 시간표를 다운로드/정규화해 별도 시험 DB에 저장합니다. pdftotext가 없으면 문서만 저장하고 파싱 실패를 partial_failures에 남깁니다.',
        inputSchema: {
          type: 'object',
          properties: {
            term: { type: 'string', description: '학기 식별자 (예: 2026-1)' },
            exam_type: { type: 'string', enum: ['final'], description: '시험 종류 (v1은 final만 지원)', default: 'final' },
            course_id: { type: 'number', description: '특정 강의에 관련된 소스 우선 동기화' },
            force: { type: 'boolean', description: '문서 해시가 같아도 재파싱 (기본값: false)', default: false },
            source_url: { type: 'string', description: '특정 공지 URL만 동기화' },
          },
          required: ['term'],
        },
      },
      {
        name: 'eclass_get_exam_schedule',
        description: '[로컬] 저장된 시험 시간표를 조회합니다. course_id 지정 시 SIS 확정 course_code+분반 exact match를 우선하며, 교양대학 과목(course_code가 PDF에 없음)은 강의명+분반 정규화 매칭으로 fallback합니다(matched_by로 구분). 모두 실패하면 reason=EXACT_MATCH_NOT_FOUND와 함께 해당 term/exam_type의 전체 후보 목록(candidates)을 반환하므로 호출자가 직접 판단하세요. refresh=true와 term을 함께 주면 먼저 네트워크 동기화 후 조회합니다.',
        inputSchema: {
          type: 'object',
          properties: {
            course_id: { type: 'number', description: '강의 ID로 조회' },
            query: { type: 'string', description: '강의명/교수명/과목코드 검색어' },
            term: { type: 'string', description: '학기 필터 (예: 2026-1)' },
            exam_type: { type: 'string', enum: ['final'], description: '시험 종류 (기본값: final)', default: 'final' },
            refresh: { type: 'boolean', description: '조회 전 시험 공지 동기화 수행. true면 term 필요', default: false },
          },
        },
      },
      {
        name: 'eclass_list_exam_sources',
        description: '[로컬/네트워크] 시험 공지 소스 목록을 조회합니다. refresh=true면 중앙대 대학 목록에서 단과대 후보를 갱신합니다.',
        inputSchema: {
          type: 'object',
          properties: {
            refresh: { type: 'boolean', description: '공지 소스 후보를 다시 탐색 (기본값: false)', default: false },
          },
        },
      },
      {
        name: 'eclass_search_syllabus',
        description: '[mportal] 강의계획서를 검색합니다. year/term 미지정 시 현재 학기. 후보 목록(학수번호·분반·강의명·교수·단과대·강의시간)을 반환하니 호출자가 판단해 eclass_get_syllabus로 상세를 받으세요.',
        inputSchema: {
          type: 'object',
          properties: {
            year: { type: 'string', description: '개설년도(예: 2026). 미지정 시 현재 학기' },
            term: { type: 'string', description: '학기 코드(1/2/S/W). 미지정 시 현재 학기' },
            query: { type: 'string', description: '검색어(과목명 또는 교수명)' },
            by: { type: 'string', enum: ['subject', 'professor'], default: 'subject' },
          },
          required: ['query'],
        },
      },
      {
        name: 'eclass_get_syllabus',
        description: '[mportal] 특정 강의의 강의계획서 본문을 구조화해 반환합니다(교재·평가비율·주차일정·교수정보 등). 입력 키는 eclass_search_syllabus 결과 행을 그대로 넘기세요.',
        inputSchema: {
          type: 'object',
          properties: {
            year: { type: 'string' },
            term: { type: 'string' },
            sbjtno1: { type: 'string', description: '학수번호' },
            clssno1: { type: 'string', description: '분반' },
            campcd: { type: 'string' },
            sust: { type: 'string' },
          },
          required: ['year', 'term', 'sbjtno1', 'clssno1'],
        },
      },
      {
        name: 'eclass_submit_assignment',
        description: '[네트워크] 과제를 제출합니다. 기본 dry_run=true로 실제 제출하지 않고 검증만 수행하며, 재제출은 confirm_resubmit=true가 필요합니다. online_upload(file_paths)/online_text_entry(body)만 지원 — submission_types가 external_tool(LTI)인 과제는 제출 불가하므로 eclass_get_assignment_detail로 먼저 확인하세요. API 실패 시 UI 폴백은 단일 파일만 지원합니다.',
        inputSchema: {
          type: 'object',
          properties: {
            course_id: { type: 'number', description: '강의 ID' },
            assignment_id: { type: 'number', description: '과제 ID' },
            file_paths: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
              description: '업로드할 로컬 파일 경로 목록 (online_upload)',
            },
            body: { type: 'string', description: '본문 제출 내용 (online_text_entry)' },
            comment: { type: 'string', description: '제출 코멘트' },
            dry_run: { type: 'boolean', description: 'true면 실제 제출하지 않고 검증만 수행 (기본값: true)', default: true },
            confirm_resubmit: { type: 'boolean', description: '이미 제출된 과제 재제출 확인 플래그', default: false },
          },
          required: ['course_id', 'assignment_id'],
        },
      },
      {
        name: 'eclass_search_downloads',
        description: '[로컬] 다운로드된 파일을 필터 검색합니다 (파일명/강의명/확장자/source/다운로드 날짜 범위). 전체 나열은 eclass_list_downloads, 강의별 요약은 eclass_get_download_status를 사용하세요.',
        inputSchema: {
          type: 'object',
          properties: {
            course_id: { type: 'number', description: '강의 ID 필터' },
            query: { type: 'string', description: '파일명 또는 강의명에 대한 부분 일치 (대소문자 무시)' },
            extension: { type: 'string', description: '확장자 필터 (예: "pdf" 또는 ".pdf")' },
            source: { type: 'string', description: '자료 출처 필터 (modules/files/courseresource 등). source가 기록된 항목만 매칭됨' },
            downloaded_after: { type: 'string', description: '이 일시 이후 다운로드 (ISO, 포함)' },
            downloaded_before: { type: 'string', description: '이 일시 이전 다운로드 (ISO, 포함)' },
            limit: { type: 'number', description: '최대 결과 수 (기본값: 50)' },
          },
        },
      },
      {
        name: 'eclass_export_course_snapshot',
        description: '[네트워크] 한 강의의 현재 상태(강의 정보, 과제, 공지, 자료, 다운로드 현황, 선택적 성적)를 한 번에 JSON 또는 Markdown으로 내보냅니다. 강의 전반을 훑을 때는 개별 조회 여러 번 대신 이 도구 1회를 사용하세요. output_path 지정 시 파일로 저장(기존 파일은 overwrite=true 없이는 거부).',
        inputSchema: {
          type: 'object',
          properties: {
            course_id: { type: 'number', description: '강의 ID' },
            format: { type: 'string', enum: ['json', 'markdown'], description: '출력 형식 (기본값: json)', default: 'json' },
            include_grades: { type: 'boolean', description: '성적 포함 여부 (기본값: false)', default: false },
            output_path: { type: 'string', description: '저장 경로 (생략하면 결과에 직접 반환)' },
            overwrite: { type: 'boolean', description: 'output_path에 기존 파일이 있을 때 덮어쓸지 여부 (기본값: false — 거부)', default: false },
          },
          required: ['course_id'],
        },
      },
      {
        name: 'eclass_get_announcements',
        description: '[네트워크] 강의 공지사항을 가져옵니다',
        inputSchema: {
          type: 'object',
          properties: {
            course_id: { type: 'number', description: '강의 ID' },
            limit: { type: 'number', description: '가져올 공지사항 수 (기본값: 20)', default: 20 },
          },
          required: ['course_id'],
        },
      },
      {
        name: 'eclass_get_materials',
        description: '[네트워크] 강의 자료를 가져옵니다 (모듈, 파일함, 강의자료실, 외부도구). 반환값은 { ok, course_id, sources, materials, errors, warnings } JSON 객체이며, 일부 source 실패 시 성공한 자료와 실패 정보를 함께 반환합니다. materials 항목은 eclass_download_file/eclass_download_materials_batch에 그대로 전달할 수 있습니다.',
        inputSchema: {
          type: 'object',
          properties: {
            course_id: { type: 'number', description: '강의 ID' },
            sources: {
              type: 'array',
              items: { type: 'string', enum: ['modules', 'files', 'courseresource', 'external', 'modulebuilder', 'announcements'] },
              minItems: 1,
              description: '가져올 소스 (생략하면 전부: modules, files, courseresource, external, modulebuilder, announcements)',
            },
          },
          required: ['course_id'],
        },
      },
      {
        name: 'eclass_download_file',
        description: '[네트워크] 강의 파일을 로컬에 다운로드합니다. 이미 다운로드된 파일은 건너뜁니다. 동영상은 eclass_download_video를 사용하세요.',
        inputSchema: {
          type: 'object',
          properties: {
            file_id: { type: 'string', description: 'Canvas 파일 ID' },
            course_id: { type: 'number', description: '강의 ID' },
            url: { type: 'string', description: '다운로드 URL (courseresource 파일은 null 허용 — Playwright로 다운로드)' },
            display_name: { type: 'string', description: '저장할 파일명' },
            type: { type: 'string', description: '자료 유형. mp4/video/m3u8 계열은 파일 도구에서 거부되며 eclass_download_video 대상입니다.' },
          },
          required: ['file_id', 'course_id', 'url', 'display_name'],
        },
      },
      {
        name: 'eclass_download_materials_batch',
        description: '[네트워크] 여러 파일 자료를 한 번에 다운로드합니다 (부분 성공 지원). eclass_get_materials가 반환한 materials 항목을 그대로 전달하면 됩니다. 동영상 자료는 eclass_download_video로 별도 처리합니다.',
        inputSchema: {
          type: 'object',
          properties: {
            course_id: { type: 'number', description: '강의 ID' },
            materials: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  file_id: { type: 'string' },
                  url: { type: 'string', description: 'null/생략 시 courseresource(Playwright) 경로' },
                  display_name: { type: 'string' },
                  type: { type: 'string', description: 'mp4/video 계열은 파일 도구에서 실패 처리되며 eclass_download_video 대상' },
                  source: { type: 'string', description: '자료 출처 (캐시에 기록됨)' },
                },
                required: ['file_id', 'display_name'],
              },
              minItems: 1,
              description: '다운로드할 자료 목록',
            },
            continue_on_error: { type: 'boolean', description: '실패해도 계속 진행 (기본값: true). false면 첫 실패에서 중단', default: true },
          },
          required: ['course_id', 'materials'],
        },
      },
      {
        name: 'eclass_download_video',
        description: '[네트워크] OCS UniPlayer MP4 동영상을 검증 후 로컬에 다운로드합니다 (제한시간 30분). HLS/m3u8/DRM/진도 추적형 영상은 지원하지 않습니다. 캐시에는 file_id="video:<video_id>"로 기록되므로 재다운로드 시 eclass_remove_download에 이 형식을 사용하세요.',
        inputSchema: {
          type: 'object',
          properties: {
            video_id: { type: 'string', description: '동영상 ID 또는 material id (캐시 키로 사용)' },
            course_id: { type: 'number', description: '강의 ID' },
            url: { type: 'string', description: 'https://ocs.cau.ac.kr/em/<content_id> 형식의 OCS 뷰어 URL' },
            display_name: { type: 'string', description: '저장할 파일명 (.mp4 없으면 자동 추가)' },
            type: { type: 'string', description: '자료 유형 (참고용)' },
            source: { type: 'string', description: '자료 출처 (캐시에 기록됨)' },
          },
          required: ['video_id', 'course_id', 'url', 'display_name'],
        },
      },
      {
        name: 'eclass_list_downloads',
        description: '[로컬] 다운로드 기록 전체를 나열합니다. 조건 검색은 eclass_search_downloads, 강의별 요약은 eclass_get_download_status를 사용하세요.',
        inputSchema: {
          type: 'object',
          properties: {
            course_id: { type: 'number', description: '강의 ID (생략하면 전체)' },
          },
        },
      },
      {
        name: 'eclass_get_download_status',
        description: '[로컬] 다운로드 현황을 강의별로 요약 조회합니다. 강의명은 로컬 course cache를 사용합니다.',
        inputSchema: {
          type: 'object',
          properties: {
            course_id: { type: 'number', description: '특정 강의 ID 상세 조회' },
          },
        },
      },
      {
        name: 'eclass_remove_download',
        description: '[로컬] 다운로드 기록(DB 레코드)만 삭제합니다 — 디스크의 파일은 남습니다. 삭제 후 재다운로드가 가능합니다. 영상 기록의 file_id는 "video:<video_id>" 형식입니다.',
        inputSchema: {
          type: 'object',
          properties: {
            file_id: { type: 'string', description: '특정 파일 ID 삭제' },
            course_id: { type: 'number', description: '강의의 모든 기록 삭제' },
          },
        },
      },
    ],
  };
});

// --- Call tool handler ---
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'eclass_get_courses': {
        const client = await session.getClient();
        const courses = await getCourses(client);
        fileCache.upsertCourses(courses);
        return {
          content: [{ type: 'text', text: JSON.stringify(courses) }],
        };
      }

      case 'eclass_get_courses_cached': {
        const parsed = GetCachedCoursesSchema.parse(args ?? {});
        const cached: CachedCourse[] = parsed.course_id !== undefined
          ? (fileCache.getCachedCourse(parsed.course_id) ? [fileCache.getCachedCourse(parsed.course_id)!] : [])
          : fileCache.listCachedCourses();
        const response = cached.map((course) => ({
          id: course.course_id,
          name: course.name,
          fetched_at: course.fetched_at,
        }));
        return {
          content: [{ type: 'text', text: JSON.stringify(response) }],
        };
      }

      case 'eclass_doctor': {
        DoctorSchema.parse(args ?? {});
        const results = await runDoctor(username);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              checked_at: new Date().toISOString(),
              checks: results,
            }),
          }],
        };
      }

      case 'eclass_get_assignments': {
        const client = await session.getClient();
        const parsed = GetAssignmentsSchema.parse(args ?? {});
        const assignments = await getAssignments(
          client,
          parsed.course_id,
          parsed.days_ahead,
          parsed.include_submitted,
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(assignments) }],
        };
      }

      case 'eclass_get_assignment_detail': {
        const client = await session.getClient();
        const parsed = GetAssignmentDetailSchema.parse(args ?? {});
        const result = await getAssignmentDetail(client, parsed.course_id, parsed.assignment_id);
        return {
          isError: result.ok === false,
          content: [{ type: 'text', text: JSON.stringify(result) }],
        };
      }

      case 'eclass_get_grades': {
        const client = await session.getClient();
        const parsed = GetGradesSchema.parse(args ?? {});
        const result = await getGrades(client, parsed.course_id, parsed.include_assignments);
        return {
          isError: !result.ok,
          content: [{ type: 'text', text: JSON.stringify(result) }],
        };
      }

      case 'eclass_sync_course_metadata': {
        const client = await session.getClient();
        const parsed = SyncCourseMetadataSchema.parse(args ?? {});
        const result = await syncCourseMetadata(examCache, client, parsed);
        return {
          isError: !result.ok,
          content: [{ type: 'text', text: JSON.stringify(result) }],
        };
      }

      case 'eclass_sync_exam_schedules': {
        const parsed = SyncExamSchedulesSchema.parse(args ?? {});
        if (parsed.course_id !== undefined && !examCache.getCourseMetadata(parsed.course_id)) {
          const client = await session.getClient();
          await syncCourseMetadata(examCache, client, { course_id: parsed.course_id });
        }
        const result = await syncExamSchedules(examCache, {
          term: parsed.term,
          exam_type: parsed.exam_type,
          course_id: parsed.course_id,
          force: parsed.force,
          source_url: parsed.source_url,
        });
        return {
          isError: !result.ok,
          content: [{ type: 'text', text: JSON.stringify(result) }],
        };
      }

      case 'eclass_get_exam_schedule': {
        const parsed = GetExamScheduleSchema.parse(args ?? {});
        if (parsed.course_id !== undefined && !examCache.getCourseMetadata(parsed.course_id)) {
          const client = await session.getClient();
          await syncCourseMetadata(examCache, client, { course_id: parsed.course_id });
        }
        const result = await getExamSchedule(examCache, {
          course_id: parsed.course_id,
          query: parsed.query,
          term: parsed.term,
          exam_type: parsed.exam_type,
          refresh: parsed.refresh,
        });
        return {
          isError: !result.ok,
          content: [{ type: 'text', text: JSON.stringify(result) }],
        };
      }

      case 'eclass_list_exam_sources': {
        const parsed = ListExamSourcesSchema.parse(args ?? {});
        const result = await listExamSources(examCache, parsed);
        return {
          isError: !result.ok,
          content: [{ type: 'text', text: JSON.stringify(result) }],
        };
      }

      case 'eclass_search_syllabus': {
        const parsed = SearchSyllabusSchema.parse(args ?? {});
        const result = await searchSyllabusList(session, parsed);
        return { isError: !result.ok, content: [{ type: 'text', text: JSON.stringify(result) }] };
      }

      case 'eclass_get_syllabus': {
        const parsed = GetSyllabusSchema.parse(args ?? {});
        const result = await getSyllabus(session, parsed);
        return { isError: !result.ok, content: [{ type: 'text', text: JSON.stringify(result) }] };
      }

      case 'eclass_submit_assignment': {
        const client = await session.getClient();
        const parsed = SubmitAssignmentSchema.parse(args ?? {});
        const result = await submitAssignment(client, session, parsed);
        return {
          isError: !result.ok,
          content: [{ type: 'text', text: JSON.stringify(result) }],
        };
      }

      case 'eclass_search_downloads': {
        const parsed = SearchDownloadsSchema.parse(args ?? {});
        const records = fileCache.list(parsed.course_id);
        const cachedCourses = fileCache.listCachedCourses();
        const result = searchDownloads(records, cachedCourses, parsed);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }

      case 'eclass_export_course_snapshot': {
        const client = await session.getClient();
        const parsed = ExportSnapshotSchema.parse(args ?? {});
        const result = await exportCourseSnapshot(
          { client, session, fileCache },
          {
            course_id: parsed.course_id,
            format: parsed.format,
            include_grades: parsed.include_grades,
            output_path: parsed.output_path,
            overwrite: parsed.overwrite,
          },
        );
        return {
          isError: !result.ok,
          content: [{ type: 'text', text: JSON.stringify(result) }],
        };
      }

      case 'eclass_get_announcements': {
        const client = await session.getClient();
        const parsed = GetAnnouncementsSchema.parse(args ?? {});
        const announcements = await getAnnouncements(client, parsed.course_id, parsed.limit);
        return {
          content: [{ type: 'text', text: JSON.stringify(announcements) }],
        };
      }

      case 'eclass_get_materials': {
        const client = await session.getClient();
        const parsed = GetMaterialsSchema.parse(args ?? {});
        const result = await getMaterials(
          client,
          session,
          parsed.course_id,
          parsed.sources as MaterialSource[] | undefined,
          fileCache,
        );
        return {
          isError: isGetMaterialsToolError(result),
          content: [{ type: 'text', text: JSON.stringify(result) }],
        };
      }

      case 'eclass_download_file': {
        const client = await session.getClient();
        const parsed = GetDownloadFileSchema.parse(args ?? {});

        const outcome = await downloadOne(
          { session, fileCache, token: client.getToken() },
          {
            file_id: parsed.file_id,
            course_id: parsed.course_id,
            url: parsed.url ?? null,
            display_name: parsed.display_name,
            type: parsed.type,
          },
        );

        if (outcome.status === 'failed') {
          return {
            isError: true,
            content: [{ type: 'text', text: `${outcome.message} (file_id=${outcome.file_id}, display_name=${outcome.display_name})` }],
          };
        }

        // Preserve the documented eclass_download_file output shape.
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              file_id: outcome.file_id,
              display_name: outcome.display_name,
              local_path: outcome.local_path,
              size_bytes: outcome.size_bytes,
              skipped: outcome.status === 'skipped',
            }),
          }],
        };
      }

      case 'eclass_download_materials_batch': {
        const client = await session.getClient();
        const parsed = DownloadBatchSchema.parse(args ?? {});
        const result = await downloadMaterialsBatch(
          { session, fileCache, token: client.getToken() },
          parsed.course_id,
          parsed.materials.map((m) => ({
            file_id: m.file_id,
            course_id: parsed.course_id,
            url: m.url ?? null,
            display_name: m.display_name,
            type: m.type,
            source: m.source,
          })),
          parsed.continue_on_error,
        );
        return {
          isError: !result.ok,
          content: [{ type: 'text', text: JSON.stringify(result) }],
        };
      }

      case 'eclass_download_video': {
        const parsed = DownloadVideoSchema.parse(args ?? {});
        const result = await downloadVideo(parsed, fileCache);
        return {
          isError: !result.ok,
          content: [{ type: 'text', text: JSON.stringify(result) }],
        };
      }

      case 'eclass_list_downloads': {
        const parsed = ListDownloadsSchema.parse(args ?? {});
        const records = fileCache.list(parsed.course_id);
        return { content: [{ type: 'text', text: JSON.stringify(records) }] };
      }

      case 'eclass_get_download_status': {
        const parsed = DownloadStatusSchema.parse(args ?? {});
        const records = fileCache.list(parsed.course_id);
        const cachedCourses = parsed.course_id !== undefined
          ? (fileCache.getCachedCourse(parsed.course_id) ? [fileCache.getCachedCourse(parsed.course_id)!] : [])
          : fileCache.listCachedCourses();
        const status = getDownloadStatus(records, cachedCourses, parsed.course_id);
        return { content: [{ type: 'text', text: JSON.stringify(status) }] };
      }

      case 'eclass_remove_download': {
        const parsed = RemoveDownloadSchema.parse(args ?? {});
        if (parsed.file_id) {
          const removed = fileCache.remove(parsed.file_id);
          return { content: [{ type: 'text', text: JSON.stringify({ removed, file_id: parsed.file_id }) }] };
        } else if (parsed.course_id !== undefined) {
          const count = fileCache.removeCourse(parsed.course_id);
          return { content: [{ type: 'text', text: JSON.stringify({ removed: count, course_id: parsed.course_id }) }] };
        } else {
          return { isError: true, content: [{ type: 'text', text: 'file_id 또는 course_id 중 하나를 지정해주세요' }] };
        }
      }

      default:
        return {
          isError: true,
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [{ type: 'text', text: sanitizeDebug(message) }],
    };
  }
});

// --- Connect transport ---
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('[eclass-mcp] Server running on stdio\n');
