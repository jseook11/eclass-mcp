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

// Cached token structure
export interface CachedToken {
  token: string;
  expires_at: string;          // ISO 8601
}
