import type { CallToolResult, Tool, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

type JsonObject = Record<string, unknown>;

const readOnlyTools = new Set([
  'eclass_get_courses',
  'eclass_get_courses_cached',
  'eclass_doctor',
  'eclass_get_assignments',
  'eclass_get_assignment_detail',
  'eclass_get_grades',
  'eclass_get_exam_schedule',
  'eclass_list_exam_sources',
  'eclass_search_syllabus',
  'eclass_get_syllabus',
  'eclass_search_downloads',
  'eclass_get_announcements',
  'eclass_get_materials',
  'eclass_list_downloads',
  'eclass_get_download_status',
  'eclass_file_handoff',
  'search',
  'fetch',
]);

const destructiveTools = new Set([
  'eclass_export_course_snapshot',
  'eclass_submit_assignment',
  'eclass_remove_download',
]);

function titleFromName(name: string): string {
  if (name === 'search') return 'Search eclass';
  if (name === 'fetch') return 'Fetch eclass document';
  return name
    .replace(/^eclass_/, '')
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function annotationsFor(name: string): ToolAnnotations {
  if (readOnlyTools.has(name)) {
    return {
      title: titleFromName(name),
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    };
  }

  return {
    title: titleFromName(name),
    readOnlyHint: false,
    destructiveHint: destructiveTools.has(name),
    idempotentHint: false,
    openWorldHint: false,
  };
}

export const standardSearchTool: Tool = {
  name: 'search',
  title: 'Search eclass',
  description: '[표준] eclass 강의, 과제, 공지, 자료, 강의계획서, MCP 서버 로컬 다운로드 기록을 통합 검색합니다. ChatGPT/connector 호환용 read-only search 도구입니다. 다운로드 기록은 파일 본문이 아니라 서버 측 file_id/local_path 메타데이터입니다. ChatGPT가 파일 내용을 보려면 fetch 또는 eclass_file_handoff로 공개 /files/<token> URL을 받은 뒤 그 URL을 브라우징으로 직접 열어야 합니다. 공지/자료 본문 스캔은 비용 제어를 위해 검색어가 강의명과 일치하는 일부 강의로 제한됩니다.',
  annotations: annotationsFor('search'),
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '검색어' },
    },
    required: ['query'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            url: { type: 'string' },
          },
          required: ['id', 'title', 'url'],
        },
      },
    },
    required: ['results'],
  },
};

export const standardFetchTool: Tool = {
  name: 'fetch',
  title: 'Fetch eclass document',
  description: '[표준] search 결과의 id를 받아 원문/상세 텍스트를 반환합니다. ChatGPT/connector 호환용 read-only fetch 도구입니다. 다운로드 항목(eclass://download/<file_id>)은 파일 본문을 반환하지 않습니다. HTTP transport에서는 공개 설정된 /files/<token> URL만 반환하며, ChatGPT가 파일을 읽으려면 MCP tool이 아니라 브라우징으로 그 URL을 직접 열어야 합니다. 공개 URL이 아닌 localhost URL이면 MCP 서버 운영자가 ECLASS_HANDOFF_BASE_URL을 공개 HTTPS 주소로 설정해 URL을 다시 발급해야 합니다.',
  annotations: annotationsFor('fetch'),
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'search 결과의 id' },
    },
    required: ['id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      title: { type: 'string' },
      text: { type: 'string' },
      url: { type: 'string' },
      metadata: { type: 'object' },
    },
    required: ['id', 'title', 'text', 'url'],
  },
};

type JsonSchema = Record<string, unknown>;

const obj = (properties: Record<string, JsonSchema>, required?: string[]): JsonSchema => ({
  type: 'object',
  properties,
  ...(required && required.length > 0 ? { required } : {}),
});

const arr = (items: JsonSchema): JsonSchema => ({ type: 'array', items });

const str: JsonSchema = { type: 'string' };
const num: JsonSchema = { type: 'number' };
const bool: JsonSchema = { type: 'boolean' };

// 배열을 반환하는 도구는 normalizeToolResult가 structuredContent.result로 감싼다(TOOLS.md 공통사항).
// 따라서 outputSchema도 { result: [...] } 형태로 기술한다.
const arrayResult = (items: JsonSchema): JsonSchema => obj({ result: arr(items) }, ['result']);

