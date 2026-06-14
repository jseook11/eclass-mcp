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
  'search',
  'fetch',
]);

const destructiveTools = new Set([
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
  description: '[표준] eclass 강의, 과제, 공지, 자료, 강의계획서, 로컬 다운로드 기록을 통합 검색합니다. ChatGPT/connector 호환용 read-only search 도구입니다.',
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
  description: '[표준] search 결과의 id를 받아 원문/상세 텍스트를 반환합니다. ChatGPT/connector 호환용 read-only fetch 도구입니다.',
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

export function buildToolList(tools: Tool[]): Tool[] {
  return [...tools, standardSearchTool, standardFetchTool].map((tool) => ({
    ...tool,
    title: tool.title ?? titleFromName(tool.name),
    annotations: tool.annotations ?? annotationsFor(tool.name),
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
