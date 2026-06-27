import type { DoctorClassification } from './doctor.js';
import { validateChatgptuiEnv } from './env.js';

export type ChildLike = {
  pid: number;
  kill: (signal?: NodeJS.Signals) => void;
};

export type RunDeps = {
  env: Record<string, string | undefined>;
  resolveUsername?: () => Promise<string | undefined>;
  spawn: (cmd: string, args: string[], opts?: { env?: Record<string, string> }) => ChildLike;
  waitHttpReady: (port: number, token: string) => Promise<boolean>;
  ensureProfile: (
    path: string,
    opts: { tunnelId: string; port: number },
    options?: { managedProfile?: boolean },
  ) => Promise<{ created: boolean }>;
  runDoctor: (profilePath: string, env: Record<string, string>) => Promise<DoctorClassification>;
  waitTunnelReady: (healthUrlFile: string) => Promise<boolean>;
  writePid: (
    path: string,
    record: { http: number; tunnel: number; port: number; orchestrator?: number },
  ) => Promise<void>;
  log: (message: string) => void;
  pidFilePath?: string;
  orchestratorPid?: number;
};

export type RunResult = {
  ok: boolean;
  errors?: string[];
};

const PID_FILE = '.chatgptui.pid';
const HEALTH_URL_FILE = '/tmp/eclass-tunnel-health.url';

function killChild(child: ChildLike | undefined): void {
  if (!child) return;
  try {
    child.kill('SIGTERM');
  } catch {
    // Best effort cleanup during startup failure.
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runChatgptui(deps: RunDeps): Promise<RunResult> {
  const runtimeEnv = { ...deps.env };
  if (!runtimeEnv.ECLASS_USERNAME && deps.resolveUsername) {
    runtimeEnv.ECLASS_USERNAME = await deps.resolveUsername();
  }

  const validated = validateChatgptuiEnv(runtimeEnv);
  if (!validated.ok) {
    deps.log('환경 설정 오류:');
    for (const error of validated.errors) deps.log(`  - ${error}`);
    return { ok: false, errors: validated.errors };
  }

  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(runtimeEnv)) {
    if (value !== undefined) childEnv[key] = value;
  }
  childEnv.ECLASS_REMOTE_AUTH_TOKEN = validated.token;
  childEnv.ECLASS_TRANSPORT = 'http';
  if (!childEnv.CONTROL_PLANE_API_KEY && childEnv.OPENAI_API_KEY) {
    childEnv.CONTROL_PLANE_API_KEY = childEnv.OPENAI_API_KEY;
  }

  let http: ChildLike | undefined;
  let tunnel: ChildLike | undefined;
  try {
    deps.log(`HTTP MCP 서버 기동 (127.0.0.1:${validated.port})`);
    http = deps.spawn('node', ['dist/index.js', '--http', '--port', String(validated.port)], { env: childEnv });

    const httpReady = await deps.waitHttpReady(validated.port, validated.token);
    if (!httpReady) {
      deps.log('HTTP 서버 readiness 실패 — 중단');
      killChild(http);
      return { ok: false, errors: ['http readiness timeout'] };
    }

    await deps.ensureProfile(
      validated.profilePath,
      { tunnelId: validated.tunnelId, port: validated.port },
      { managedProfile: validated.managedProfile },
    );

    const doctor = await deps.runDoctor(validated.profilePath, childEnv);
    if (doctor.warning) deps.log(doctor.warning);
    if (doctor.tolerated.length > 0) {
      deps.log(`doctor 허용된 실패(non-OAuth 정상): ${doctor.tolerated.join(', ')}`);
    }
    if (!doctor.proceed) {
      deps.log(`doctor 차단 실패: ${doctor.blocking.join(', ')} — 중단`);
      killChild(http);
      return { ok: false, errors: doctor.blocking };
    }

    deps.log('tunnel-client 데몬 기동');
    tunnel = deps.spawn(
      'tunnel-client',
      [
        'run',
        '--profile-file',
        validated.profilePath,
        '--health.listen-addr',
        '127.0.0.1:0',
        '--health.url-file',
        HEALTH_URL_FILE,
        '--log.format',
        'struct-text',
        '--log.level',
        'info',
      ],
      { env: childEnv },
    );

    const tunnelReady = await deps.waitTunnelReady(HEALTH_URL_FILE);
    if (!tunnelReady) {
      deps.log('tunnel-client readiness 실패 — 중단');
      killChild(tunnel);
      killChild(http);
      return { ok: false, errors: ['tunnel readiness timeout'] };
    }

    await deps.writePid(deps.pidFilePath ?? PID_FILE, {
      http: http.pid,
      tunnel: tunnel.pid,
      port: validated.port,
      ...(deps.orchestratorPid ? { orchestrator: deps.orchestratorPid } : {}),
    });
  } catch (err) {
    killChild(tunnel);
    killChild(http);
    const message = errorMessage(err);
    deps.log(`chatgptui startup failed: ${message}`);
    return { ok: false, errors: [message] };
  }

  deps.log('chatgptui ready — ChatGPT connector에서 eclass-mcp 선택 가능');
  return { ok: true };
}