// 실패 시 공통으로 실릴 수 있는 필드. additionalProperties를 막지 않으므로(기본 허용)
// optional/partial 필드와 미래 확장이 자연스럽게 호환된다.
const errorEnvelope: Record<string, JsonSchema> = {
  ok: bool,
  error_code: str,
  message: str,
  retryable: bool,
};

// 각 도구의 출력 스키마. 근거는 docs/TOOLS.md의 "출력" 명세.
// required는 성공/실패와 무관하게 항상 존재하는 최소 필드만 지정한다.
const ECLASS_OUTPUT_SCHEMAS: Record<string, JsonSchema> = {
  eclass_get_courses: arrayResult(obj({ id: num, name: str }, ['id', 'name'])),
  eclass_get_courses_cached: arrayResult(obj({ id: num, name: str, fetched_at: str })),
  eclass_doctor: obj(
    {
      checked_at: str,
      checks: arr(obj({ name: str, ok: bool, detail: str })),
    },
    ['checks'],
  ),
  eclass_get_assignments: arrayResult(
    obj({
      assignment_id: num,
      title: str,
      course_name: str,
      due_at: { type: ['string', 'null'] },
      is_submitted: bool,
      is_missing: bool,
      url: str,
      submission_types: arr(str),
      allowed_extensions: arr(str),
      allowed_attempts: num,
    }),
  ),
  eclass_get_assignment_detail: obj(
    {
      ...errorEnvelope,
      assignment: obj({
        id: num,
        course_id: num,
        name: str,
        due_at: { type: ['string', 'null'] },
        unlock_at: { type: ['string', 'null'] },
        lock_at: { type: ['string', 'null'] },
        points_possible: num,
        grading_type: str,
        submission_types: arr(str),
        allowed_extensions: arr(str),
        allowed_attempts: num,
        has_submitted: bool,
        submitted_at: { type: ['string', 'null'] },
        attempt: { type: ['number', 'null'] },
        workflow_state: str,
        score: { type: ['number', 'null'] },
        grade: { type: ['string', 'null'] },
        graded_at: { type: ['string', 'null'] },
        html_url: str,
      }),
    },
    ['ok'],
  ),
  eclass_submit_assignment: obj(
    {
      ...errorEnvelope,
      mode: str,
      already_submitted: bool,
      is_resubmission: bool,
      validation: { type: 'object' },
      strategy: str,
      submitted_at: { type: ['string', 'null'] },
      attempt: { type: ['number', 'null'] },
      verification: { type: 'object' },
    },
    ['ok'],
  ),
  eclass_get_grades: obj(
    {
      ok: bool,
      courses: arr(
        obj({
          course_id: num,
          course_name: str,
          current_score: { type: ['number', 'null'] },
          current_grade: { type: ['string', 'null'] },
          final_score: { type: ['number', 'null'] },
          final_grade: { type: ['string', 'null'] },
          assignments: arr(obj({ assignment_id: num, name: str })),
        }),
      ),
      errors: arr(obj({ scope: str, reason: str, retryable: bool })),
    },
    ['ok'],
  ),
  eclass_sync_course_metadata: obj(
    {
      ok: bool,
      synced: arr({ type: 'object' }),
      errors: arr({ type: 'object' }),
    },
    ['ok'],
  ),
  eclass_sync_exam_schedules: obj(
    {
      ok: bool,
      term: str,
      exam_type: str,
      sources_checked: num,
      documents: arr({ type: 'object' }),
      partial_failures: arr({ type: 'object' }),
    },
    ['ok'],
  ),
  eclass_get_exam_schedule: obj(
    {
      ok: bool,
      mode: str,
      matches: arr({ type: 'object' }),
      matched_by: str,
      reason: str,
      course_metadata: { type: 'object' },
      candidates: arr({ type: 'object' }),
      refresh_result: { type: 'object' },
    },
    ['ok'],
  ),
  eclass_list_exam_sources: obj(
    {
      ok: bool,
      sources: arr({ type: 'object' }),
      partial_failures: arr({ type: 'object' }),
    },
    ['ok'],
  ),
  eclass_search_syllabus: obj(
    {
      ...errorEnvelope,
      items: arr({ type: 'object' }),
    },
    ['ok'],
  ),
  eclass_get_syllabus: obj(
    {
      ...errorEnvelope,
      document: { type: 'object' },
    },
    ['ok'],
  ),
  eclass_search_downloads: obj(
    {
      matches: arr({ type: 'object' }),
      total_matched: num,
      limit: num,
      handoff_note: str,
    },
    ['matches'],
  ),
  eclass_export_course_snapshot: obj(
    {
      ok: bool,
      course_id: num,
      format: str,
      local_path: str,
      snapshot: { type: 'object' },
      content: str,
      partial_failures: arr(obj({ section: str, reason: str })),
    },
    ['ok'],
  ),
  eclass_get_announcements: arrayResult(
    obj({
      id: { type: ['string', 'number'] },
      title: str,
      author: str,
      posted_at: { type: ['string', 'null'] },
      message: str,
      has_attachment: bool,
    }),
  ),
  eclass_get_materials: obj(
    {
      ok: bool,
      course_id: num,
      sources: obj({ requested: arr(str), succeeded: arr(str), failed: arr(str) }),
      materials: arr({ type: 'object' }),
      errors: arr({ type: 'object' }),
      warnings: arr({ type: 'object' }),
    },
    ['ok'],
  ),
  eclass_download_file: obj(
    {
      file_id: str,
      display_name: str,
      local_path: str,
      size_bytes: num,
      skipped: bool,
      handoff_note: str,
    },
    ['file_id', 'display_name'],
  ),
  eclass_download_materials_batch: obj(
    {
      ok: bool,
      course_id: num,
      summary: obj({ total: num, downloaded: num, skipped: num, failed: num }),
      results: arr({ type: 'object' }),
      handoff_note: str,
    },
    ['ok'],
  ),
  eclass_download_video: obj(
    {
      ...errorEnvelope,
      video_id: str,
      display_name: str,
      local_path: str,
      size_bytes: num,
      skipped: bool,
      strategy: str,
      handoff_note: str,
    },
    ['ok'],
  ),
  eclass_list_downloads: arrayResult(
    obj({
      file_id: str,
      course_id: num,
      display_name: str,
      local_path: str,
      downloaded_at: str,
      size_bytes: num,
    }),
  ),
  eclass_get_download_status: obj(
    {
      mode: str,
      courses: arr({ type: 'object' }),
      total_file_count: num,
      total_size_bytes: num,
      downloads: arr({ type: 'object' }),
      handoff_note: str,
    },
    ['mode'],
  ),
  eclass_remove_download: obj(
    {
      removed: { type: ['number', 'boolean'] },
      file_id: str,
      course_id: num,
    },
    ['removed'],
  ),
  eclass_file_handoff: obj(
    {
      file_id: str,
      display_name: str,
      mime_type: str,
      size_bytes: num,
      delivered: bool,
      download_url: str,
    },
    ['file_id', 'delivered'],
  ),
};

