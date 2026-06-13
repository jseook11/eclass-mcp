import type { ExamCache, ExamSourceRecord } from '../../exam-cache.js';
import { discoverExamSources } from './notice-sources.js';

export interface ListExamSourcesResult {
  ok: boolean;
  sources: ExamSourceRecord[];
  partial_failures: Array<{ scope: string; reason: string; retryable: boolean }>;
}

export async function listExamSources(
  cache: ExamCache,
  input: { refresh?: boolean } = {},
): Promise<ListExamSourcesResult> {
  const partialFailures: ListExamSourcesResult['partial_failures'] = [];
  if (input.refresh) {
    const discovered = await discoverExamSources();
    for (const source of discovered.sources) cache.upsertExamSource(source);
    partialFailures.push(...discovered.issues);
  }
  return {
    ok: true,
    sources: cache.listExamSources(),
    partial_failures: partialFailures,
  };
}
