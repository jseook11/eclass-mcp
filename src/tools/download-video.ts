import * as fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { expandTilde, sanitizeFileName } from '../utils.js';
import { FileCache } from '../file-cache.js';
import { isRetryableReason, sanitizeDebug, toErrorResult } from '../errors.js';
import type { ToolErrorResult } from '../errors.js';
import { validateCachedDownload } from './download-file.js';

const OCS_ORIGIN = 'https://ocs.cau.ac.kr';
const OCS_VIEWER_PREFIX = `${OCS_ORIGIN}/em/`;
const OCS_METADATA_URL = `${OCS_ORIGIN}/viewer/ssplayer/uniplayer_support/content.php`;
const OCS_CDN_ORIGIN = 'https://cau-cms-object.cdn.gov-ntruss.com';
const OCS_CDN_MEDIA_ROOT = `${OCS_CDN_ORIGIN}/contents_new/cau1000001`;

const METADATA_TIMEOUT_MS = 30_000;
const VERIFY_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

// file_id PK 네임스페이스 공유로 인한 파일/영상 캐시 충돌 방지
const VIDEO_CACHE_PREFIX = 'video:';

/**
 * Marks failures that mean "this video can never be downloaded by this tool"
 * (wrong URL shape, HLS/DRM, signature mismatch) as opposed to transient
 * network/CDN failures which are retryable.
 */
class UnsupportedVideoError extends Error {}

export interface DownloadVideoInput {
  video_id: string;
  course_id: number;
  url: string;
  display_name: string;
  type?: string | null;
  source?: string | null;
}

export interface DownloadVideoResult {
  ok: true;
  video_id: string;
  display_name: string;
  local_path: string;
  size_bytes: number;
  skipped: boolean;
  strategy: 'ocs_uniplayer_mp4';
}

function getDownloadDir(): string {
  return process.env.ECLASS_DOWNLOAD_DIR ?? '~/Downloads/eclass';
}

function sanitizeName(displayName: string): string | null {
  const safe = sanitizeFileName(displayName);
  if (!safe) return null;
  return path.extname(safe) ? safe : `${safe}.mp4`;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

export function extractOcsContentId(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsupportedVideoError('OCS video URL rejected: invalid URL');
  }
  if (url.protocol !== 'https:' || url.origin !== OCS_ORIGIN || !url.pathname.startsWith('/em/')) {
    throw new UnsupportedVideoError('OCS video URL rejected: only https://ocs.cau.ac.kr/em/<content_id> is supported');
  }
  const contentId = url.pathname.slice('/em/'.length).split('/')[0];
  if (!/^[a-zA-Z0-9_-]+$/.test(contentId)) {
    throw new UnsupportedVideoError('OCS video URL rejected: invalid content id');
  }
  return contentId;
}

export function parseMainMediaFromXml(xml: string): string {
  const cdataMatch = /<main_media>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/main_media>/i.exec(xml);
  const plainMatch = /<main_media>\s*([^<]*?)\s*<\/main_media>/i.exec(xml);
  const match = cdataMatch ?? plainMatch;
  const media = decodeXmlEntities(match?.[1]?.trim() ?? '');
  if (!media) {
    throw new UnsupportedVideoError('OCS metadata missing main_media');
  }
  if (media.includes('/') || media.includes('\\') || media.includes('..')) {
    throw new UnsupportedVideoError('OCS metadata main_media rejected');
  }
  if (!/\.mp4$/i.test(media)) {
    throw new UnsupportedVideoError('Only OCS UniPlayer MP4 media is supported');
  }
  return media;
}

export function buildOcsMp4Url(contentId: string, mainMedia: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(contentId)) {
    throw new UnsupportedVideoError('Invalid OCS content id');
  }
  if (mainMedia.includes('/') || mainMedia.includes('\\') || mainMedia.includes('..')) {
    throw new UnsupportedVideoError('Invalid OCS media filename');
  }
  return `${OCS_CDN_MEDIA_ROOT}/${contentId}/contents/media_files/${encodeURIComponent(mainMedia)}`;
}

async function fetchOcsMetadata(contentId: string): Promise<string> {
  const url = new URL(OCS_METADATA_URL);
  url.searchParams.set('content_id', contentId);
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    headers: { Accept: 'application/xml,text/xml,*/*' },
  });
  if (!response.ok) {
    throw new Error(`OCS metadata fetch failed ${response.status}`);
  }
  return await response.text();
}

function hasMp4Signature(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  return bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
}

/**
 * Reads at most `limit` bytes from the response body, then cancels the stream.
 * CDN이 Range를 무시하고 200 전체 본문을 보내더라도 검증 단계에서 영상 전체를
 * 받지 않도록 막는다.
 */
async function readPrefix(response: Response, limit: number): Promise<Uint8Array> {
  const body = response.body;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged.slice(0, limit);
}

