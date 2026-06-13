import { CanvasClient } from '../canvas-client.js';
import type { Announcement } from '../types.js';

const KST_OFFSET = 9 * 60 * 60 * 1000;
const pad = (n: number) => String(n).padStart(2, '0');

function toKstIso(dt: Date): string {
  const kst = new Date(dt.getTime() + KST_OFFSET);
  return `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth() + 1)}-${pad(kst.getUTCDate())}T` +
         `${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())}:${pad(kst.getUTCSeconds())}.000+09:00`;
}

function parseIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const dt = new Date(value);
  if (isNaN(dt.getTime())) return null;
  return toKstIso(dt);
}

function stripHtml(str: string): string {
  return str.replace(/<[^>]+>/g, '').trim();
}

interface RawAnnouncement {
  id: number;
  title: string;
  author?: { display_name?: string };
  posted_at?: string | null;
  message?: string | null;
  attachments?: unknown[];
}

export async function getAnnouncements(
  client: CanvasClient,
  courseId: number,
  limit: number = 20,
): Promise<Announcement[]> {
  const raw = await client.fetchAll<RawAnnouncement>(
    `/api/v1/courses/${courseId}/discussion_topics`,
    {
      only_announcements: 'true',
      per_page: String(limit),
    },
  );

  return raw.slice(0, limit).map((item) => ({
    id: item.id,
    title: item.title,
    author: item.author?.display_name ?? '',
    posted_at: parseIso(item.posted_at),
    message: stripHtml(item.message ?? ''),
    has_attachment: Array.isArray(item.attachments) && item.attachments.length > 0,
  }));
}
