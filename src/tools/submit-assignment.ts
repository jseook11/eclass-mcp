import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { CanvasClient } from '../canvas-client.js';
import { toErrorResult } from '../errors.js';
import type { ToolErrorResult } from '../errors.js';
import { getAssignmentDetail } from './get-assignment-detail.js';
import type { AssignmentDetail } from './get-assignment-detail.js';

export interface SubmitAssignmentInput {
  course_id: number;
  assignment_id: number;
  file_paths?: string[];
  body?: string;
  comment?: string;
  dry_run?: boolean;
  confirm_resubmit?: boolean;
}

export interface SubmitAssignmentResult {
  ok: true;
  mode: 'dry_run' | 'submitted';
  already_submitted: boolean;
  is_resubmission: boolean;
  validation: {
    submission_type_ok: boolean;
    extensions_ok: boolean;
    lock_ok: boolean;
  };
  strategy: 'canvas_api' | 'playwright_ui';
  submitted_at?: string | null;
  attempt?: number | null;
  verification?: {
    checked: boolean;
    has_submitted: boolean;
    attempt_increased?: boolean;
  };
}

type SubmitAssignmentValidation = SubmitAssignmentResult['validation'];

export interface SubmitAssignmentSession {
  submitAssignmentViaUi(
    courseId: number,
    assignmentId: number,
    filePaths: string[],
    comment?: string,
  ): Promise<void>;
}

interface LocalFile {
  original_path: string;
  absolute_path: string;
  name: string;
  size: number;
  content_type: string;
}

interface UploadTokenResponse {
  upload_url?: string;
  upload_params?: Record<string, string | number | boolean | null | undefined>;
}

interface UploadedFileResponse {
  id?: number | string;
  attachment?: { id?: number | string };
}

type SubmissionType = 'online_upload' | 'online_text_entry';

const ECLASS_ORIGIN = 'https://eclass3.cau.ac.kr';

const UPLOAD_ALLOWED_ORIGINS = new Set([
  ECLASS_ORIGIN,
  'https://kr.object.gov-ncloudstorage.com',
]);

const UPLOAD_TIMEOUT_MS = 120_000;
const FINALIZE_TIMEOUT_MS = 30_000;

