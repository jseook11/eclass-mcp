import * as fs from 'node:fs/promises';
import { BrowserSession } from '../browser-session.js';
import { FileCache } from '../file-cache.js';
import {
  resolveDownloadStrategy,
  isPlaywrightStrategy,
  type DownloadStrategy,
} from '../download-strategy.js';
import { downloadFileToDisk, validateCachedDownload } from './download-file.js';
import { sanitizeDebug, isRetryableReason } from '../errors.js';
import { sanitizeFileName } from '../utils.js';

export interface DownloadItem {
  file_id: string;
  course_id: number;
  url: string | null;
  display_name: string;
  type?: string | null;
  source?: string | null;
}

export interface DownloadOutcome {
  file_id: string;
  display_name: string;
  status: 'downloaded' | 'skipped' | 'failed';
  strategy: DownloadStrategy;
  local_path?: string;
  size_bytes?: number;
  error_code?: string;
  message?: string;
  retryable?: boolean;
}

export interface DownloadDeps {
  session: BrowserSession;
  fileCache: FileCache;
  token: string;
}

function getDownloadDir(): string {
  return process.env.ECLASS_DOWNLOAD_DIR ?? '~/Downloads/eclass';
}

function sanitizeName(displayName: string): string | null {
  return sanitizeFileName(displayName);
}

function failed(
  item: DownloadItem,
  strategy: DownloadStrategy,
  errorCode: string,
  message: string,
  retryable: boolean,
): DownloadOutcome {
  return { file_id: item.file_id, display_name: item.display_name, status: 'failed', strategy, error_code: errorCode, message, retryable };
}

/**
 * Unified single-material download. Validates the cache, resolves the transport
 * strategy, dispatches to the direct-fetch or Playwright path, records the
 * result with its source, and returns a structured outcome. Never throws for
 * expected failures — they come back as status 'failed'.
 */
export async function downloadOne(deps: DownloadDeps, item: DownloadItem): Promise<DownloadOutcome> {
  const strategy = resolveDownloadStrategy(item.url, item.type);

  if (strategy === 'unsupported_streaming_media') {
    return failed(
      item,
      strategy,
      'DOWNLOAD_UNSUPPORTED_MEDIA',
      `파일 다운로드 도구는 동영상/스트리밍 자료를 처리하지 않습니다. OCS MP4 동영상은 eclass_download_video를 사용하세요: type=${item.type ?? ''}`,
      false,
    );
  }

  const cached = await validateCachedDownload(deps.fileCache, item);
  if (cached) {
    return {
      file_id: item.file_id,
      display_name: item.display_name,
      status: 'skipped',
      strategy: 'already_cached',
      local_path: cached.local_path,
      size_bytes: cached.size_bytes,
    };
  }

  const safeName = sanitizeName(item.display_name);
  if (!safeName) {
    return failed(item, strategy, 'DOWNLOAD_INVALID_NAME', `유효하지 않은 파일명입니다: ${JSON.stringify(item.display_name)}`, false);
  }

  try {
    let localPath: string;
    let sizeBytes: number;

    if (isPlaywrightStrategy(strategy)) {
      localPath = await deps.session.downloadCourseresourceFile(
        item.course_id,
        item.file_id,
        safeName,
        getDownloadDir(),
        strategy === 'ocs_intercept' ? item.url! : undefined,
      );
      const stat = await fs.stat(localPath);
      sizeBytes = stat.size;
    } else {
      const result = await downloadFileToDisk(item.course_id, item.url!, item.display_name, deps.token);
      localPath = result.local_path;
      sizeBytes = result.size_bytes;
    }

    deps.fileCache.record({
      file_id: item.file_id,
      course_id: item.course_id,
      display_name: item.display_name,
      local_path: localPath,
      downloaded_at: new Date().toISOString(),
      size_bytes: sizeBytes,
      source: item.source ?? null,
    });

    return {
      file_id: item.file_id,
      display_name: item.display_name,
      status: 'downloaded',
      strategy,
      local_path: localPath,
      size_bytes: sizeBytes,
    };
  } catch (err) {
    const reason = sanitizeDebug(err instanceof Error ? err.message : String(err)) || 'Unknown error';
    return failed(item, strategy, 'DOWNLOAD_FAILED', reason, isRetryableReason(reason));
  }
}
