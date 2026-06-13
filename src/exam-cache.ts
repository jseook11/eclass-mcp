import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { expandTilde } from './utils.js';

function getDbPath(): string {
  return process.env.ECLASS_EXAM_DB_PATH ?? '~/.eclass-mcp/exams.db';
}

export type CourseMetadataSource = 'learningx_sis' | 'canvas_only';

export interface CourseMetadataRecord {
  course_id: number;
  course_name: string;
  term?: string | null;
  canvas_course_code?: string | null;
  canvas_sis_course_id?: string | null;
  // Canvas account(개설 조직) 이름 원문 — 예: "소프트웨어대학 소프트웨어학부".
  // college/department 파싱이 안 되는 형태("대학(전체)" 등)여도 LLM 판단용으로 보존한다.
  canvas_account_name?: string | null;
  // 확정값 — course_code/section/term은 LearningX sis_source_id 파싱,
  // college/department는 Canvas account 이름 파싱에서 온다.
  college?: string | null;
  department?: string | null;
  instructor?: string | null;
  course_code?: string | null;
  section?: string | null;
  source: CourseMetadataSource;
  sis_error?: string | null;
  fetched_at: string;
}

export interface ExamSourceRecord {
  id?: number;
  college: string;
  department?: string | null;
  homepage_url?: string | null;
  notice_board_url: string;
  adapter_type: string;
  last_checked_at?: string | null;
  last_status?: string | null;
  last_error?: string | null;
}

export interface ExamDocumentRecord {
  id?: number;
  term: string;
  exam_type: string;
  source_id?: number | null;
  notice_url: string;
  title: string;
  posted_at?: string | null;
  body_hash: string;
  attachment_url: string;
  attachment_name: string;
  file_hash: string;
  local_pdf_path: string;
  diff_status: 'new' | 'unchanged' | 'updated';
  fetched_at: string;
}

export interface ExamScheduleRecord {
  id?: number;
  source_document_id: number;
  term: string;
  exam_type: string;
  course_code?: string | null;
  course_name: string;
  section?: string | null;
  lecture_time?: string | null;
  instructor?: string | null;
  exam_method?: string | null;
  exam_date?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  building?: string | null;
  rooms?: string | null;
  note?: string | null;
  raw_text?: string | null;
}

export interface ExamScheduleMatch extends ExamScheduleRecord {
  source_title?: string | null;
  source_notice_url?: string | null;
  source_pdf_path?: string | null;
}

const EXAM_DB_VERSION = 3;

// 강의명 정규화: 공백 제거 + 끝의 "NN분반" 표기 제거 + 소문자.
// 교양 PDF는 "과학기술과현대사회", Canvas/SIS는 "과학기술과현대사회 02분반"처럼
// 분반 표기가 달라 exact 문자열 비교가 실패하므로 정규화 후 비교한다.
export function normalizeCourseName(name: string): string {
  return name
    .replace(/\s+/g, '')
    .replace(/\d+\s*분반$/, '')
    .toLowerCase();
}

// 분반 정규화: leading zero 차이("2" vs "02")를 무시한다.
export function normalizeSection(section: string): string {
  const trimmed = section.trim();
  return /^\d+$/.test(trimmed) ? String(Number(trimmed)) : trimmed.toLowerCase();
}

export class ExamCache {
  private db: Database.Database;

