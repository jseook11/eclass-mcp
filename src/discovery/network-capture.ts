import type { BodySummary } from './redact.js';
import { redactHeaders, redactUrl, summarizeBody } from './redact.js';

// Structural subsets of Playwright's Request/Response/Page so the recorder is
// testable with plain stubs and attachable to both Page and BrowserContext.
export interface RequestLike {
  url(): string;
  method(): string;
  resourceType(): string;
  headers(): Record<string, string>;
  postData(): string | null;
}

export interface ResponseLike {
  url(): string;
  status(): number;
  headers(): Record<string, string>;
  request(): RequestLike;
}

export interface NetworkSource {
  on(event: 'request', listener: (request: RequestLike) => void): unknown;
  on(event: 'response', listener: (response: ResponseLike) => void): unknown;
}

export interface CapturedEntry {
  method: string;
  url: string;                                  // redacted query params
  resource_type: string;
  request_headers: Record<string, string>;      // non-allowlisted values redacted
  request_body: BodySummary | null;             // field names only
  status?: number;
  response_content_type?: string;
  response_content_disposition?: string;
}

export interface EndpointCandidate {
  method: string;
  origin: string;
  path_pattern: string;       // numeric/hex/uuid segments collapsed to :id
  count: number;
  statuses: number[];
  resource_types: string[];
  content_types: string[];
  request_body_fields: string[];
  sample_url: string;         // redacted
}

const TRACKED_HOSTS = ['eclass3.cau.ac.kr', 'ocs.cau.ac.kr', 'canvas.cau.ac.kr', 'mportal2.cau.ac.kr', 'rpt80.cau.ac.kr'];

export function isTrackedDiscoveryUrl(url: string): boolean {
  try {
    return TRACKED_HOSTS.includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

export interface NetworkRecorderOptions {
  urlFilter?: (url: string) => boolean;
  maxEntries?: number;
}

const DEFAULT_MAX_ENTRIES = 500;

export class NetworkRecorder {
  private captured: CapturedEntry[] = [];
  private byRequest = new Map<RequestLike, CapturedEntry>();
  private urlFilter: (url: string) => boolean;
  private maxEntries: number;
  private dropped = 0;

  constructor(options: NetworkRecorderOptions = {}) {
    this.urlFilter = options.urlFilter ?? isTrackedDiscoveryUrl;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  attach(source: NetworkSource): void {
    source.on('request', (request) => this.onRequest(request));
    source.on('response', (response) => this.onResponse(response));
  }

  private onRequest(request: RequestLike): void {
    const url = request.url();
    if (!this.urlFilter(url)) return;
    if (this.captured.length >= this.maxEntries) {
      this.dropped += 1;
      return;
    }
    const headers = request.headers();
    const entry: CapturedEntry = {
      method: request.method(),
      url: redactUrl(url),
      resource_type: request.resourceType(),
      request_headers: redactHeaders(headers),
      request_body: summarizeBody(
        headers['content-type'] ?? headers['Content-Type'] ?? null,
        request.postData(),
      ),
    };
    this.captured.push(entry);
    this.byRequest.set(request, entry);
  }

  private onResponse(response: ResponseLike): void {
    const entry = this.byRequest.get(response.request());
    if (!entry) return;
    entry.status = response.status();
    const headers = response.headers();
    const contentType = headers['content-type'];
    const contentDisposition = headers['content-disposition'];
    if (contentType) entry.response_content_type = contentType;
    if (contentDisposition) entry.response_content_disposition = contentDisposition;
  }

  entries(): CapturedEntry[] {
    return [...this.captured];
  }

  droppedCount(): number {
    return this.dropped;
  }

  summarize(options?: SummarizeOptions): EndpointCandidate[] {
    return summarizeEndpointCandidates(this.captured, options);
  }
}

const ID_SEGMENT = /^(\d+|[0-9a-f]{8,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function normalizePathPattern(pathname: string): string {
  return pathname
    .split('/')
    .map((segment) => (ID_SEGMENT.test(segment) ? ':id' : segment))
    .join('/');
}

export interface SummarizeOptions {
  // Static assets are noise for endpoint discovery by default
  excludeResourceTypes?: string[];
}

const DEFAULT_EXCLUDED_RESOURCE_TYPES = ['image', 'font', 'stylesheet', 'script'];

export function summarizeEndpointCandidates(
  entries: CapturedEntry[],
  options: SummarizeOptions = {},
): EndpointCandidate[] {
  const excluded = new Set(options.excludeResourceTypes ?? DEFAULT_EXCLUDED_RESOURCE_TYPES);
  const grouped = new Map<string, EndpointCandidate>();

  for (const entry of entries) {
    if (excluded.has(entry.resource_type)) continue;
    let parsed: URL;
    try {
      parsed = new URL(entry.url);
    } catch {
      continue;
    }
    const pattern = normalizePathPattern(parsed.pathname);
    const key = `${entry.method} ${parsed.origin}${pattern}`;

    let candidate = grouped.get(key);
    if (!candidate) {
      candidate = {
        method: entry.method,
        origin: parsed.origin,
        path_pattern: pattern,
        count: 0,
        statuses: [],
        resource_types: [],
        content_types: [],
        request_body_fields: [],
        sample_url: entry.url,
      };
      grouped.set(key, candidate);
    }

    candidate.count += 1;
    if (entry.status !== undefined && !candidate.statuses.includes(entry.status)) {
      candidate.statuses.push(entry.status);
    }
    if (!candidate.resource_types.includes(entry.resource_type)) {
      candidate.resource_types.push(entry.resource_type);
    }
    const contentType = entry.response_content_type?.split(';')[0].trim();
    if (contentType && !candidate.content_types.includes(contentType)) {
      candidate.content_types.push(contentType);
    }
    for (const field of entry.request_body?.field_names ?? []) {
      if (!candidate.request_body_fields.includes(field)) {
        candidate.request_body_fields.push(field);
      }
    }
  }

  return Array.from(grouped.values()).sort((a, b) => b.count - a.count);
}
