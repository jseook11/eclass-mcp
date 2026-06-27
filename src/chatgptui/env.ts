import { randomBytes } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';

export type ChatgptuiEnv = {
  ok: boolean;
  errors: string[];
  token: string;
  port: number;
  tunnelId: string;
  profilePath: string;
  managedProfile: boolean;
  profileName?: string;
};

function profileDir(env: Record<string, string | undefined>): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), '.config');
  return path.join(base, 'tunnel-client');
}

export function validateChatgptuiEnv(env: Record<string, string | undefined>): ChatgptuiEnv {
  const errors: string[] = [];

  const hasMasterKey = Boolean(env.ECLASS_SECRET_KEY || env.ECLASS_SECRET_KEY_FILE);
  if (env.ECLASS_CREDENTIAL_BACKEND === 'encrypted' && !hasMasterKey) {
    errors.push('마스터 키 미주입 — ECLASS_SECRET_KEY 또는 ECLASS_SECRET_KEY_FILE 필요');
  }
  const controlPlaneKey = env.CONTROL_PLANE_API_KEY || env.OPENAI_API_KEY;
  if (!controlPlaneKey) {
    errors.push('control plane 키 미설정 — CONTROL_PLANE_API_KEY (또는 OPENAI_API_KEY) 필요');
  }
  const tunnelId = env.CONTROL_PLANE_TUNNEL_ID?.trim() ?? '';
  if (!tunnelId) {
    errors.push('tunnel id 미설정 — CONTROL_PLANE_TUNNEL_ID 필요 (Platform Tunnels에서 발급)');
  }
  if (!env.ECLASS_USERNAME) {
    errors.push('eclass 사용자 미설정 — ECLASS_USERNAME 필요. 먼저 `pnpm run setup`을 실행하세요.');
  }

  const rawPort = Number(env.ECLASS_HTTP_PORT ?? env.PORT ?? '8787');
  const port = Number.isInteger(rawPort) && rawPort > 0 && rawPort <= 65535 ? rawPort : 8787;

  const token = env.ECLASS_REMOTE_AUTH_TOKEN && env.ECLASS_REMOTE_AUTH_TOKEN.length > 0
    ? env.ECLASS_REMOTE_AUTH_TOKEN
    : randomBytes(32).toString('base64url');

  const profileName = env.ECLASS_TUNNEL_PROFILE?.trim() || undefined;
  const customProfilePath = env.ECLASS_TUNNEL_PROFILE_FILE?.trim();
  const profilePath = customProfilePath || path.join(profileDir(env), 'eclass-mcp.yaml');
  const managedProfile = !customProfilePath;

  return {
    ok: errors.length === 0,
    errors,
    token,
    port,
    tunnelId,
    profilePath,
    managedProfile,
    profileName,
  };
}
