import { CanvasApiError, CanvasClient, isCanvasPermissionDeniedError } from '../canvas-client.js';
import { BrowserSession, isStreamingMediaType } from '../browser-session.js';
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
  canvas_file_id?: string;
  title: string;
  type: string;
  url: string | null;
  source: MaterialSource;
  /** All source aliases collapsed into this material, in semantic priority order. */
  sources?: MaterialSource[];
  /** Source that supplied `url` when it differs from the representative source. */
  url_source?: MaterialSource;
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
  content_id?: number | string | null;
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

function normalizeCanvasFileId(value: unknown): string | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? String(parsed) : undefined;
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

async function fetchModules(loadModules: () => Promise<RawModule[]>): Promise<Material[]> {
  const raw = await loadModules();
  const materials: Material[] = [];
  for (const module of raw) {
    for (const item of module.items ?? []) {
      if (item.type === 'ExternalTool') continue;
      const canvasFileId = item.type === 'File' ? normalizeCanvasFileId(item.content_id) : undefined;
      materials.push({
        id: String(item.id),
        ...(canvasFileId ? { canvas_file_id: canvasFileId } : {}),
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
      canvas_file_id: String(file.id),
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
        canvas_file_id: String(att.id),
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

async function fetchExternal(loadModules: () => Promise<RawModule[]>): Promise<Material[]> {
  const raw = await loadModules();
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

const DEFAULT_SOURCES: MaterialSource[] = [
  'modulebuilder',
  'courseresource',
  'announcements',
  'modules',
  'external',
];

function uniqueSources(sources: MaterialSource[]): MaterialSource[] {
  return Array.from(new Set(sources));
}

function materialTask(
  source: MaterialSource,
  client: CanvasClient,
  session: BrowserSession,
  courseId: number,
  loadModules: () => Promise<RawModule[]>,
  cache?: FileCache,
): Promise<Material[]> {
  switch (source) {
    case 'modules': return fetchModules(loadModules);
    case 'files': return fetchFiles(client, courseId, cache);
    case 'courseresource': return fetchCourseresource(session, courseId);
    case 'external': return fetchExternal(loadModules);
    case 'modulebuilder': return fetchModulebuilder(session, courseId);
    case 'announcements': return fetchAnnouncements(client, courseId);
  }
}

const SOURCE_PRIORITY: MaterialSource[] = [
  'modulebuilder',
  'courseresource',
  'announcements',
  'modules',
  'external',
  'files',
];

function materialIdentityKeys(material: Material): string[] {
  const keys: string[] = [];
  if (material.id) keys.push(`source:${material.source}:id:${material.id}`);
  if (material.canvas_file_id) keys.push(`canvas-file:${material.canvas_file_id}`);
  if (
    material.id
    && (material.source === 'modulebuilder' || material.source === 'external')
  ) {
    keys.push(`module-item:${material.id}`);
  }
  if (
    material.id
    && (material.source === 'files' || material.source === 'announcements')
  ) {
    keys.push(`canvas-file:${material.id}`);
  }

  if (!material.url) return keys;
  try {
    const url = new URL(material.url);
    url.hash = '';
    const host = url.hostname.toLowerCase();
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (host === 'ocs.cau.ac.kr') {
      const content = path.match(/^\/em\/([^/]+)$/);
      if (content) keys.push(`ocs-content:${decodeURIComponent(content[1])}`);
    }
    if (host === 'eclass3.cau.ac.kr') {
      const file = path.match(/\/(?:courses\/\d+\/)?files\/(\d+)(?:\/download)?$/);
      if (file) keys.push(`canvas-file:${file[1]}`);
      const moduleItem = path.match(/^\/courses\/\d+\/modules\/items\/(\d+)$/);
      if (moduleItem) keys.push(`module-item:${moduleItem[1]}`);
    }

    url.hostname = host;
    url.pathname = path;
    url.searchParams.sort();
    keys.push(`url:${url.toString()}`);
  } catch {
    // Invalid URLs are already tolerated by the material contract. The
    // source-local ID still gives us a safe identity key.
  }
  return [...new Set(keys)];
}

function sourceRank(source: MaterialSource): number {
  return SOURCE_PRIORITY.indexOf(source);
}

function isOcsViewerUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.hostname.toLowerCase() === 'ocs.cau.ac.kr' && /^\/em\/[^/]+\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

function isCanvasDirectFileUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.hostname.toLowerCase() === 'eclass3.cau.ac.kr'
      && /\/files\/\d+\/download\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

function isCanvasWrapperUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.hostname.toLowerCase() === 'eclass3.cau.ac.kr'
      && /^\/courses\/\d+\/modules\/items\/\d+\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

function locatorRank(material: Material, hasStreamingMedia: boolean): number {
  if (!material.url) return 0;
  if (hasStreamingMedia && isOcsViewerUrl(material.url)) return 500;
  if (!hasStreamingMedia && isCanvasDirectFileUrl(material.url)) return 500;
  if (isCanvasWrapperUrl(material.url)) return 100;
  if (isOcsViewerUrl(material.url)) return 350;
  return 400;
}

function mergeMaterialGroup(group: Material[]): Material {
  const ranked = group
    .map((material, index) => ({ material, index }))
    .sort((a, b) => sourceRank(a.material.source) - sourceRank(b.material.source) || a.index - b.index);
  const primary = ranked[0].material;
  const hasStreamingMedia = group.some((material) => isStreamingMediaType(material.type));
  const locator = group
    .map((material, index) => ({ material, index }))
    .sort((a, b) => locatorRank(b.material, hasStreamingMedia) - locatorRank(a.material, hasStreamingMedia)
      || sourceRank(a.material.source) - sourceRank(b.material.source)
      || a.index - b.index)[0].material;
  const downloaded = ranked.find(({ material }) => material.is_downloaded && material.local_path)?.material;
  const moduleName = primary.module_name
    ?? ranked.find(({ material }) => material.module_name)?.material.module_name;
  const sources = [...new Set(group.map((material) => material.source))]
    .sort((a, b) => sourceRank(a) - sourceRank(b));
  const canvasFileId = primary.canvas_file_id
    ?? ranked.find(({ material }) => material.canvas_file_id)?.material.canvas_file_id;

  const merged: Material = {
    ...primary,
    ...(canvasFileId ? { canvas_file_id: canvasFileId } : {}),
    type: locator.type || primary.type,
    url: locator.url,
    sources,
    ...(locator.source !== primary.source ? { url_source: locator.source } : {}),
    ...(moduleName ? { module_name: moduleName } : {}),
    ...(group.some((material) => material.is_downloaded !== undefined)
      ? { is_downloaded: Boolean(downloaded) }
      : {}),
    ...(downloaded?.local_path ? { local_path: downloaded.local_path } : {}),
  };
  if (locator.source !== primary.source) {
    if (locator.is_playright_required === undefined) delete merged.is_playright_required;
    else merged.is_playright_required = locator.is_playright_required;
  }
  return merged;
}

function deduplicateMaterials(materials: Material[]): Material[] {
  const parent = materials.map((_, index) => index);
  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };
  const firstByKey = new Map<string, number>();

  materials.forEach((material, index) => {
    for (const key of materialIdentityKeys(material)) {
      const previous = firstByKey.get(key);
      if (previous === undefined) firstByKey.set(key, index);
      else union(previous, index);
    }
  });

  const groups = new Map<number, { first: number; materials: Material[] }>();
  materials.forEach((material, index) => {
    const root = find(index);
    const group = groups.get(root);
    if (group) group.materials.push(material);
    else groups.set(root, { first: index, materials: [material] });
  });

  return [...groups.values()]
    .sort((a, b) => a.first - b.first)
    .map(({ materials: group }) => mergeMaterialGroup(group));
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
  sources: MaterialSource[] = DEFAULT_SOURCES,
  cache?: FileCache,
): Promise<GetMaterialsResult> {
  const requested = uniqueSources(sources);
  if (requested.length === 0) {
    throw new Error('sources must not be empty');
  }

  let modulesPromise: Promise<RawModule[]> | null = null;
  const loadModules = (): Promise<RawModule[]> => {
    modulesPromise ??= client.fetchAll<RawModule>(
      `/api/v1/courses/${courseId}/modules`,
      { 'include[]': 'items', per_page: '50' },
    );
    return modulesPromise;
  };

  const settled = await Promise.allSettled(
    requested.map((source) => materialTask(source, client, session, courseId, loadModules, cache)),
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
    materials: deduplicateMaterials(materials),
    errors,
    warnings,
  };
}
