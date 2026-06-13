import * as os from 'node:os';
import * as path from 'node:path';

export function expandTilde(p: string): string {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

/**
 * Sanitizes a server-provided display name into a safe local filename.
 * Unicode-aware: keeps letters/digits in any script (한글 포함) so distinct
 * Korean filenames stay distinct instead of collapsing to underscores and
 * silently overwriting each other. Returns null when nothing usable remains.
 */
export function sanitizeFileName(displayName: string): string | null {
  const safe = path.basename(displayName).replace(/[^\p{L}\p{N}\s._\-]/gu, '_');
  if (!safe || safe === '.' || safe === '..') return null;
  return safe;
}
