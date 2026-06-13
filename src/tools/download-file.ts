import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { FileCache } from '../file-cache.js';
import { expandTilde, sanitizeFileName } from '../utils.js';

function getDownloadDir(): string {
  return process.env.ECLASS_DOWNLOAD_DIR ?? '~/Downloads/eclass';
}

const CREDENTIAL_ALLOWED_ORIGINS = new Set([
  'https://eclass3.cau.ac.kr',
  'https://ocs.cau.ac.kr',
]);

const MAX_DOWNLOAD_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

const MIME_TO_EXT: Record<string, string> = {
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/x-zip-compressed': '.zip',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/msword': '.doc',
  'application/vnd.ms-excel': '.xls',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'text/plain': '.txt',
  'text/html': '.html',
};

function resolveFilename(safeName: string, response: Response): string {
  if (path.extname(safeName)) return safeName;

  const disposition = response.headers.get('content-disposition');
  if (disposition) {
    const match = /filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)["']?/i.exec(disposition);
    if (match) {
      const ext = path.extname(decodeURIComponent(match[1].trim()));
      if (ext) return safeName + ext;
    }
  }

  const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const ext = MIME_TO_EXT[contentType];
  if (ext) return safeName + ext;

  return safeName;
}

function assertAllowedOrigin(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Download rejected: invalid URL`);
  }
  if (!CREDENTIAL_ALLOWED_ORIGINS.has(parsed.origin)) {
    throw new Error(`Download rejected: origin not in allowlist`);
  }
}

function isAllowedCredentialOrigin(url: string): boolean {
  try {
    return CREDENTIAL_ALLOWED_ORIGINS.has(new URL(url).origin);
  } catch {
    return false;
  }
}

async function fetchDownloadResponse(url: string, token: string): Promise<Response> {
  let currentUrl = url;

  for (let redirectCount = 0; redirectCount <= MAX_DOWNLOAD_REDIRECTS; redirectCount += 1) {
    const sendAuth = isAllowedCredentialOrigin(currentUrl);
    const response = await fetch(currentUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      headers: sendAuth ? { Authorization: `Bearer ${token}` } : undefined,
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw new Error(`Download redirect missing location header: ${response.status}`);
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    return response;
  }

  throw new Error(`Download failed: too many redirects`);
}

export interface DownloadResult {
  file_id: string;
  display_name: string;
  local_path: string;
  size_bytes: number;
  skipped: boolean;   // true if already downloaded
}

export interface CacheValidationHit {
  local_path: string;
  size_bytes: number;
}

interface CacheValidationView {
  get(fileId: string): { local_path: string; size_bytes: number } | null | undefined;
  findByName(courseId: number, displayName: string): { local_path: string; size_bytes: number } | null | undefined;
  record(entry: import('../file-cache.js').DownloadRecord): void;
}

/**
 * Validates whether a material is already downloaded, by file_id then by
 * (course_id + display_name + size + on-disk existence). Re-registers the new
 * file_id when a name/size match is found. Returns the hit, or null to download.
 * Shared by downloadFile (direct path) and downloadOne (unified executor).
 */
export async function validateCachedDownload(
  cache: CacheValidationView,
  item: { file_id: string; course_id: number; display_name: string; source?: string | null },
): Promise<CacheValidationHit | null> {
  const existing = cache.get(item.file_id);
  if (existing) {
    try {
      await fs.access(existing.local_path);
      return { local_path: existing.local_path, size_bytes: existing.size_bytes };
    } catch {
      // File was deleted from disk — re-download
    }
  }

  const existingByName = cache.findByName(item.course_id, item.display_name);
  if (existingByName) {
    try {
      const stat = await fs.stat(existingByName.local_path);
      if (stat.size === existingByName.size_bytes) {
        // Same size → unchanged file; register the new file_id pointing at it
        cache.record({
          ...(existingByName as import('../file-cache.js').DownloadRecord),
          file_id: item.file_id,
          ...(item.source !== undefined ? { source: item.source } : {}),
        });
        return { local_path: existingByName.local_path, size_bytes: existingByName.size_bytes };
      }
      // Different size → file was updated, fall through to re-download
    } catch {
      // File deleted from disk — fall through to re-download
    }
  }

  return null;
}

/**
 * Fetches a direct/canvas file URL to disk. No cache logic — callers handle
 * caching. Returns the saved path and byte size.
 */
export async function downloadFileToDisk(
  courseId: number,
  url: string,
  displayName: string,
  token: string,
): Promise<{ local_path: string; size_bytes: number }> {
  // Validate download URL origin before sending bearer token
  assertAllowedOrigin(url);
  const parsedUrl = new URL(url);
  if (parsedUrl.hostname === 'ocs.cau.ac.kr') {
    throw new Error('OCS files must be downloaded via the Playwright path (viewUrl), not the direct download path');
  }

  // Sanitize filename to prevent path traversal
  const safeName = sanitizeFileName(displayName);
  if (!safeName) {
    throw new Error(`Invalid displayName: ${JSON.stringify(displayName)}`);
  }

  const dir = path.join(expandTilde(getDownloadDir()), String(courseId));
  await fs.mkdir(dir, { recursive: true });

  const response = await fetchDownloadResponse(url, token);
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status}`);
  }

  const resolvedName = resolveFilename(safeName, response);
  const localPath = path.join(dir, resolvedName);

  const buffer = await response.arrayBuffer();
  await fs.writeFile(localPath, Buffer.from(buffer));

  return { local_path: localPath, size_bytes: buffer.byteLength };
}

export async function downloadFile(
  fileId: string,
  courseId: number,
  url: string,
  displayName: string,
  token: string,
  cache: FileCache,
  source?: string | null,
): Promise<DownloadResult> {
  const cached = await validateCachedDownload(cache, {
    file_id: fileId,
    course_id: courseId,
    display_name: displayName,
    source,
  });
  if (cached) {
    return {
      file_id: fileId,
      display_name: displayName,
      local_path: cached.local_path,
      size_bytes: cached.size_bytes,
      skipped: true,
    };
  }

  const { local_path: localPath, size_bytes: sizeBytes } = await downloadFileToDisk(
    courseId,
    url,
    displayName,
    token,
  );

  cache.record({
    file_id: fileId,
    course_id: courseId,
    display_name: displayName,
    local_path: localPath,
    downloaded_at: new Date().toISOString(),
    size_bytes: sizeBytes,
    ...(source !== undefined ? { source } : {}),
  });

  return {
    file_id: fileId,
    display_name: displayName,
    local_path: localPath,
    size_bytes: sizeBytes,
    skipped: false,
  };
}
