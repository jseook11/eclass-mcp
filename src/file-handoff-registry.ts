import { randomBytes } from 'node:crypto';

// In-memory registry mapping an opaque download token to a file on disk.
// Used by the HTTP transport so eclass_file_handoff can return a tiny URL
// instead of an inline base64 blob (which would consume model context). The
// MCP tool and the HTTP download route share this singleton because the HTTP
// transport runs the MCP server in-process (see src/index.ts).

export interface HandoffEntry {
  localPath: string;
  displayName: string;
  mimeType: string;
  sizeBytes: number;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour

const entries = new Map<string, HandoffEntry>();

export function registerHandoff(
  entry: Omit<HandoffEntry, 'expiresAt'>,
  opts: { ttlMs?: number; now?: number } = {},
): string {
  const now = opts.now ?? Date.now();
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  pruneHandoffs(now); // keep the map bounded on a long-running server
  const token = randomBytes(24).toString('base64url');
  entries.set(token, { ...entry, expiresAt: now + ttlMs });
  return token;
}

// Peek does not delete: a browser may retry the download within the TTL.
export function getHandoff(token: string, now: number = Date.now()): HandoffEntry | undefined {
  const entry = entries.get(token);
  if (!entry) return undefined;
  if (now > entry.expiresAt) {
    entries.delete(token);
    return undefined;
  }
  return entry;
}

export function pruneHandoffs(now: number = Date.now()): void {
  for (const [token, entry] of entries) {
    if (now > entry.expiresAt) entries.delete(token);
  }
}

// Test seam.
export function clearHandoffs(): void {
  entries.clear();
}
