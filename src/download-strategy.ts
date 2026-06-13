import { isStreamingMediaType } from './browser-session.js';

// How a material should be fetched. `already_cached` is a runtime result state
// (decided by cache validation), not chosen by resolveDownloadStrategy.
export type DownloadStrategy =
  | 'already_cached'
  | 'canvas_file'
  | 'direct_url'
  | 'ocs_intercept'
  | 'playwright_ui'
  | 'unsupported_streaming_media';

const OCS_VIEWER_MARKER = 'ocs.cau.ac.kr/em/';

/**
 * Decides the transport strategy from a material's url and type. Mirrors the
 * branching previously inlined in index.ts:
 *  - streaming media types are unsupported
 *  - a null/empty url means a courseresource item that needs Playwright UI
 *  - an OCS viewer url is downloaded by intercepting the file response
 *  - an eclass3 url is a Canvas file (API redirect); anything else is a direct url
 */
export function resolveDownloadStrategy(
  url: string | null | undefined,
  type?: string | null,
): Exclude<DownloadStrategy, 'already_cached'> {
  if (isStreamingMediaType(type)) return 'unsupported_streaming_media';
  if (!url) return 'playwright_ui';
  if (url.includes(OCS_VIEWER_MARKER)) return 'ocs_intercept';
  try {
    if (new URL(url).hostname === 'eclass3.cau.ac.kr') return 'canvas_file';
  } catch {
    // fall through — treat unparseable as direct_url so the origin allowlist rejects it later
  }
  return 'direct_url';
}

export function isPlaywrightStrategy(strategy: DownloadStrategy): boolean {
  return strategy === 'ocs_intercept' || strategy === 'playwright_ui';
}

export function isDirectStrategy(strategy: DownloadStrategy): boolean {
  return strategy === 'canvas_file' || strategy === 'direct_url';
}
