import Database from 'better-sqlite3';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { expandTilde } from './utils.js';

const DB_PATH = process.env.ECLASS_DB_PATH ?? '~/.eclass-mcp/files.db';

export interface DownloadRecord {
  file_id: string;
  course_id: number;
  display_name: string;
  local_path: string;
  downloaded_at: string;   // ISO 8601
  size_bytes: number;
  source?: string | null;  // material source (modules/files/courseresource/...) when known
}

export interface CachedCourse {
  course_id: number;
  name: string;
  fetched_at: string;
}

export interface SourceAccessDenial {
  course_id: number;
  source: string;
  denied_until: string;
  reason: string;
}

export class FileCache {
  private db: Database.Database;

  constructor() {
    const dbPath = expandTilde(DB_PATH);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS downloaded_files (
        file_id      TEXT PRIMARY KEY,
        course_id    INTEGER NOT NULL,
        display_name TEXT NOT NULL,
        local_path   TEXT NOT NULL,
        downloaded_at TEXT NOT NULL,
        size_bytes   INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS cached_courses (
        course_id   INTEGER PRIMARY KEY,
        name        TEXT NOT NULL,
        fetched_at  TEXT NOT NULL,
        is_current  INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS source_access_denials (
        course_id   INTEGER NOT NULL,
        source      TEXT NOT NULL,
        denied_until TEXT NOT NULL,
        reason      TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (course_id, source)
      )
    `);

    // Migration: add nullable `source` to downloaded_files for older DBs.
    const columns = this.db.prepare(`PRAGMA table_info(downloaded_files)`).all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === 'source')) {
      this.db.exec(`ALTER TABLE downloaded_files ADD COLUMN source TEXT`);
    }

    // Migration: legacy catalog entries remain available for exact course-name
    // lookups, but are not considered a current-semester snapshot until the
    // next successful live refresh.
    const courseColumns = this.db.prepare(`PRAGMA table_info(cached_courses)`).all() as Array<{ name: string }>;
    if (!courseColumns.some((c) => c.name === 'is_current')) {
      this.db.exec(`ALTER TABLE cached_courses ADD COLUMN is_current INTEGER NOT NULL DEFAULT 0`);
    }
  }

  getDb(): Database.Database {
    return this.db;
  }

  has(fileId: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM downloaded_files WHERE file_id = ?').get(fileId);
    return row !== undefined;
  }

  get(fileId: string): DownloadRecord | undefined {
    return this.db
      .prepare('SELECT * FROM downloaded_files WHERE file_id = ?')
      .get(fileId) as DownloadRecord | undefined;
  }

  record(entry: DownloadRecord): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO downloaded_files
        (file_id, course_id, display_name, local_path, downloaded_at, size_bytes, source)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(entry.file_id, entry.course_id, entry.display_name, entry.local_path, entry.downloaded_at, entry.size_bytes, entry.source ?? null);
  }

  list(courseId?: number): DownloadRecord[] {
    if (courseId !== undefined) {
      return this.db
        .prepare('SELECT * FROM downloaded_files WHERE course_id = ? ORDER BY downloaded_at DESC')
        .all(courseId) as DownloadRecord[];
    }
    return this.db
      .prepare('SELECT * FROM downloaded_files ORDER BY downloaded_at DESC')
      .all() as DownloadRecord[];
  }

  findByName(courseId: number, displayName: string): DownloadRecord | undefined {
    return this.db
      .prepare('SELECT * FROM downloaded_files WHERE course_id = ? AND display_name = ? ORDER BY downloaded_at DESC LIMIT 1')
      .get(courseId, displayName) as DownloadRecord | undefined;
  }

  remove(fileId: string): boolean {
    const result = this.db
      .prepare('DELETE FROM downloaded_files WHERE file_id = ?')
      .run(fileId);
    return result.changes > 0;
  }

  removeCourse(courseId: number): number {
    const result = this.db
      .prepare('DELETE FROM downloaded_files WHERE course_id = ?')
      .run(courseId);
    return result.changes;
  }

  upsertCourses(courses: Array<{ id: number; name: string }>, fetchedAt: string = new Date().toISOString()): void {
    // Backward-compatible alias for callers that predate current-semester
    // snapshots. A successful course-list fetch is authoritative, so omitted
    // courses must stop appearing in listCachedCourses().
    this.replaceCurrentCourses(courses, fetchedAt);
  }

  replaceCurrentCourses(courses: Array<{ id: number; name: string }>, fetchedAt: string = new Date().toISOString()): void {
    const markHistorical = this.db.prepare(`
      UPDATE cached_courses
      SET is_current = 0
      WHERE is_current <> 0
    `);

    const upsert = this.db.prepare(`
      INSERT INTO cached_courses (course_id, name, fetched_at, is_current)
      VALUES (?, ?, ?, 1)
      ON CONFLICT(course_id) DO UPDATE SET
        name = excluded.name,
        fetched_at = excluded.fetched_at,
        is_current = 1
    `);

    const tx = this.db.transaction((items: Array<{ id: number; name: string }>) => {
      markHistorical.run();
      for (const course of items) {
        upsert.run(course.id, course.name, fetchedAt);
      }
    });

    tx(courses);
  }

  listCachedCourses(): CachedCourse[] {
    return this.db
      .prepare('SELECT course_id, name, fetched_at FROM cached_courses WHERE is_current = 1 ORDER BY name COLLATE NOCASE ASC')
      .all() as CachedCourse[];
  }

  listCourseCatalog(): CachedCourse[] {
    return this.db
      .prepare('SELECT course_id, name, fetched_at FROM cached_courses ORDER BY name COLLATE NOCASE ASC')
      .all() as CachedCourse[];
  }

  getCachedCourse(courseId: number): CachedCourse | undefined {
    return this.db
      .prepare('SELECT course_id, name, fetched_at FROM cached_courses WHERE course_id = ?')
      .get(courseId) as CachedCourse | undefined;
  }

  getSourceAccessDenial(courseId: number, source: string): SourceAccessDenial | undefined {
    return this.db
      .prepare('SELECT course_id, source, denied_until, reason FROM source_access_denials WHERE course_id = ? AND source = ?')
      .get(courseId, source) as SourceAccessDenial | undefined;
  }

  setSourceAccessDenial(courseId: number, source: string, deniedUntil: string, reason = ''): void {
    this.db.prepare(`
      INSERT INTO source_access_denials (course_id, source, denied_until, reason)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(course_id, source) DO UPDATE SET
        denied_until = excluded.denied_until,
        reason = excluded.reason
    `).run(courseId, source, deniedUntil, reason);
  }

  clearSourceAccessDenial(courseId: number, source: string): void {
    this.db
      .prepare('DELETE FROM source_access_denials WHERE course_id = ? AND source = ?')
      .run(courseId, source);
  }
}