export function outputSchemaFor(name: string): Tool['outputSchema'] | undefined {
  return ECLASS_OUTPUT_SCHEMAS[name] as Tool['outputSchema'] | undefined;
}

export function buildToolList(tools: Tool[]): Tool[] {
  return [...tools, standardSearchTool, standardFetchTool].map((tool) => ({
    ...tool,
    title: tool.title ?? titleFromName(tool.name),
    annotations: tool.annotations ?? annotationsFor(tool.name),
    outputSchema: tool.outputSchema ?? outputSchemaFor(tool.name),
  }));
}

function toStructuredContent(value: unknown): JsonObject {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as JsonObject;
  }
  return { result: value };
}

function parseJsonText(result: CallToolResult): JsonObject | undefined {
  if (result.structuredContent !== undefined) return result.structuredContent;
  if (!Array.isArray(result.content) || result.content.length !== 1) return undefined;
  const [first] = result.content;
  if (first.type !== 'text') return undefined;
  try {
    return toStructuredContent(JSON.parse(first.text));
  } catch {
    return undefined;
  }
}

export function jsonToolResult(value: unknown, options: { isError?: boolean } = {}): CallToolResult {
  return {
    ...(options.isError ? { isError: true } : {}),
    structuredContent: toStructuredContent(value),
    content: [{ type: 'text', text: JSON.stringify(value) }],
  };
}

export function normalizeToolResult(result: CallToolResult): CallToolResult {
  const structuredContent = parseJsonText(result);
  if (structuredContent === undefined) return result;
  return {
    ...result,
    structuredContent: structuredContent as JsonObject,
  };
}
