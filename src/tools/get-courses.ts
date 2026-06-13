import { CanvasClient } from '../canvas-client.js';
import type { Course } from '../types.js';

interface RawTerm {
  end_at?: string | null;
  start_at?: string | null;
}

interface RawCourse {
  id: number;
  name: string;
  term?: RawTerm | null;
}

/**
 * Returns only courses whose term is currently active (term.end_at is in the
 * future, or term has no end date but start_at is within the past 12 months).
 * Falls back to all active-enrollment courses if term data is unavailable.
 */
export async function getCourses(client: CanvasClient, currentOnly: boolean = true): Promise<Course[]> {
  const raw = await client.fetchAll<RawCourse>('/api/v1/courses', {
    enrollment_state: 'active',
    'include[]': 'term',
    per_page: '50',
  });

  const now = Date.now();
  const twelveMonthsAgo = now - 365 * 24 * 60 * 60 * 1000;

  return raw
    .filter((c) => c.name && c.name.trim() !== '')
    .filter((c) => {
      if (!currentOnly) return true;
      const term = c.term;
      if (!term) return true; // no term info — keep
      const endAt = term.end_at ? new Date(term.end_at).getTime() : null;
      const startAt = term.start_at ? new Date(term.start_at).getTime() : null;
      // Exclude if term already ended
      if (endAt !== null && endAt < now) return false;
      // Exclude if term started more than 12 months ago (and has no end date)
      if (endAt === null && startAt !== null && startAt < twelveMonthsAgo) return false;
      return true;
    })
    .map((c) => ({ id: c.id, name: c.name.trim() }));
}
