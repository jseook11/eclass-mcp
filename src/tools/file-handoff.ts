import * as path from 'node:path';
import { sanitizeFileName } from '../utils.js';
import type { DownloadRecord } from '../file-cache.js';

const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.hwp': 'application/x-hwp',
};

export const DEFAULT_HANDOFF_MAX_BYTES = 25 * 1024 * 1024;

export function inferMimeType(name: string): string {
  const ext = path.extname(name).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

export function resolveHandoffMaxBytes(env: NodeJS.ProcessEnv): number {
  const raw = env.ECLASS_HANDOFF_MAX_BYTES;
  if (!raw) return DEFAULT_HANDOFF_MAX_BYTES;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_HANDOFF_MAX_BYTES;
}

export interface FileHandoffResult {
  structuredContent: {
    file_id: string;
    display_name: string;
    mime_type: string;
    size_bytes: number;
    delivered: true;
  };
  content: Array<{
    type: 'resource';
    resource: { uri: string; mimeType: string; blob: string };
  }>;
}

export interface HandoffDeps {
  getRecord: (fileId: string) => DownloadRecord | undefined;
  statSize: (localPath: string) => number | null;
  readFile: (localPath: string) => Buffer;
  maxBytes: number;
}

export type HandoffError = {
  code: 'not_found' | 'file_missing' | 'too_large';
  message: string;
  [key: string]: unknown;
};

export type HandoffOutcome =
  | { ok: true; result: FileHandoffResult }
  | { ok: false; error: HandoffError };

export function buildFileHandoff(record: DownloadRecord, bytes: Buffer): FileHandoffResult {
  const mimeType = inferMimeType(record.display_name);
  const safeName = sanitizeFileName(record.display_name) ?? `file-${record.file_id}`;
  return {
    structuredContent: {
      file_id: record.file_id,
      display_name: record.display_name,
      mime_type: mimeType,
      size_bytes: bytes.length,
      delivered: true,
    },
    content: [
      {
        type: 'resource',
        resource: {
          // encodeURI: 공백·한글 등 비ASCII를 RFC 3986 유효하게 percent-encode.
          // 준수하는 클라이언트는 디코딩해 원래 파일명으로 저장한다(display_name은 원형 보존).
          uri: `file:///${encodeURI(safeName)}`,
          mimeType,
          blob: bytes.toString('base64'),
        },
      },
    ],
  };
}

export function handoffFile(fileId: string, deps: HandoffDeps): HandoffOutcome {
  const record = deps.getRecord(fileId);
  if (!record) {
    return {
      ok: false,
      error: {
        code: 'not_found',
        message: `다운로드 기록을 찾을 수 없습니다: ${fileId}. eclass_search_downloads로 올바른 file_id를 확인하세요.`,
      },
    };
  }

  const diskSize = deps.statSize(record.local_path);
  if (diskSize === null) {
    return {
      ok: false,
      error: {
        code: 'file_missing',
        message: `기록은 있으나 디스크에 파일이 없습니다. 다시 다운로드하세요: ${record.display_name}`,
        file_id: fileId,
      },
    };
  }

  const effectiveSize = record.size_bytes > 0 ? record.size_bytes : diskSize;
  if (effectiveSize > deps.maxBytes) {
    return {
      ok: false,
      error: {
        code: 'too_large',
        message: `파일이 너무 커서 전달할 수 없습니다 (${effectiveSize} bytes > 한계 ${deps.maxBytes} bytes). 청킹은 아직 지원하지 않습니다.`,
        size_bytes: effectiveSize,
        max_bytes: deps.maxBytes,
      },
    };
  }

  const bytes = deps.readFile(record.local_path);
  return { ok: true, result: buildFileHandoff(record, bytes) };
}
