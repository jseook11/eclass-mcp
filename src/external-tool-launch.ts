export const OCS_VIEWER_MARKER = 'ocs.cau.ac.kr/em/';

export interface LaunchObservation {
  source: 'response' | 'download' | 'navigation' | 'iframe' | 'popup';
  url: string;
  status?: number;
  contentType?: string;
  contentDisposition?: string;
  filename?: string;
}

export type LaunchArtifactKind = 'ocs_viewer' | 'file';

export interface LaunchArtifact {
  kind: LaunchArtifactKind;
  url: string;
  type?: string;
  filename?: string;
}

export interface LtiFormSnapshot {
  id?: string;
  action: string;
  method?: string;
}

export interface LtiPageSnapshot {
  url: string;
  forms: LtiFormSnapshot[];
  iframes: string[];
}

export type LtiFollowAction =
  | { type: 'submit_form'; selector: string }
  | { type: 'watch_iframe'; src: string }
  | { type: 'watch_popup' };

export interface ExternalToolLaunchRequest {
  type?: string | null;
  url?: string | null;
  is_playwright_required?: boolean;
  is_playright_required?: boolean;
}

const SLIDE_EXTENSIONS = ['pdf', 'ppt', 'pptx'] as const;
const FILE_EXTENSIONS = [...SLIDE_EXTENSIONS, 'doc', 'docx', 'xls', 'xlsx', 'hwp', 'zip'] as const;

export function isOcsViewerUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.hostname.toLowerCase() === 'ocs.cau.ac.kr' && /^\/em\/[^/]+\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

export function isCanvasModuleItemUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.hostname.toLowerCase() === 'eclass3.cau.ac.kr'
      && /^\/courses\/\d+\/modules\/items\/\d+\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

export function isExternalToolLaunchRequested(input: ExternalToolLaunchRequest): boolean {
  return input.type === 'ExternalTool'
    || input.is_playwright_required === true
    || input.is_playright_required === true;
}

function extensionFromFilename(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const match = /\.([a-z0-9]+)$/i.exec(name.trim());
  return match ? match[1].toLowerCase() : undefined;
}

function extensionFromUrl(rawUrl: string): string | undefined {
  try {
    const pathname = new URL(rawUrl).pathname;
    return extensionFromFilename(pathname);
  } catch {
    return undefined;
  }
}

function typeFromContentType(contentType: string | undefined): string | undefined {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('application/pdf')) return 'pdf';
  if (ct.includes('presentationml.presentation')) return 'pptx';
  if (ct.includes('ms-powerpoint')) return 'ppt';
  if (ct.includes('wordprocessingml.document')) return 'docx';
  if (ct.includes('msword')) return 'doc';
  if (ct.includes('spreadsheetml.sheet')) return 'xlsx';
  if (ct.includes('ms-excel')) return 'xls';
  return undefined;
}

function inferFileType(obs: LaunchObservation): string | undefined {
  const fromName = extensionFromFilename(obs.filename);
  if (fromName && (FILE_EXTENSIONS as readonly string[]).includes(fromName)) return fromName;
  const fromContent = typeFromContentType(obs.contentType);
  if (fromContent) return fromContent;
  const fromUrl = extensionFromUrl(obs.url);
  if (fromUrl && (FILE_EXTENSIONS as readonly string[]).includes(fromUrl)) return fromUrl;
  return undefined;
}

function isAttachment(obs: LaunchObservation): boolean {
  return (obs.contentDisposition ?? '').toLowerCase().includes('attachment');
}

function isLikelyHtml(obs: LaunchObservation): boolean {
  const ct = (obs.contentType ?? '').toLowerCase();
  return ct.includes('text/html') || ct.includes('application/xhtml');
}

function scoreObservation(obs: LaunchObservation): { score: number; artifact: LaunchArtifact } | null {
  if (isOcsViewerUrl(obs.url) && (obs.source !== 'response' || isLikelyHtml(obs) || !obs.contentType)) {
    return {
      score: obs.source === 'navigation' || obs.source === 'iframe' || obs.source === 'popup' ? 500 : 450,
      artifact: { kind: 'ocs_viewer', url: obs.url, type: 'ocs' },
    };
  }

  const fileType = inferFileType(obs);
  const slide = fileType !== undefined && (SLIDE_EXTENSIONS as readonly string[]).includes(fileType);
  if (obs.source === 'download' && fileType) {
    return {
      score: slide ? 1000 : 900,
      artifact: { kind: 'file', url: obs.url, type: fileType, filename: obs.filename },
    };
  }

  if (obs.source === 'response' && (obs.status ?? 200) === 200 && !isLikelyHtml(obs)) {
    if (fileType || isAttachment(obs)) {
      return {
        score: slide ? 850 : 700,
        artifact: { kind: 'file', url: obs.url, type: fileType, filename: obs.filename },
      };
    }
  }

  if ((obs.source === 'popup' || obs.source === 'iframe') && fileType) {
    return {
      score: 600,
      artifact: { kind: 'file', url: obs.url, type: fileType, filename: obs.filename },
    };
  }

  return null;
}