function expandTilde(filePath: string): string {
  if (filePath === '~') return os.homedir();
  if (filePath.startsWith('~/')) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

function normalizeExtension(filePath: string): string {
  return path.extname(filePath).replace(/^\./, '').toLowerCase();
}

function guessContentType(filePath: string): string {
  const extension = normalizeExtension(filePath);
  switch (extension) {
    case 'pdf':
      return 'application/pdf';
    case 'txt':
      return 'text/plain';
    case 'doc':
      return 'application/msword';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'hwp':
      return 'application/x-hwp';
    case 'hwpx':
      return 'application/vnd.hancom.hwpx';
    default:
      return 'application/octet-stream';
  }
}

function chooseSubmissionType(input: SubmitAssignmentInput): SubmissionType | ToolErrorResult {
  const hasFiles = (input.file_paths?.length ?? 0) > 0;
  const hasBody = Boolean(input.body?.trim());
  if (hasFiles && hasBody) {
    return toErrorResult(
      'ASSIGNMENT_SUBMISSION_AMBIGUOUS',
      '파일 업로드와 본문 제출을 동시에 지정할 수 없습니다.',
      { retryable: false, nextAction: 'file_paths 또는 body 중 하나만 지정하세요.' },
    );
  }
  if (hasFiles) return 'online_upload';
  if (hasBody) return 'online_text_entry';
  return toErrorResult(
    'ASSIGNMENT_SUBMISSION_EMPTY',
    '제출할 파일 또는 본문이 없습니다.',
    { retryable: false, nextAction: 'file_paths 또는 body를 지정하세요.' },
  );
}

async function collectFiles(filePaths: string[] | undefined): Promise<LocalFile[] | ToolErrorResult> {
  const files: LocalFile[] = [];
  for (const originalPath of filePaths ?? []) {
    const absolutePath = path.resolve(expandTilde(originalPath));
    let stat;
    try {
      stat = await fs.stat(absolutePath);
    } catch (err) {
      return toErrorResult(
        'SUBMISSION_FILE_NOT_FOUND',
        '제출 파일을 찾을 수 없습니다.',
        { err, retryable: false, nextAction: 'file_paths의 로컬 경로를 확인하세요.' },
      );
    }
    if (!stat.isFile()) {
      return toErrorResult(
        'SUBMISSION_FILE_NOT_FOUND',
        '제출 경로가 일반 파일이 아닙니다.',
        { retryable: false, nextAction: 'file_paths에는 파일 경로만 지정하세요.' },
      );
    }
    files.push({
      original_path: originalPath,
      absolute_path: absolutePath,
      name: path.basename(absolutePath),
      size: stat.size,
      content_type: guessContentType(absolutePath),
    });
  }
  return files;
}

function validateAssignment(
  detail: AssignmentDetail,
  submissionType: SubmissionType,
  files: LocalFile[],
  confirmResubmit: boolean,
  now = new Date(),
): ToolErrorResult | SubmitAssignmentValidation {
  const assignment = detail.assignment;
  const supportsType = assignment.submission_types.includes(submissionType);
  if (!supportsType) {
    return toErrorResult(
      'ASSIGNMENT_SUBMISSION_UNSUPPORTED_TYPE',
      '이 과제는 요청한 제출 유형을 지원하지 않습니다.',
      { retryable: false, nextAction: '과제 상세의 submission_types를 확인하세요.' },
    );
  }

  const allowedExtensions = assignment.allowed_extensions.map((ext) => ext.replace(/^\./, '').toLowerCase());
  const extensionsOk = allowedExtensions.length === 0 || files.every((file) => allowedExtensions.includes(normalizeExtension(file.name)));
  if (!extensionsOk) {
    return toErrorResult(
      'ASSIGNMENT_EXTENSION_NOT_ALLOWED',
      '제출 파일 확장자가 이 과제에서 허용되지 않습니다.',
      { retryable: false, nextAction: `허용 확장자: ${allowedExtensions.join(', ') || '(제한 없음)'}` },
    );
  }

  const unlockAt = assignment.unlock_at ? new Date(assignment.unlock_at) : null;
  const lockAt = assignment.lock_at ? new Date(assignment.lock_at) : null;
  const lockOk = (!unlockAt || now >= unlockAt) && (!lockAt || now <= lockAt);
  if (!lockOk) {
    return toErrorResult(
      'ASSIGNMENT_LOCKED',
      '현재 이 과제를 제출할 수 있는 기간이 아닙니다.',
      { retryable: false, nextAction: 'unlock_at/lock_at을 확인하세요.' },
    );
  }

  if (assignment.has_submitted && !confirmResubmit) {
    return toErrorResult(
      'ASSIGNMENT_ALREADY_SUBMITTED',
      '이미 제출된 과제입니다. 재제출하려면 confirm_resubmit을 true로 지정해야 합니다.',
      { retryable: false, nextAction: '재제출 의도가 맞는지 확인한 뒤 confirm_resubmit=true로 다시 호출하세요.' },
    );
  }

  return {
    submission_type_ok: true,
    extensions_ok: true,
    lock_ok: true,
  };
}

function isToolErrorResult(value: ToolErrorResult | SubmitAssignmentValidation): value is ToolErrorResult {
  return 'error_code' in value;
}

async function uploadFileToCanvas(
  client: CanvasClient,
  courseId: number,
  assignmentId: number,
  file: LocalFile,
): Promise<string> {
  const initForm = new URLSearchParams();
  initForm.set('name', file.name);
  initForm.set('size', String(file.size));
  initForm.set('content_type', file.content_type);

  const uploadToken = await client.postForm<UploadTokenResponse>(
    `/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/self/files`,
    initForm,
  );

  if (!uploadToken.upload_url || !uploadToken.upload_params) {
    throw new Error('Canvas upload token response missing upload_url or upload_params');
  }

  const uploadUrl = new URL(uploadToken.upload_url);
  if (uploadUrl.protocol !== 'https:' || !UPLOAD_ALLOWED_ORIGINS.has(uploadUrl.origin)) {
    throw new Error(`Canvas upload URL rejected: unexpected origin ${uploadUrl.origin}`);
  }
  const form = new FormData();
  for (const [key, value] of Object.entries(uploadToken.upload_params)) {
    if (value === undefined || value === null) continue;
    form.append(key, String(value));
  }
  const bytes = await fs.readFile(file.absolute_path);
  form.append('file', new Blob([bytes], { type: file.content_type }), file.name);

  const response = await fetch(uploadUrl, {
    method: 'POST',
    body: form,
    redirect: 'manual',
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });

  // 표준 Canvas 3단계 플로우: 스토리지가 success_action_redirect로 3xx를 주면
  // 그 finalize URL을 Bearer 토큰으로 GET해야 파일 id가 확정된다.
  let finalResponse = response;
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    if (!location) {
      throw new Error(`Canvas file upload redirect missing location (${response.status})`);
    }
    const finalizeUrl = new URL(location, uploadUrl);
    if (finalizeUrl.protocol !== 'https:' || finalizeUrl.origin !== ECLASS_ORIGIN) {
      throw new Error(`Canvas upload finalize URL rejected: unexpected origin ${finalizeUrl.origin}`);
    }
    finalResponse = await fetch(finalizeUrl, {
      redirect: 'error',
      signal: AbortSignal.timeout(FINALIZE_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${client.getToken()}`,
        Accept: 'application/json',
      },
    });
  }

  if (!finalResponse.ok) {
    throw new Error(`Canvas file upload failed ${finalResponse.status}`);
  }

  const contentType = finalResponse.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) {
    throw new Error(`Canvas file upload returned non-json response ${finalResponse.status}`);
  }

  const uploaded = await finalResponse.json() as UploadedFileResponse;
  const id = uploaded.id ?? uploaded.attachment?.id;
  if (id === undefined || id === null || String(id).trim() === '') {
    throw new Error('Canvas file upload response missing file id');
  }
  return String(id);
}

async function postSubmission(
  client: CanvasClient,
  input: SubmitAssignmentInput,
  submissionType: SubmissionType,
  fileIds: string[],
): Promise<void> {
  const form = new URLSearchParams();
  form.set('submission[submission_type]', submissionType);
  if (submissionType === 'online_upload') {
    for (const fileId of fileIds) {
      form.append('submission[file_ids][]', fileId);
    }
  } else {
    form.set('submission[body]', input.body ?? '');
  }
  if (input.comment?.trim()) {
    form.set('comment[text_comment]', input.comment);
  }

  await client.postForm<unknown>(
    `/api/v1/courses/${input.course_id}/assignments/${input.assignment_id}/submissions`,
    form,
  );
}

/**
 * Whether `after` shows a submission that landed after `before` was captured.
 * Falls back to submitted_at comparison when Canvas omits the attempt counter,
 * so a failed resubmission can't be mistaken for success.
 */
function submissionAdvanced(before: AssignmentDetail, after: AssignmentDetail): boolean {
  const b = before.assignment;
  const a = after.assignment;
  if (!a.has_submitted) return false;
  if (!b.has_submitted) return true;
  if (typeof b.attempt === 'number' && typeof a.attempt === 'number') {
    return a.attempt > b.attempt;
  }
  return a.submitted_at !== b.submitted_at;
}

function verificationFailed(
  before: AssignmentDetail,
  after: AssignmentDetail,
): ToolErrorResult | null {
  if (!after.assignment.has_submitted) {
    return toErrorResult(
      'SUBMISSION_VERIFICATION_FAILED',
      '제출 요청 후 과제 상세에서 제출 상태가 확인되지 않았습니다.',
      { retryable: true, nextAction: '과제 상세 페이지에서 제출 상태를 직접 확인하세요.' },
    );
  }

  if (before.assignment.has_submitted && !submissionAdvanced(before, after)) {
    return toErrorResult(
      'SUBMISSION_VERIFICATION_FAILED',
      '재제출 요청 후 시도 횟수/제출 시각 변화가 확인되지 않았습니다.',
      { retryable: true, nextAction: '과제 상세 페이지에서 최신 제출 시각과 첨부 파일을 확인하세요.' },
    );
  }

  return null;
}

/**
 * UI fallback wrapper. The confirmed Canvas form has a single file input, so
 * the fallback only handles exactly one file. Returns null on success or a
 * structured error (errorCode distinguishes upload-stage vs submit-stage).
 */
async function submitViaUiFallback(
  session: SubmitAssignmentSession,
  input: SubmitAssignmentInput,
  files: LocalFile[],
  errorCode: 'SUBMISSION_UPLOAD_FAILED' | 'SUBMISSION_FAILED',
  apiErr: unknown,
): Promise<ToolErrorResult | null> {
  if (files.length !== 1) {
    return toErrorResult(
      errorCode,
      'Canvas API 제출에 실패했고, UI 폴백은 단일 파일 제출만 지원합니다.',
      { err: apiErr, nextAction: '파일을 하나로 합치거나(zip 등) 잠시 후 다시 시도하세요.' },
    );
  }
  try {
    await session.submitAssignmentViaUi(
      input.course_id,
      input.assignment_id,
      files.map((file) => file.absolute_path),
      input.comment,
    );
    return null;
  } catch (uiErr) {
    return toErrorResult(
      errorCode,
      'Canvas API 제출 실패 후 UI 폴백 제출도 실패했습니다.',
      { err: uiErr, nextAction: '과제 페이지에서 제출 상태를 확인한 뒤 다시 시도하세요.' },
    );
  }
}

export async function submitAssignment(
  client: CanvasClient,
  session: SubmitAssignmentSession,
  input: SubmitAssignmentInput,
): Promise<SubmitAssignmentResult | ToolErrorResult> {
  const dryRun = input.dry_run ?? true;
  const submissionType = chooseSubmissionType(input);
  if (typeof submissionType !== 'string') return submissionType;

  const files = await collectFiles(input.file_paths);
  if (!Array.isArray(files)) return files;

  const before = await getAssignmentDetail(client, input.course_id, input.assignment_id);
  if (!before.ok) return before;

  const validation = validateAssignment(before, submissionType, files, input.confirm_resubmit ?? false);
  if (isToolErrorResult(validation)) return validation;

  const alreadySubmitted = before.assignment.has_submitted;
  const isResubmission = alreadySubmitted;

  if (dryRun) {
    return {
      ok: true,
      mode: 'dry_run',
      already_submitted: alreadySubmitted,
      is_resubmission: isResubmission,
      validation,
      strategy: 'canvas_api',
      submitted_at: before.assignment.submitted_at,
      attempt: before.assignment.attempt,
      verification: { checked: false, has_submitted: alreadySubmitted },
    };
  }

  let strategy: SubmitAssignmentResult['strategy'] = 'canvas_api';

  // 업로드 단계 (제출 POST 이전 — 실패해도 서버에 제출이 반영됐을 가능성이 없으므로
  // UI 폴백이 안전하다)
  const fileIds: string[] = [];
  if (submissionType === 'online_upload') {
    try {
      for (const file of files) {
        fileIds.push(await uploadFileToCanvas(client, input.course_id, input.assignment_id, file));
      }
    } catch (uploadErr) {
      const fallbackError = await submitViaUiFallback(session, input, files, 'SUBMISSION_UPLOAD_FAILED', uploadErr);
      if (fallbackError) return fallbackError;
      strategy = 'playwright_ui';
    }
  }

  // 제출 단계 — 여기서의 실패는 서버에 제출이 이미 반영됐을 수 있는 모호한 실패다.
  // 무조건 UI 폴백하면 이중 제출이 되므로, 먼저 재조회로 반영 여부를 판정한다.
  if (strategy === 'canvas_api') {
    try {
      await postSubmission(client, input, submissionType, fileIds);
    } catch (submitErr) {
      const recheck = await getAssignmentDetail(client, input.course_id, input.assignment_id);
      if (!recheck.ok) {
        return toErrorResult(
          'SUBMISSION_FAILED',
          '제출 요청이 실패했고 제출 반영 여부도 확인하지 못했습니다. 이중 제출 방지를 위해 자동 재시도하지 않습니다.',
          { err: submitErr, retryable: false, nextAction: '과제 페이지에서 제출 상태를 직접 확인한 뒤 필요 시 다시 호출하세요.' },
        );
      }
      if (!submissionAdvanced(before, recheck)) {
        // 제출이 서버에 반영되지 않은 것이 확인됨 → 폴백 안전
        if (submissionType !== 'online_upload') {
          return toErrorResult('SUBMISSION_FAILED', '과제 제출에 실패했습니다.', { err: submitErr });
        }
        const fallbackError = await submitViaUiFallback(session, input, files, 'SUBMISSION_FAILED', submitErr);
        if (fallbackError) return fallbackError;
        strategy = 'playwright_ui';
      }
      // submissionAdvanced=true면 제출은 이미 성공 — 아래 검증 단계로 진행
    }
  }

  const after = await getAssignmentDetail(client, input.course_id, input.assignment_id);
  if (!after.ok) {
    return toErrorResult(
      'SUBMISSION_VERIFICATION_FAILED',
      '제출 후 과제 상세 정보를 다시 확인하지 못했습니다.',
      { retryable: true, nextAction: '과제 상세 페이지에서 제출 상태를 직접 확인하세요.' },
    );
  }

  const verificationError = verificationFailed(before, after);
  if (verificationError) return verificationError;

  const beforeAttempt = before.assignment.attempt;
  const afterAttempt = after.assignment.attempt;
  const attemptIncreased = typeof beforeAttempt === 'number' && typeof afterAttempt === 'number'
    ? afterAttempt > beforeAttempt
    : undefined;

  return {
    ok: true,
    mode: 'submitted',
    already_submitted: alreadySubmitted,
    is_resubmission: isResubmission,
    validation,
    strategy,
    submitted_at: after.assignment.submitted_at,
    attempt: after.assignment.attempt,
    verification: {
      checked: true,
      has_submitted: after.assignment.has_submitted,
      ...(attemptIncreased !== undefined ? { attempt_increased: attemptIncreased } : {}),
    },
  };
}