  constructor() {
    const dbPath = expandTilde(getDbPath());
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS course_metadata (
        course_id            INTEGER PRIMARY KEY,
        course_name          TEXT NOT NULL,
        term                 TEXT,
        canvas_course_code   TEXT,
        canvas_sis_course_id TEXT,
        canvas_account_name  TEXT,
        college              TEXT,
        department           TEXT,
        instructor           TEXT,
        course_code          TEXT,
        section              TEXT,
        source               TEXT NOT NULL CHECK (source IN ('learningx_sis', 'canvas_only')),
        sis_error            TEXT,
        fetched_at           TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS exam_sources (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        college          TEXT NOT NULL,
        department       TEXT,
        homepage_url     TEXT,
        notice_board_url TEXT NOT NULL UNIQUE,
        adapter_type     TEXT NOT NULL,
        last_checked_at  TEXT,
        last_status      TEXT,
        last_error       TEXT
      );

      CREATE TABLE IF NOT EXISTS exam_documents (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        term            TEXT NOT NULL,
        exam_type       TEXT NOT NULL,
        source_id       INTEGER,
        notice_url      TEXT NOT NULL,
        title           TEXT NOT NULL,
        posted_at       TEXT,
        body_hash       TEXT NOT NULL,
        attachment_url  TEXT NOT NULL,
        attachment_name TEXT NOT NULL,
        file_hash       TEXT NOT NULL,
        local_pdf_path  TEXT NOT NULL,
        diff_status     TEXT NOT NULL,
        fetched_at      TEXT NOT NULL,
        UNIQUE(term, exam_type, attachment_url)
      );

      CREATE TABLE IF NOT EXISTS exam_schedules (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        source_document_id INTEGER NOT NULL,
        term               TEXT NOT NULL,
        exam_type          TEXT NOT NULL,
        course_code        TEXT,
        course_name        TEXT NOT NULL,
        section            TEXT,
        lecture_time       TEXT,
        instructor         TEXT,
        exam_method        TEXT,
        exam_date          TEXT,
        start_time         TEXT,
        end_time           TEXT,
        building           TEXT,
        rooms              TEXT,
        note               TEXT,
        raw_text           TEXT,
        FOREIGN KEY(source_document_id) REFERENCES exam_documents(id)
      );

      CREATE INDEX IF NOT EXISTS idx_exam_schedules_lookup
        ON exam_schedules(term, exam_type, course_code, course_name, section);
      CREATE INDEX IF NOT EXISTS idx_exam_schedules_document
        ON exam_schedules(source_document_id);
    `);
    if (Number(this.db.pragma('user_version', { simple: true })) !== EXAM_DB_VERSION) {
      this.db.pragma(`user_version = ${EXAM_DB_VERSION}`);
    }
  }

  // PRAGMA user_version 기반 migration. 로컬 캐시 DB라 데이터 유실은 허용되지만,
  // 실패는 명확한 에러로 표면화한다.
  private migrate(): void {
    const version = Number(this.db.pragma('user_version', { simple: true }));
    if (version >= EXAM_DB_VERSION) return;
    try {
      // v1 → v2: course_metadata에서 confidence 컬럼 제거 + canvas_*/sis_error 추가.
      // v2 → v3: canvas_account_name 컬럼 추가.
      // 동기화로 다시 채울 수 있는 캐시이므로 테이블 재생성으로 처리한다.
      const tx = this.db.transaction(() => {
        const hasV1Table = this.db.prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'course_metadata'",
        ).get() !== undefined;
        if (hasV1Table) {
          this.db.exec('DROP TABLE course_metadata');
        }
      });
      tx();
    } catch (err) {
      throw new Error(
        `exam DB migration v${version} → v${EXAM_DB_VERSION} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  getDb(): Database.Database {
    return this.db;
  }

  upsertCourseMetadata(records: CourseMetadataRecord[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO course_metadata
        (course_id, course_name, term, canvas_course_code, canvas_sis_course_id, canvas_account_name, college, department, instructor, course_code, section, source, sis_error, fetched_at)
      VALUES
        (@course_id, @course_name, @term, @canvas_course_code, @canvas_sis_course_id, @canvas_account_name, @college, @department, @instructor, @course_code, @section, @source, @sis_error, @fetched_at)
      ON CONFLICT(course_id) DO UPDATE SET
        course_name=excluded.course_name,
        term=excluded.term,
        canvas_course_code=excluded.canvas_course_code,
        canvas_sis_course_id=excluded.canvas_sis_course_id,
        canvas_account_name=excluded.canvas_account_name,
        college=excluded.college,
        department=excluded.department,
        instructor=excluded.instructor,
        course_code=excluded.course_code,
        section=excluded.section,
        source=excluded.source,
        sis_error=excluded.sis_error,
        fetched_at=excluded.fetched_at
    `);
    const tx = this.db.transaction((items: CourseMetadataRecord[]) => {
      for (const record of items) {
        stmt.run({
          ...record,
          term: record.term ?? null,
          canvas_course_code: record.canvas_course_code ?? null,
          canvas_sis_course_id: record.canvas_sis_course_id ?? null,
          canvas_account_name: record.canvas_account_name ?? null,
          college: record.college ?? null,
          department: record.department ?? null,
          instructor: record.instructor ?? null,
          course_code: record.course_code ?? null,
          section: record.section ?? null,
          sis_error: record.sis_error ?? null,
        });
      }
    });
    tx(records);
  }

  getCourseMetadata(courseId: number): CourseMetadataRecord | undefined {
    return this.db.prepare('SELECT * FROM course_metadata WHERE course_id = ?')
      .get(courseId) as CourseMetadataRecord | undefined;
  }

  listCourseMetadata(): CourseMetadataRecord[] {
    return this.db.prepare('SELECT * FROM course_metadata ORDER BY course_name COLLATE NOCASE ASC')
      .all() as CourseMetadataRecord[];
  }

  upsertExamSource(source: ExamSourceRecord): number {
    const normalized = {
      college: source.college,
      department: source.department ?? null,
      homepage_url: source.homepage_url ?? null,
      notice_board_url: source.notice_board_url,
      adapter_type: source.adapter_type,
      last_checked_at: source.last_checked_at ?? null,
      last_status: source.last_status ?? null,
      last_error: source.last_error ?? null,
    };
    const existing = this.db.prepare('SELECT id FROM exam_sources WHERE notice_board_url = ?')
      .get(source.notice_board_url) as { id: number } | undefined;
    if (existing) {
      this.db.prepare(`
        UPDATE exam_sources SET
          college=@college,
          department=@department,
          homepage_url=@homepage_url,
          adapter_type=@adapter_type,
          last_checked_at=COALESCE(@last_checked_at, last_checked_at),
          last_status=COALESCE(@last_status, last_status),
          last_error=@last_error
        WHERE id=@id
      `).run({ ...normalized, id: existing.id });
      return existing.id;
    }

    const result = this.db.prepare(`
      INSERT INTO exam_sources
        (college, department, homepage_url, notice_board_url, adapter_type, last_checked_at, last_status, last_error)
      VALUES
        (@college, @department, @homepage_url, @notice_board_url, @adapter_type, @last_checked_at, @last_status, @last_error)
    `).run(normalized);
    return Number(result.lastInsertRowid);
  }

  updateExamSourceStatus(id: number, status: string, checkedAt: string, error?: string | null): void {
    this.db.prepare(`
      UPDATE exam_sources
      SET last_checked_at = ?, last_status = ?, last_error = ?
      WHERE id = ?
    `).run(checkedAt, status, error ?? null, id);
  }

  listExamSources(): ExamSourceRecord[] {
    return this.db.prepare('SELECT * FROM exam_sources ORDER BY college COLLATE NOCASE ASC')
      .all() as ExamSourceRecord[];
  }

  findExamDocument(term: string, examType: string, attachmentUrl: string): ExamDocumentRecord | undefined {
    return this.db.prepare(`
      SELECT * FROM exam_documents
      WHERE term = ? AND exam_type = ? AND attachment_url = ?
    `).get(term, examType, attachmentUrl) as ExamDocumentRecord | undefined;
  }

  upsertExamDocument(document: ExamDocumentRecord): number {
    const existing = this.findExamDocument(document.term, document.exam_type, document.attachment_url);
    if (existing) {
      this.db.prepare(`
        UPDATE exam_documents SET
          source_id=@source_id,
          notice_url=@notice_url,
          title=@title,
          posted_at=@posted_at,
          body_hash=@body_hash,
          attachment_name=@attachment_name,
          file_hash=@file_hash,
          local_pdf_path=@local_pdf_path,
          diff_status=@diff_status,
          fetched_at=@fetched_at
        WHERE id=@id
      `).run({ ...document, id: existing.id });
      return existing.id!;
    }

    const result = this.db.prepare(`
      INSERT INTO exam_documents
        (term, exam_type, source_id, notice_url, title, posted_at, body_hash, attachment_url, attachment_name, file_hash, local_pdf_path, diff_status, fetched_at)
      VALUES
        (@term, @exam_type, @source_id, @notice_url, @title, @posted_at, @body_hash, @attachment_url, @attachment_name, @file_hash, @local_pdf_path, @diff_status, @fetched_at)
    `).run(document);
    return Number(result.lastInsertRowid);
  }

  replaceSchedules(documentId: number, schedules: Omit<ExamScheduleRecord, 'id' | 'source_document_id'>[]): void {
    const deleteStmt = this.db.prepare('DELETE FROM exam_schedules WHERE source_document_id = ?');
    const insertStmt = this.db.prepare(`
      INSERT INTO exam_schedules
        (source_document_id, term, exam_type, course_code, course_name, section, lecture_time, instructor, exam_method, exam_date, start_time, end_time, building, rooms, note, raw_text)
      VALUES
        (@source_document_id, @term, @exam_type, @course_code, @course_name, @section, @lecture_time, @instructor, @exam_method, @exam_date, @start_time, @end_time, @building, @rooms, @note, @raw_text)
    `);
    const tx = this.db.transaction(() => {
      deleteStmt.run(documentId);
      for (const schedule of schedules) {
        insertStmt.run({ ...schedule, source_document_id: documentId });
      }
    });
    tx();
  }

  // course_code + section exact match. fuzzy matching 없음 — 실패 판단은 호출자가 한다.
  findSchedulesExact(input: {
    course_code: string;
    section: string;
    term?: string;
    exam_type?: string;
  }): ExamScheduleMatch[] {
    const params: unknown[] = [input.course_code, input.section];
    const where = ['s.course_code = ?', 's.section = ?'];
    if (input.term) {
      where.push('s.term = ?');
      params.push(input.term);
    }
    if (input.exam_type) {
      where.push('s.exam_type = ?');
      params.push(input.exam_type);
    }
    return this.selectSchedules(where, params, 100);
  }

  // 강의명(정규화) + 분반(정규화) 매칭. 교양 PDF처럼 course_code가 없는 소스에서
  // course_id → schedule 연결에 쓴다. SQL로 좁히기 어려운 정규화 비교라 JS에서 필터한다.
  findSchedulesByNameSection(input: {
    course_name: string;
    section?: string | null;
    term?: string;
    exam_type?: string;
  }): ExamScheduleMatch[] {
    const targetName = normalizeCourseName(input.course_name);
    const targetSection = input.section != null ? normalizeSection(input.section) : null;
    return this.listSchedules({ term: input.term, exam_type: input.exam_type, limit: 2000 })
      .filter((row) => {
        if (normalizeCourseName(row.course_name) !== targetName) return false;
        if (targetSection == null) return true;
        return row.section != null && normalizeSection(row.section) === targetSection;
      });
  }

  // term/exam_type 범위의 schedule row 목록. query는 단순 LIKE 필터(LLM이 후보를 직접 판단).
  listSchedules(input: {
    term?: string;
    exam_type?: string;
    query?: string;
    limit?: number;
  }): ExamScheduleMatch[] {
    const params: unknown[] = [];
    const where: string[] = [];
    if (input.term) {
      where.push('s.term = ?');
      params.push(input.term);
    }
    if (input.exam_type) {
      where.push('s.exam_type = ?');
      params.push(input.exam_type);
    }
    if (input.query?.trim()) {
      where.push('(s.course_name LIKE ? OR s.course_code LIKE ? OR s.instructor LIKE ?)');
      const q = `%${input.query.trim()}%`;
      params.push(q, q, q);
    }
    return this.selectSchedules(where, params, input.limit ?? 200);
  }

  private selectSchedules(where: string[], params: unknown[], limit: number): ExamScheduleMatch[] {
    const sql = `
      SELECT
        s.*,
        d.title AS source_title,
        d.notice_url AS source_notice_url,
        d.local_pdf_path AS source_pdf_path
      FROM exam_schedules s
      LEFT JOIN exam_documents d ON d.id = s.source_document_id
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY s.exam_date IS NULL, s.exam_date ASC, s.start_time IS NULL, s.start_time ASC, s.course_name COLLATE NOCASE ASC
      LIMIT ?
    `;
    return this.db.prepare(sql).all(...params, limit) as ExamScheduleMatch[];
  }
}