export function classifyLaunchObservation(obs: LaunchObservation): LaunchArtifact | null {
  return scoreObservation(obs)?.artifact ?? null;
}

export function selectLaunchArtifact(observations: LaunchObservation[]): LaunchArtifact | null {
  let best: { score: number; artifact: LaunchArtifact; index: number } | null = null;
  for (let index = 0; index < observations.length; index += 1) {
    const ranked = scoreObservation(observations[index]);
    if (!ranked) continue;
    if (!best || ranked.score > best.score || (ranked.score === best.score && index > best.index)) {
      best = { ...ranked, index };
    }
  }
  return best?.artifact ?? null;
}

function ltiFormSelector(form: LtiFormSnapshot): string | null {
  const method = (form.method ?? 'post').toLowerCase();
  if (method !== 'post') return null;
  if (form.id === 'tool_form') return 'form#tool_form';
  if (/lti|external_tools/i.test(form.action)) {
    return form.id ? `form#${form.id}` : `form[action="${form.action}"]`;
  }
  return null;
}

export function nextLtiFollowAction(
  snapshot: LtiPageSnapshot,
  submitted: ReadonlySet<string>,
): LtiFollowAction | null {
  for (const form of snapshot.forms) {
    const selector = ltiFormSelector(form);
    if (selector && !submitted.has(selector)) {
      return { type: 'submit_form', selector };
    }
  }
  for (const src of snapshot.iframes) {
    if (src) return { type: 'watch_iframe', src };
  }
  return null;
}

export interface LaunchContext {
  moduleItemUrl: string;
  goto(url: string): Promise<void>;
  readSnapshot(): Promise<LtiPageSnapshot>;
  submitForm(selector: string): Promise<void>;
  observations(): LaunchObservation[];
  /** Resolve attachments exposed by a LearningX board LTI page, if any. */
  /** Return undefined while the LTI page is still transitioning to a board. */
  resolveBoardAttachment?: () => Promise<LaunchArtifact | null | undefined>;
  wait?(): Promise<void>;
  maxSteps?: number;
}

export async function resolveLaunchFromContext(input: LaunchContext): Promise<LaunchArtifact> {
  const submitted = new Set<string>();
  const watchedIframes = new Set<string>();
  const extra: LaunchObservation[] = [];
  let boardAttachmentChecked = false;
  const maxSteps = input.maxSteps ?? 8;
  const allObservations = (): LaunchObservation[] => [...input.observations(), ...extra];

  await input.goto(input.moduleItemUrl);

  for (let step = 0; step < maxSteps; step += 1) {
    const artifact = selectLaunchArtifact(allObservations());
    if (artifact) return artifact;

    const snapshot = await input.readSnapshot();
    extra.push({ source: 'navigation', url: snapshot.url });

    if (!boardAttachmentChecked && input.resolveBoardAttachment) {
      const attachment = await input.resolveBoardAttachment();
      if (attachment) return attachment;
      if (attachment !== undefined) boardAttachmentChecked = true;
    }

    const action = nextLtiFollowAction(snapshot, submitted);
    if (!action) {
      if (input.wait && step < maxSteps - 1) {
        await input.wait();
        continue;
      }
      break;
    }

    if (action.type === 'submit_form') {
      submitted.add(action.selector);
      await input.submitForm(action.selector);
      continue;
    }

    if (action.type === 'watch_iframe') {
      if (!watchedIframes.has(action.src)) {
        watchedIframes.add(action.src);
        extra.push({ source: 'iframe', url: action.src });
        continue;
      }
      if (input.wait && step < maxSteps - 1) {
        await input.wait();
        continue;
      }
      break;
    }

    break;
  }

  const artifact = selectLaunchArtifact(allObservations());
  if (artifact) return artifact;
  throw new Error('ExternalTool launch did not yield a downloadable file or OCS viewer URL');
}