async function verifyOcsMp4(url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.origin !== OCS_CDN_ORIGIN) {
    throw new UnsupportedVideoError('OCS MP4 URL rejected: unexpected origin');
  }
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    headers: { Range: 'bytes=0-15' },
  });
  if (!response.ok && response.status !== 206) {
    throw new Error(`OCS MP4 verification failed ${response.status}`);
  }
  const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'video/mp4') {
    throw new UnsupportedVideoError(`OCS MP4 verification rejected content-type ${contentType || '(missing)'}`);
  }
  const bytes = await readPrefix(response, 16);
  if (!hasMp4Signature(bytes)) {
    throw new UnsupportedVideoError('OCS MP4 verification rejected file signature');
  }
}

async function downloadVerifiedMp4(courseId: number, mp4Url: string, safeName: string): Promise<{ local_path: string; size_bytes: number }> {
  const response = await fetch(mp4Url, {
    redirect: 'error',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`OCS MP4 download failed ${response.status}`);
  }
  const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'video/mp4') {
    throw new UnsupportedVideoError(`OCS MP4 download rejected content-type ${contentType || '(missing)'}`);
  }
  if (!response.body) {
    throw new Error('OCS MP4 download returned empty body');
  }

  const dir = path.join(expandTilde(getDownloadDir()), String(courseId));
  await fs.mkdir(dir, { recursive: true });
  const localPath = path.join(dir, safeName);

  // 강의 영상은 수백 MB~GB 단위 — 메모리 버퍼링 대신 임시 파일로 스트리밍한 뒤
  // 완료 시에만 최종 경로로 rename (부분 파일이 정식 경로에 남지 않도록).
  const tempPath = `${localPath}.part`;
  try {
    await pipeline(
      Readable.fromWeb(response.body as unknown as WebReadableStream),
      createWriteStream(tempPath),
    );
    await fs.rename(tempPath, localPath);
  } catch (err) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw err;
  }

  const stat = await fs.stat(localPath);
  return { local_path: localPath, size_bytes: stat.size };
}

export async function downloadVideo(
  input: DownloadVideoInput,
  fileCache: FileCache,
): Promise<DownloadVideoResult | ToolErrorResult> {
  const safeName = sanitizeName(input.display_name);
  if (!safeName) {
    return toErrorResult('VIDEO_DOWNLOAD_INVALID_NAME', '유효하지 않은 동영상 파일명입니다.', { retryable: false });
  }

  const cacheId = `${VIDEO_CACHE_PREFIX}${input.video_id}`;
  try {
    const contentId = extractOcsContentId(input.url);
    const cached = await validateCachedDownload(fileCache, {
      file_id: cacheId,
      course_id: input.course_id,
      display_name: input.display_name,
      source: input.source,
    });
    if (cached) {
      return {
        ok: true,
        video_id: input.video_id,
        display_name: input.display_name,
        local_path: cached.local_path,
        size_bytes: cached.size_bytes,
        skipped: true,
        strategy: 'ocs_uniplayer_mp4',
      };
    }

    const metadata = await fetchOcsMetadata(contentId);
    const mainMedia = parseMainMediaFromXml(metadata);
    const mp4Url = buildOcsMp4Url(contentId, mainMedia);
    await verifyOcsMp4(mp4Url);
    const downloaded = await downloadVerifiedMp4(input.course_id, mp4Url, safeName);

    fileCache.record({
      file_id: cacheId,
      course_id: input.course_id,
      display_name: input.display_name,
      local_path: downloaded.local_path,
      downloaded_at: new Date().toISOString(),
      size_bytes: downloaded.size_bytes,
      source: input.source ?? null,
    });

    return {
      ok: true,
      video_id: input.video_id,
      display_name: input.display_name,
      local_path: downloaded.local_path,
      size_bytes: downloaded.size_bytes,
      skipped: false,
      strategy: 'ocs_uniplayer_mp4',
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (err instanceof UnsupportedVideoError) {
      return {
        ok: false,
        error_code: 'VIDEO_DOWNLOAD_UNSUPPORTED',
        message: '지원되는 OCS UniPlayer MP4 동영상만 다운로드할 수 있습니다.',
        retryable: false,
        next_action: 'HLS/m3u8/DRM/진도 추적형 영상은 지원하지 않습니다. 파일 자료는 eclass_download_file을 사용하세요.',
        debug: sanitizeDebug(reason),
      };
    }
    // 일시적 네트워크/CDN 장애는 재시도 가능으로 구분해 보고
    return {
      ok: false,
      error_code: 'VIDEO_DOWNLOAD_FAILED',
      message: 'OCS 동영상 다운로드 중 오류가 발생했습니다.',
      retryable: isRetryableReason(reason),
      next_action: '잠시 후 다시 시도하세요. 반복 실패 시 eclass_doctor로 연결 상태를 확인하세요.',
      debug: sanitizeDebug(reason),
    };
  }
}
