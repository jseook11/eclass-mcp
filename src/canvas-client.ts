const ACCEPT_HEADER = "application/json+canvas-string-ids, application/json";
const REQUEST_TIMEOUT_MS = 30_000;

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
   * @param onAuthError - called once when a request returns 401 (token expired
   *   or revoked server-side). Should invalidate the cached token, re-login,
   *   and return a fresh token; the failed request is retried once with it.
   */
  constructor(
    private baseUrl: string,
    private token: string,
    private onAuthError?: () => Promise<string>,
  ) {}

  getToken(): string {
    return this.token;
  }

  private async authedFetch(url: string, init: { method?: string; body?: URLSearchParams; contentType?: string }): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(url, {
        method: init.method ?? 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: ACCEPT_HEADER,
          ...(init.contentType ? { 'Content-Type': init.contentType } : {}),
        },
        ...(init.body ? { body: init.body } : {}),
      });

      // 401 = 토큰 만료/회수. 캐시 토큰을 폐기하고 재로그인 후 한 번만 재시도.
      if (response.status === 401 && this.onAuthError && attempt === 0) {
        this.token = await this.onAuthError();
        continue;
      }

      if (!response.ok) {
        throw new Error(`Canvas API error ${response.status}`);
      }
      return response;
    }
    throw new Error('Canvas API error 401');
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
