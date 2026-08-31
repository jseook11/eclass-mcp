import type { ResourceItem } from './types.js';
import { debugLog } from './secrets.js';

/**
 * Extracts ResourceItem array from the raw JSON body returned by LearningX
 * resources_db. The exact shape varies, so this accepts direct arrays and a
 * handful of common top-level collection keys.
 *
 * strict: throw on an unrecognized shape instead of returning [] — the API
 * caller treats that as a fetch failure and falls back to the Playwright
 * intercept, rather than silently reporting zero materials.
 */
export function parseResourceItems(body: unknown, options: { strict?: boolean } = {}): ResourceItem[] {
  if (Array.isArray(body)) {
    return body.map(itemToResourceItem).filter((r): r is ResourceItem => r !== null);
  }

  if (body && typeof body === 'object') {
    const obj = body as Record<string, unknown>;
    for (const key of ['items', 'resources', 'data', 'results', 'list']) {
      if (Array.isArray(obj[key])) {
        return (obj[key] as unknown[])
          .map(itemToResourceItem)
          .filter((r): r is ResourceItem => r !== null);
      }
    }
  }

  if (options.strict) {
    throw new Error('Unexpected resources_db response shape');
  }
  debugLog('resource-items', 'Unexpected resources_db shape; returning empty list');
  return [];
}

export class LearningPeriodNotStartedError extends Error {
  readonly code = 'LEARNING_PERIOD_NOT_STARTED';
  readonly unlockAt: string | null;

  constructor(unlockAt: string | null = null) {
    super(
      unlockAt
        ? `현재 학습 기간이 아닙니다. 학습 시작: ${unlockAt}`
        : '현재 학습 기간이 아닙니다.',
    );
    this.name = 'LearningPeriodNotStartedError';
    this.unlockAt = unlockAt;
  }
}

export function parseModulebuilderItems(body: unknown): ResourceItem[] {
  if (!Array.isArray(body)) return [];
  const results: ResourceItem[] = [];
  let hasNotStartedItem = false;
  let unlockAt: string | null = null;
  for (const mod of body) {
    if (!mod || typeof mod !== 'object') continue;
    const moduleObject = mod as Record<string, unknown>;
    const moduleUnlockAt = typeof moduleObject['unlock_at'] === 'string'
      ? moduleObject['unlock_at'].trim() || null
      : null;
    const items = moduleObject['module_items'];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      const cd = obj['content_data'];
      if (!cd || typeof cd !== 'object') continue;
      const contentData = cd as Record<string, unknown>;
      if (contentData['item_content_type'] !== 'commons') continue;

      const lecturePeriodStatus = typeof contentData['lecture_period_status'] === 'string'
        ? contentData['lecture_period_status'].trim().toLowerCase()
        : null;
      const itemUnlockAt = typeof contentData['unlock_at'] === 'string'
        ? contentData['unlock_at'].trim() || null
        : null;
      const markNotStarted = (): void => {
        hasNotStartedItem = true;
        if (unlockAt === null) unlockAt = itemUnlockAt ?? moduleUnlockAt;
      };
      if (lecturePeriodStatus === 'not_open') {
        markNotStarted();
        continue;
      }

      const icd = contentData['item_content_data'];
      if (!icd || typeof icd !== 'object') continue;
      const itemContentData = icd as Record<string, unknown>;
      const contentId = typeof itemContentData['content_id'] === 'string' ? itemContentData['content_id'] : null;

      if (contentId?.trim().toLowerCase() === 'not_open') {
        markNotStarted();
        continue;
      }

      if (!contentId) continue;
      results.push({
        id: String(obj['module_item_id'] ?? ''),
        title: String(obj['title'] ?? ''),
        url: `https://ocs.cau.ac.kr/em/${contentId}`,
        type: String(itemContentData['content_type'] ?? 'commons'),
      });
    }
  }

  if (results.length === 0 && hasNotStartedItem) {
    throw new LearningPeriodNotStartedError(unlockAt);
  }

  return results;
}

function itemToResourceItem(raw: unknown): ResourceItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const id = String(obj['id'] ?? obj['resource_id'] ?? '');
  const title = String(obj['title'] ?? obj['name'] ?? '');
  const type = String(obj['type'] ?? obj['resource_type'] ?? '');

  const commonsContent =
    obj['commons_content'] !== null && typeof obj['commons_content'] === 'object'
      ? (obj['commons_content'] as Record<string, unknown>)
      : null;
  const ocsViewUrl =
    commonsContent && typeof commonsContent['view_url'] === 'string'
      ? commonsContent['view_url']
      : null;

  const url =
    (typeof obj['url'] === 'string' ? obj['url'] : null) ??
    (typeof obj['download_url'] === 'string' ? obj['download_url'] : null) ??
    (typeof obj['file_url'] === 'string' ? obj['file_url'] : null) ??
    (typeof obj['href'] === 'string' ? obj['href'] : null) ??
    ocsViewUrl;

  if (!id) return null;

  return { id, title, url, type };
}
