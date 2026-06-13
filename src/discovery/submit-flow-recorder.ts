import type { Page } from 'playwright';
import { BrowserSession, isSsoLoginUrl } from '../browser-session.js';
import type { EndpointCandidate } from './network-capture.js';
import { NetworkRecorder } from './network-capture.js';
import { redactUrl } from './redact.js';

const BASE_URL = 'https://eclass3.cau.ac.kr';

// Canvas standard "Submit Assignment" opener — reveals the submission form
// without submitting. This is the ONLY element this recorder ever clicks.
const SUBMISSION_UI_OPENER = '.submit_assignment_link';

export interface FormFieldSnapshot {
  name: string;
  type: string;
  accept?: string;
}

export interface FormSnapshot {
  action: string;             // redacted
  method: string;
  fields: FormFieldSnapshot[];
  submit_buttons: string[];   // button/input labels, never clicked
}

export interface SubmitFlowReport {
  course_id: number;
  assignment_id: number;
  final_page_url: string;     // redacted
  page_title: string;
  opened_submission_ui: boolean;
  forms: FormSnapshot[];
  endpoint_candidates: EndpointCandidate[];
  dropped_entries: number;
  notes: string[];
}

async function snapshotForms(page: Page): Promise<FormSnapshot[]> {
  const raw = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('form')).map((form) => ({
      action: form.getAttribute('action') ?? '',
      method: (form.getAttribute('method') ?? 'GET').toUpperCase(),
      fields: Array.from(form.querySelectorAll('input, textarea, select'))
        .map((el) => ({
          name: el.getAttribute('name') ?? '',
          type: el.tagName === 'INPUT' ? (el.getAttribute('type') ?? 'text') : el.tagName.toLowerCase(),
          accept: el.getAttribute('accept') ?? undefined,
        }))
        .filter((field) => field.name !== ''),
      submit_buttons: Array.from(form.querySelectorAll('button[type="submit"], input[type="submit"], button:not([type])'))
        .map((el) => (el.textContent ?? el.getAttribute('value') ?? '').trim())
        .filter((label) => label !== ''),
    }));
  });

  return raw.map((form) => ({
    ...form,
    action: form.action ? redactUrl(new URL(form.action, BASE_URL).toString()) : '',
  }));
}

/**
 * Dry-run recorder for the assignment submission flow. Navigates to the
 * assignment page, opens the submission UI when the standard opener exists,
 * and records redacted network traffic plus form structure. It NEVER clicks a
 * submit button and never sends a write request itself.
 */
export async function recordAssignmentSubmitFlow(
  session: BrowserSession,
  courseId: number,
  assignmentId: number,
): Promise<SubmitFlowReport> {
  return session.withDiscoveryContext('submit-flow discovery', async (context) => {
    const page = await context.newPage();
    const recorder = new NetworkRecorder();
    recorder.attach(page);
    const notes: string[] = ['dry-run recorder: no submit button was clicked'];

    const assignmentUrl = `${BASE_URL}/courses/${courseId}/assignments/${assignmentId}`;
    await page.goto(assignmentUrl, { waitUntil: 'networkidle', timeout: 30000 });
    if (isSsoLoginUrl(page.url())) {
      throw new Error(`SESSION_REDIRECT:${page.url()}`);
    }

    let openedSubmissionUi = false;
    const opener = page.locator(SUBMISSION_UI_OPENER).first();
    if (await opener.isVisible().catch(() => false)) {
      await opener.click();
      // Allow the form tab and any lazy XHRs to settle
      await page.waitForTimeout(2000);
      openedSubmissionUi = true;
    } else {
      notes.push(`submission UI opener not found (selector: ${SUBMISSION_UI_OPENER}) — page may use a non-standard submit flow`);
    }

    const forms = await snapshotForms(page);
    const pageTitle = await page.title().catch(() => '');

    return {
      course_id: courseId,
      assignment_id: assignmentId,
      final_page_url: redactUrl(page.url()),
      page_title: pageTitle,
      opened_submission_ui: openedSubmissionUi,
      forms,
      endpoint_candidates: recorder.summarize(),
      dropped_entries: recorder.droppedCount(),
      notes,
    };
  });
}
