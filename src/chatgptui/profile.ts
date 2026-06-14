import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parse, stringify } from 'yaml';

export type TunnelProfileOptions = {
  tunnelId: string;
  port: number;
};

export type EnsureTunnelProfileOptions = {
  managedProfile?: boolean;
};

const AUTH_HEADER_NAME = 'X-Eclass-Auth';
const AUTH_HEADER_VALUE = 'env:ECLASS_REMOTE_AUTH_TOKEN';

type Headers = Record<string, unknown> | undefined;

export function renderTunnelProfile(opts: TunnelProfileOptions): string {
  const doc = {
    config_version: 1,
    control_plane: {
      tunnel_id: opts.tunnelId,
      api_key: 'env:CONTROL_PLANE_API_KEY',
    },
    mcp: {
      server_urls: [{ channel: 'main', url: `http://127.0.0.1:${opts.port}/mcp` }],
      extra_headers: { [AUTH_HEADER_NAME]: AUTH_HEADER_VALUE },
      discovery_extra_headers: { [AUTH_HEADER_NAME]: AUTH_HEADER_VALUE },
    },
  };
  return stringify(doc);
}

function hasHeader(headers: Headers, name: string): boolean {
  if (!headers) return false;
  return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
}

function withoutHeader(headers: Headers, name: string): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() !== name.toLowerCase()) next[key] = value;
  }
  return next;
}

function withXAuth(headers: Headers): Record<string, unknown> {
  return { ...(headers ?? {}), [AUTH_HEADER_NAME]: AUTH_HEADER_VALUE };
}

export async function ensureTunnelProfile(
  filePath: string,
  opts: TunnelProfileOptions,
  options: EnsureTunnelProfileOptions = {},
): Promise<{ created: boolean }> {
  let existing: string | undefined;
  try {
    existing = await fs.readFile(filePath, 'utf8');
  } catch {
    existing = undefined;
  }

  if (existing === undefined) {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await fs.writeFile(filePath, renderTunnelProfile(opts), { mode: 0o600 });
    return { created: true };
  }

  const doc = (parse(existing) ?? {}) as Record<string, any>;
  doc.mcp ??= {};
  const hasAuthorization =
    hasHeader(doc.mcp.extra_headers, 'authorization') ||
    hasHeader(doc.mcp.discovery_extra_headers, 'authorization');

  if (hasAuthorization) {
    if (options.managedProfile === false) {
      throw new Error('custom tunnel profile uses Authorization static header; migrate it to X-Eclass-Auth before running chatgptui');
    }
    doc.mcp.extra_headers = withXAuth(withoutHeader(doc.mcp.extra_headers, 'authorization'));
    doc.mcp.discovery_extra_headers = withXAuth(withoutHeader(doc.mcp.discovery_extra_headers, 'authorization'));
    await fs.writeFile(filePath, stringify(doc), { mode: 0o600 });
    return { created: false };
  }

  let changed = false;
  if (!hasHeader(doc.mcp.extra_headers, AUTH_HEADER_NAME)) {
    doc.mcp.extra_headers = withXAuth(doc.mcp.extra_headers);
    changed = true;
  }
  if (!hasHeader(doc.mcp.discovery_extra_headers, AUTH_HEADER_NAME)) {
    doc.mcp.discovery_extra_headers = withXAuth(doc.mcp.discovery_extra_headers);
    changed = true;
  }
  if (changed) await fs.writeFile(filePath, stringify(doc), { mode: 0o600 });
  return { created: false };
}
