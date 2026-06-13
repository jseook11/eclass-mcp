import { CanvasClient } from '../canvas-client.js';
import type { Lecture } from '../types.js';

const BASE_URL = 'https://eclass3.cau.ac.kr';

interface RawModuleItem {
  id: number;
  title: string;
  type: string;
  html_url?: string | null;
  external_url?: string | null;
}

interface RawModule {
  id: number;
  name: string;
  items?: RawModuleItem[];
}

export async function getLectures(
  client: CanvasClient,
  courseId: number,
  week?: number,
): Promise<Lecture[]> {
  const raw = await client.fetchAll<RawModule>(
    `/api/v1/courses/${courseId}/modules`,
    {
      'include[]': 'items',
      per_page: '50',
    },
  );

  const lectures: Lecture[] = [];

  for (const module of raw) {
    if (week !== undefined && !module.name.includes(String(week))) {
      continue;
    }

    const items = module.items ?? [];
    for (const item of items) {
      const is_external_lti = item.type === 'ExternalTool';
      const url = item.html_url
        ? BASE_URL + item.html_url
        : item.external_url ?? null;

      lectures.push({
        id: item.id,
        title: item.title,
        module_name: module.name,
        type: item.type,
        url,
        is_external_lti,
      });
    }
  }

  return lectures;
}
