import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

import { classifyDoctorResult, type DoctorClassification } from '../src/chatgptui/doctor.js';
import { runChatgptui, type ChildLike } from '../src/chatgptui/orchestrator.js';
import { stopFromPidFile, writePidFile } from '../src/chatgptui/pidfile.js';
import { ensureTunnelProfile } from '../src/chatgptui/profile.js';

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

  if (cmd === 'stop') {
    const result = await stopFromPidFile(PID_FILE);
    process.stdout.write(result.stopped ? 'chatgptui 종료됨\n' : '실행 중인 chatgptui 없음\n');
    return;
  }

  const result = await runChatgptui({
    env: process.env,
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
