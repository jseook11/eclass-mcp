import { downloadOne } from './download.js';
import type { DownloadDeps, DownloadItem, DownloadOutcome } from './download.js';

export interface BatchDownloadResult {
  ok: boolean;
  course_id: number;
  summary: {
    total: number;
    downloaded: number;
    skipped: number;
    failed: number;
  };
  results: DownloadOutcome[];
}

/**
 * Downloads a list of materials, one at a time, with partial success. With
 * continueOnError=false, stops at the first failure (already-finished results
 * are still returned). Downloads are sequential to avoid hammering eclass and
 * to keep the single shared Playwright session well-behaved.
 */
export async function downloadMaterialsBatch(
  deps: DownloadDeps,
  courseId: number,
  items: DownloadItem[],
  continueOnError: boolean = true,
): Promise<BatchDownloadResult> {
  const results: DownloadOutcome[] = [];

  for (const item of items) {
    const outcome = await downloadOne(deps, { ...item, course_id: item.course_id ?? courseId });
    results.push(outcome);
    if (!continueOnError && outcome.status === 'failed') break;
  }

  const downloaded = results.filter((r) => r.status === 'downloaded').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const failed = results.filter((r) => r.status === 'failed').length;

  return {
    ok: failed === 0,
    course_id: courseId,
    summary: { total: results.length, downloaded, skipped, failed },
    results,
  };
}
