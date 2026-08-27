const ACCEPT_HEADER = "application/json+canvas-string-ids, application/json";
const REQUEST_TIMEOUT_MS = 30_000;

export class CanvasApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly permissionDenied = false,
    message = `Canvas API error ${status}`,
  ) {
    super(message);
    this.name = 'CanvasApiError';
  }
}

export function isCanvasPermissionDeniedError(error: unknown): error is CanvasApiError {
  return error instanceof CanvasApiError && error.permissionDenied;
}

function isCourseFilesCollectionUrl(url: string): boolean {
  try {
    return /^\/api\/v1\/courses\/\d+\/files\/?$/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

async function isPermissionDeniedResponse(response: Response, url: string): Promise<boolean> {
  if (response.status !== 401 && response.status !== 403) return false;
  if (isCourseFilesCollectionUrl(url)) return true;

  // Some LearningX endpoints use 401 for an authorization decision instead of
  // an expired token. Read a clone so the caller can still consume the body.
  try {
    const body = await response.clone().text();
    return /권한이\s*(?:없|없음)|permission\s+(?:denied|not\s+allowed)|not\s+authorized/i.test(body);
  } catch {
    return false;
  }
}

function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  // Link header may contain multiple entries separated by commas
  // e.g.: <https://...?page=2>; rel="next", <https://...?page=1>; rel="first"
  const parts = linkHeader.split(/,\s*(?=<)/);
  for (const part of parts) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

export class CanvasClient {
  /**
   * @param onAuthError - called once when a request returns an authentication
   *   401 (not a permission-denied response). Should invalidate the cached
   *   token, re-login, and return a fresh token; the failed request is retried
   *   once with it.
   */
  constructor(
    private baseUrl: string,
    private token: string,
    private onAuthError?: (rejectedToken: string) => Promise<string>,
  ) {}

  getToken(): string {
    return this.token;
  }

  private async authedFetch(url: string, init: { method?: string; body?: URLSearchParams; contentType?: string }): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      // Capture per request. Another concurrent 401 may refresh this.token
      // before this response arrives, but the callback still needs to identify
      // the credential that this exact request sent.
      const requestToken = this.token;
      const response = await fetch(url, {
        method: init.method ?? 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${requestToken}`,
          Accept: ACCEPT_HEADER,
          ...(init.contentType ? { 'Content-Type': init.contentType } : {}),
        },
        ...(init.body ? { body: init.body } : {}),
      });

      const permissionDenied = await isPermissionDeniedResponse(response, url);

      // 401 can also be a resource-level authorization decision. Never rotate
      // credentials for that case; the caller can report/cache the denial.
      if (response.status === 401 && this.onAuthError && attempt === 0 && !permissionDenied) {
        this.token = await this.onAuthError(requestToken);
        continue;
      }

      if (!response.ok) {
        throw new CanvasApiError(response.status, url, permissionDenied);
      }
      return response;
    }
    throw new CanvasApiError(401, url);
  }

  async fetchAll<T>(path: string, params?: Record<string, string>): Promise<T[]> {
    const url = new URL(this.baseUrl + path);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }

    const results: T[] = [];
    let nextUrl: string | null = url.toString();

    while (nextUrl) {
      const response = await this.authedFetch(nextUrl, {});

      const page = (await response.json()) as T[];
      results.push(...page);

      const rawNext = parseNextLink(response.headers.get("Link"));
      if (rawNext) {
        // Validate that the next-page URL stays on the same origin before sending the bearer token there
        const nextOrigin = new URL(rawNext).origin;
        const baseOrigin = new URL(this.baseUrl).origin;
        if (nextOrigin !== baseOrigin) {
          throw new Error(`Canvas pagination Link header points to unexpected origin: ${nextOrigin}`);
        }
      }
      nextUrl = rawNext;
    }

    return results;
  }

  async fetchOne<T>(path: string): Promise<T> {
    const response = await this.authedFetch(this.baseUrl + path, {});
    return (await response.json()) as T;
  }

  async postForm<T>(path: string, form: URLSearchParams): Promise<T> {
    const response = await this.authedFetch(this.baseUrl + path, {
      method: 'POST',
      body: form,
      contentType: 'application/x-www-form-urlencoded',
    });
    return (await response.json()) as T;
  }
}
