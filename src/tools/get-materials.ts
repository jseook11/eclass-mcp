import { CanvasApiError, CanvasClient, isCanvasPermissionDeniedError } from '../canvas-client.js';
import { BrowserSession } from '../browser-session.js';
import { FileCache } from '../file-cache.js';

const BASE_URL = 'https://eclass3.cau.ac.kr';

export type MaterialSource = 'modules' | 'files' | 'courseresource' | 'external' | 'modulebuilder' | 'announcements';

function resolveMaterialUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;
  try {
    return new URL(rawUrl, BASE_URL).toString();
  } catch {
    return null;
  }
}

export interface Material {
  id: string;
  title: string;
  type: string;
  url: string | null;
  source: MaterialSource;
  module_name?: string;
  is_playright_required?: boolean;
  is_downloaded?: boolean;
  local_path?: string;
}

export interface MaterialFetchError {
  source: MaterialSource;
  reason: string;
  retryable: boolean;
}

export interface MaterialFetchWarning {
  source: 'cache';
  reason: string;
  retryable: boolean;
}

export interface GetMaterialsResult {
  ok: boolean;
  course_id: number;
  sources: {
    requested: MaterialSource[];
    succeeded: MaterialSource[];
    failed: MaterialSource[];
  };
  materials: Material[];
  errors: MaterialFetchError[];
  warnings: MaterialFetchWarning[];
}

interface RawModuleItem {
  id: number;
  title: string;
  type: string;
  html_url?: string | null;
}

interface RawModule {
  id: number;
  name: string;
  items?: RawModuleItem[];
}

interface RawFile {
  id: number;
  display_name: string;
  url: string;
  'content-type'?: string;
}

const FILES_PERMISSION_DENIAL_TTL_MS = 15 * 60 * 1000;
const filesPermissionDenials = new Map<number, number>();

function filesPermissionDeniedError(courseId: number, cached: boolean): CanvasApiError {
  const suffix = cached
    ? ' (Files API permission denial is cached temporarily)'
    : ' (Files API permission denied)';
  return new CanvasApiError(401, `/api/v1/courses/${courseId}/files`, true, `Canvas API error 401${suffix}`);
}

function readPersistedFilesDenial(courseId: number, cache?: FileCache): number | undefined {
  if (!cache || typeof cache.getSourceAccessDenial !== 'function') return undefined;
  try {
    const denial = cache.getSourceAccessDenial(courseId, 'files');
    if (!denial) return undefined;
    const deniedUntil = Date.parse(denial.denied_until);
    if (!Number.isFinite(deniedUntil)) return undefined;
    if (deniedUntil <= Date.now()) {
      cache.clearSourceAccessDenial(courseId, 'files');
      return undefined;
    }
    return deniedUntil;
  } catch {
    return undefined;
  }
}

function activeFilesDenial(courseId: number, cache?: FileCache): number | undefined {
  const now = Date.now();
  const inMemory = filesPermissionDenials.get(courseId);
  if (inMemory !== undefined && inMemory <= now) filesPermissionDenials.delete(courseId);
  const persisted = readPersistedFilesDenial(courseId, cache);
  const current = Math.max(filesPermissionDenials.get(courseId) ?? 0, persisted ?? 0);
  return current > now ? current : undefined;
}

function rememberFilesDenial(courseId: number, cache?: FileCache, reason = 'Files API permission denied'): void {
  const deniedUntil = Date.now() + FILES_PERMISSION_DENIAL_TTL_MS;
  filesPermissionDenials.set(courseId, deniedUntil);
  if (!cache || typeof cache.setSourceAccessDenial !== 'function') return;
  try {
    cache.setSourceAccessDenial(courseId, 'files', new Date(deniedUntil).toISOString(), reason);
  } catch {
    // A best-effort persistent cache must not turn a source denial into a
    // larger material lookup failure. The in-memory guard remains active.
  }
}

