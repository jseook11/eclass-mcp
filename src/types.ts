// Course returned by eclass_get_courses
export interface Course {
  id: number;
  name: string;
}

// Assignment/quiz returned by eclass_get_assignments
export interface Assignment {
  assignment_id?: number;
  title: string;
  course_name: string;
  due_at: string | null;       // ISO 8601, KST
  is_submitted: boolean;
  is_missing: boolean;
  url: string | null;
  submission_types?: string[];
  allowed_extensions?: string[];
  allowed_attempts?: number | null;
}

// Announcement returned by eclass_get_announcements
export interface Announcement {
  id: number;
  title: string;
  author: string;
  posted_at: string | null;    // ISO 8601, KST
  message: string;
  has_attachment: boolean;
}

// Lecture module item returned by eclass_get_lectures
export interface Lecture {
  id: number;
  title: string;
  module_name: string;
  type: string;                // 'File' | 'ExternalTool' | 'Page' | etc.
  url: string | null;
  is_external_lti: boolean;    // true when type is ExternalTool (needs Playwright)
}

// Resource item from courseresource LTI intercept
export interface ResourceItem {
  id: string;
  title: string;
  url: string | null;
  type: string;
}

// LTI item metadata
export interface LTIItem {
  id: number;
  title: string;
  url: string;
}

// Legacy token cache. V1 did not retain the Canvas token id, so it must be
// rotated before use to make deterministic server-side revocation possible.
export interface CachedTokenV1 {
  token: string;
  expires_at: string;          // ISO 8601
}

export interface CachedTokenRevocation {
  id?: string;
  token_hint?: string;
}

// V2 retains all metadata needed to rotate and revoke Canvas API tokens.
export interface CachedTokenV2 {
  version: 2;
  token: string;
  id: string;
  token_hint: string;
  issued_at: string;           // ISO 8601
  expires_at: string;          // Actual server-returned ISO 8601 value
  pending_revocations: CachedTokenRevocation[];
}

export type CachedToken = CachedTokenV1 | CachedTokenV2;
