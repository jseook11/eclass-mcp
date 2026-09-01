import { isStreamingMediaType } from './browser-session.js';

// How a material should be fetched. `already_cached` is a runtime result state
// (decided by cache validation), not chosen by resolveDownloadStrategy.
export type DownloadStrategy =
  | 'already_cached'
  | 'canvas_file'
  | 'direct_url'
  | 'ocs_intercept'
  | 'playwright_ui'
  | 'external_tool_launch'
  | 'unsupported_streaming_media';

export const OCS_VIEWER_MARKER = 'ocs.cau.ac.kr/em/';

/**
 * Decides the transport strategy from a material's url, type, and launch flag.
 * Type/flag beat URL host: ExternalTool wrapper pages on eclass3 are not
 * Canvas files.
 */
export function resolveDownloadStrategy(
  url: string | null | undefined,
  type?: string | null,
  isPlaywrightRequired?: boolean,
): Exclude<DownloadStrategy, 'already_cached'> {
  if (isStreamingMediaType(type)) return 'unsupported_streaming_media';
  if (isPlaywrightRequired || type === 'ExternalTool') return 'external_tool_launch';
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
  return strategy === 'ocs_intercept' || strategy === 'playwright_ui' || strategy === 'external_tool_launch';
}

export function isDirectStrategy(strategy: DownloadStrategy): boolean {
  return strategy === 'canvas_file' || strategy === 'direct_url';
}
