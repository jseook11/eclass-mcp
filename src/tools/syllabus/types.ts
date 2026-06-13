// 강의계획서 검색 결과 1행 (selectList.ajax 정규화)
export interface SyllabusSearchItem {
  year: string;
  term: string;          // shtm
  campus_code: string;   // campcd
  course_code: string;   // sbjtno1 (학수번호)
  section: string;       // clssno1 (분반)
  course_no_full: string; // sbjtno ("15841-01")
  course_name: string;   // kornm
  sust_code: string;     // sust
  college: string | null;     // colgnm 앞부분
  department: string | null;  // colgnm 뒷부분(<br> 분리)
  classification: string | null; // shtnm (전필/전공 등)
  professor: string | null;   // profnm
  time_room: string | null;   // ltbdrm
  has_file: boolean;          // fileusefg != null
}

export interface SyllabusTextbook {
  kind: string | null;   // 주교재/참고 등
  title: string | null;
  author: string | null;
  year: string | null;
  publisher: string | null;
  edition: string | null;
}

export interface SyllabusAssessment {
  item: string;          // 출결/중간시험/기말시험 ...
  ratio: number | null;  // %
  description: string | null;
}

export interface SyllabusScheduleWeek {
  week: number;
  instructor: string | null;
  topic: string | null;
  student_assignment: string | null;
  instructor_assignment: string | null;
}

export interface SyllabusDocument {
  basic: {
    year: string | null;
    term: string | null;
    campus: string | null;
    course_code: string | null;
    section: string | null;
    credit: string | null;
    title_ko: string | null;
    title_en: string | null;
    time_room: string | null;
    classification: string | null;
    lecture_type: string | null;
    course_type: string | null;
    medium: string | null;
    college: string | null;
    department: string | null;
    eclass_usage: string | null;
  };
  instructor: {
    name: string | null;
    email: string | null;
    office_phone: string | null;
    contact: string | null;
    office_hour: string | null;
    office_location: string | null;
    homepage: string | null;
  };
  objectives: {
    description: string | null;
    prerequisites: string | null;
    learning_objectives: string | null;
    learning_outcomes: string | null;
  };
  textbooks: SyllabusTextbook[];
  assessment: SyllabusAssessment[];
  schedule: SyllabusScheduleWeek[];
  raw_text: string; // 파싱 누락분 fallback (항상 포함)
}