function clearFilesDenial(courseId: number, cache?: FileCache): void {
  filesPermissionDenials.delete(courseId);
  if (!cache || typeof cache.clearSourceAccessDenial !== 'function') return;
  try {
    cache.clearSourceAccessDenial(courseId, 'files');
  } catch {
    // A stale denial will naturally expire; do not fail a successful fetch.
  }
}

async function fetchModules(client: CanvasClient, courseId: number): Promise<Material[]> {
  const raw = await client.fetchAll<RawModule>(
    `/api/v1/courses/${courseId}/modules`,
    { 'include[]': 'items', per_page: '50' },
  );

  const materials: Material[] = [];
  for (const module of raw) {
    for (const item of module.items ?? []) {
      if (item.type === 'ExternalTool') continue;
      materials.push({
        id: String(item.id),
        title: item.title,
        type: item.type,
        url: resolveMaterialUrl(item.html_url),
        source: 'modules',
        module_name: module.name,
      });
    }
  }
  return materials;
}

async function fetchFiles(client: CanvasClient, courseId: number, cache?: FileCache): Promise<Material[]> {
  if (activeFilesDenial(courseId, cache) !== undefined) {
    throw filesPermissionDeniedError(courseId, true);
  }

  try {
    const raw = await client.fetchAll<RawFile>(
      `/api/v1/courses/${courseId}/files`,
      { per_page: '100' },
    );
    clearFilesDenial(courseId, cache);
    return raw.map((file) => ({
      id: String(file.id),
      title: file.display_name,
      type: file['content-type'] ?? 'file',
      url: file.url,
      source: 'files' as MaterialSource,
    }));
  } catch (err) {
    if (isCanvasPermissionDeniedError(err)) {
      rememberFilesDenial(courseId, cache, err.message);
    }
    throw err;
  }
}

async function fetchCourseresource(session: BrowserSession, courseId: number): Promise<Material[]> {
  const items = await session.interceptCourseresource(courseId);
  return items.map((item) => ({
    id: item.id,
    title: item.title,
    type: item.type || 'resource',
    url: item.url,
    source: 'courseresource' as MaterialSource,
    is_playright_required: !item.url,
  }));
}

interface RawAttachment {
  id: number;
  display_name: string;
  url: string;
  'content-type'?: string;
  size?: number;
}

interface RawAnnouncementItem {
  id: number;
  title: string;
  attachments?: RawAttachment[];
}

async function fetchAnnouncements(client: CanvasClient, courseId: number): Promise<Material[]> {
  const raw = await client.fetchAll<RawAnnouncementItem>(
    `/api/v1/courses/${courseId}/discussion_topics`,
    { only_announcements: 'true', per_page: '100' },
  );

  const materials: Material[] = [];
  for (const announcement of raw) {
    if (!Array.isArray(announcement.attachments) || announcement.attachments.length === 0) continue;
    for (const att of announcement.attachments) {
      materials.push({
        id: String(att.id),
        title: att.display_name,
        type: att['content-type'] ?? 'file',
        url: att.url,
        source: 'announcements' as MaterialSource,
        module_name: announcement.title,
      });
    }
  }
  return materials;
}

async function fetchModulebuilder(session: BrowserSession, courseId: number): Promise<Material[]> {
  const items = await session.interceptModulebuilder(courseId);
  return items.map((item) => ({
    id: item.id,
    title: item.title,
    type: item.type || 'pdf',
    url: item.url,
    source: 'modulebuilder' as MaterialSource,
    is_playright_required: true,
  }));
}

async function fetchExternal(client: CanvasClient, courseId: number): Promise<Material[]> {
  const raw = await client.fetchAll<RawModule>(
    `/api/v1/courses/${courseId}/modules`,
    { 'include[]': 'items', per_page: '50' },
  );

  const materials: Material[] = [];
  for (const module of raw) {
    for (const item of module.items ?? []) {
      if (item.type !== 'ExternalTool') continue;
      materials.push({
        id: String(item.id),
        title: item.title,
        type: 'ExternalTool',
        url: resolveMaterialUrl(item.html_url),
        source: 'external',
        module_name: module.name,
        is_playright_required: true,
      });
    }
  }
  return materials;
}

