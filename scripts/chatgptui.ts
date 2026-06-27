import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { classifyDoctorResult, type DoctorClassification } from '../src/chatgptui/doctor.js';
import { runChatgptui, type ChildLike } from '../src/chatgptui/orchestrator.js';
import { statusFromPidFile, stopFromPidFile, writePidFile } from '../src/chatgptui/pidfile.js';
import { ensureTunnelProfile } from '../src/chatgptui/profile.js';
import { resolveDoctorCredentials } from '../src/doctor.js';

// Convenience: load runtime env from a local .env.chatgptui if present, so the
// operator fills in CONTROL_PLANE_*/ECLASS_* once instead of exporting them on
// every run. Already-exported shell variables still take precedence. The file
// is gitignored (.env.*); copy .env.chatgptui.example to get started.
const ENV_FILE = process.env.ECLASS_CHATGPTUI_ENV_FILE
  ? path.resolve(process.env.ECLASS_CHATGPTUI_ENV_FILE)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env.chatgptui');
if (existsSync(ENV_FILE)) {
  process.loadEnvFile(ENV_FILE);
  process.stderr.write(`[chatgptui] loaded ${ENV_FILE}\n`);
}

const PID_FILE = '.chatgptui.pid';

function spawnChild(cmd: string, args: string[], opts?: { env?: Record<string, string> }): ChildLike {
  const child = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'], env: opts?.env });
  child.on('error', (err) => {
    process.stderr.write(`[chatgptui] failed to spawn ${cmd}: ${err.message}\n`);
  });
  return {
    pid: child.pid ?? -1,
    kill: (signal?: NodeJS.Signals) => {
      child.kill(signal);
    },
  };
}

async function waitHttpReady(port: number, _token: string): Promise<boolean> {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.status === 200) return true;
    } catch {
      // Server is still starting.
    }
    await sleep(250);
  }
  return false;
}

async function runDoctor(profilePath: string, env: Record<string, string>): Promise<DoctorClassification> {
  return await new Promise<DoctorClassification>((resolve) => {
    const child = spawn('tunnel-client', ['doctor', '--profile-file', profilePath, '--explain'], { env });
    let output = '';
    child.stdout?.on('data', (data) => {
      output += String(data);
    });
    child.stderr?.on('data', (data) => {
      output += String(data);
    });
    child.on('error', () => resolve(classifyDoctorResult('', 127)));
    child.on('close', (code) => resolve(classifyDoctorResult(output, code ?? 0)));
  });
}

async function waitTunnelReady(healthUrlFile: string): Promise<boolean> {
  for (let i = 0; i < 80; i += 1) {
    try {
      const base = (await fs.readFile(healthUrlFile, 'utf8')).trim();
      if (base) {
        const res = await fetch(`${base}/readyz`);
        if (res.status === 200) return true;
      }
    } catch {
      // The health file appears only after tunnel-client starts its health listener.
    }
    await sleep(250);
  }
  return false;
}

async function main(): Promise<void> {
  const cmd = process.argv[2];

  if (cmd && cmd !== 'start' && cmd !== 'stop' && cmd !== 'status') {
    process.stderr.write('사용법: npm run chatgptui [start|stop|status]\n');
    process.exit(2);
  }

  if (cmd === 'stop') {
    const result = await stopFromPidFile(PID_FILE);
    process.stdout.write(result.stopped ? 'chatgptui 종료됨\n' : '실행 중인 chatgptui 없음\n');
    return;
  }

  if (cmd === 'status') {
    const status = await statusFromPidFile(PID_FILE);
    if (!status.exists) {
      process.stdout.write('chatgptui stopped (pidfile 없음)\n');
      return;
    }
    process.stdout.write(`chatgptui ${status.running ? 'running' : 'stopped'} (port ${status.port})\n`);
    for (const processStatus of status.processes) {
      process.stdout.write(`- ${processStatus.name}: pid ${processStatus.pid} ${processStatus.running ? 'running' : 'stale'}\n`);
    }
    return;
  }

  const result = await runChatgptui({
    env: process.env,
    resolveUsername: async () => (await resolveDoctorCredentials()).username,
    spawn: spawnChild,
    waitHttpReady,
    ensureProfile: ensureTunnelProfile,
    runDoctor,
    waitTunnelReady,
    writePid: writePidFile,
    log: (message) => process.stderr.write(`[chatgptui] ${message}\n`),
    pidFilePath: PID_FILE,
    orchestratorPid: process.pid,
  });

  if (!result.ok) {
    process.stderr.write('[chatgptui] 기동 실패. docs/CHATGPT_TUNNEL_SETUP.md 참고.\n');
    process.exit(1);
  }

  const cleanup = async (): Promise<void> => {
    await stopFromPidFile(PID_FILE);
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  await new Promise<void>(() => undefined);
}

await main();