const ALL_SOURCES: MaterialSource[] = ['modules', 'files', 'courseresource', 'external', 'modulebuilder', 'announcements'];

function uniqueSources(sources: MaterialSource[]): MaterialSource[] {
  return Array.from(new Set(sources));
}

function materialTask(
  source: MaterialSource,
  client: CanvasClient,
  session: BrowserSession,
  courseId: number,
  cache?: FileCache,
): Promise<Material[]> {
  switch (source) {
    case 'modules': return fetchModules(client, courseId);
    case 'files': return fetchFiles(client, courseId, cache);
    case 'courseresource': return fetchCourseresource(session, courseId);
    case 'external': return fetchExternal(client, courseId);
    case 'modulebuilder': return fetchModulebuilder(session, courseId);
    case 'announcements': return fetchAnnouncements(client, courseId);
  }
}

function sanitizeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function sanitizeReason(reason: string): string {
  return reason
    .replace(/https?:\/\/[^\s"'<>]+/g, (url) => sanitizeUrl(url))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function isRetryableError(reason: string): boolean {
  const normalized = reason.toLowerCase();
  if (/\b(401|403|404)\b/.test(normalized)) return false;
  if (normalized.includes('origin not in allowlist')) return false;
  if (normalized.includes('invalid url')) return false;
  if (normalized.includes('timeout') || normalized.includes('timed out')) return true;
  if (normalized.includes('network')) return true;
  if (normalized.includes('econnreset') || normalized.includes('etimedout')) return true;
  if (/\b429\b/.test(normalized)) return true;
  if (/\b5\d\d\b/.test(normalized)) return true;
  if (normalized.includes('navigation timeout')) return true;
  if (normalized.includes('net::')) return true;
  return true;
}

function toMaterialIssue<TSource extends MaterialSource | 'cache'>(
  source: TSource,
  err: unknown,
): { source: TSource; reason: string; retryable: boolean } {
  const rawReason = err instanceof Error ? err.message : String(err);
  const reason = sanitizeReason(rawReason) || 'Unknown error';
  return {
    source,
    reason,
    retryable: isRetryableError(reason),
  };
}

export function isGetMaterialsToolError(result: GetMaterialsResult): boolean {
  return !result.ok;
}

export async function getMaterials(
  client: CanvasClient,
  session: BrowserSession,
  courseId: number,
  sources: MaterialSource[] = ALL_SOURCES,
  cache?: FileCache,
): Promise<GetMaterialsResult> {
  const requested = uniqueSources(sources);
  if (requested.length === 0) {
    throw new Error('sources must not be empty');
  }

  const settled = await Promise.allSettled(
    requested.map((source) => materialTask(source, client, session, courseId, cache)),
  );

  const materials: Material[] = [];
  const succeeded: MaterialSource[] = [];
  const failed: MaterialSource[] = [];
  const errors: MaterialFetchError[] = [];
  const warnings: MaterialFetchWarning[] = [];

  for (const [index, result] of settled.entries()) {
    const source = requested[index];
    if (result.status === 'fulfilled') {
      succeeded.push(source);
      materials.push(...result.value);
    } else {
      failed.push(source);
      errors.push(toMaterialIssue(source, result.reason));
    }
  }

  if (cache) {
    let cacheWarning: MaterialFetchWarning | null = null;
    for (const m of materials) {
      try {
        const record = cache.get(m.id);
        if (record) {
          m.is_downloaded = true;
          m.local_path = record.local_path;
        } else {
          m.is_downloaded = false;
        }
      } catch (err) {
        m.is_downloaded = false;
        cacheWarning ??= toMaterialIssue('cache', err);
      }
    }
    if (cacheWarning) warnings.push(cacheWarning);
  }

  return {
    ok: succeeded.length > 0,
    course_id: courseId,
    sources: {
      requested,
      succeeded,
      failed,
    },
    materials,
    errors,
    warnings,
  };
}
