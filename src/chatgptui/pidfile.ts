import * as fs from 'node:fs/promises';

export type PidRecord = {
  http: number;
  tunnel: number;
  port: number;
  orchestrator?: number;
};

export type Killer = (pid: number, signal: NodeJS.Signals | number) => void;
export type PidProcessStatus = {
  name: 'http' | 'tunnel' | 'orchestrator';
  pid: number;
  running: boolean;
};
export type PidStatus = {
  exists: boolean;
  running: boolean;
  port?: number;
  processes: PidProcessStatus[];
};
export type LivenessCheck = (pid: number) => boolean;

export async function writePidFile(filePath: string, record: PidRecord): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(record), { mode: 0o600 });
}

export async function readPidFile(filePath: string): Promise<PidRecord | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as PidRecord;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

export async function statusFromPidFile(
  filePath: string,
  isAlive: LivenessCheck = isProcessAlive,
): Promise<PidStatus> {
  const record = await readPidFile(filePath);
  if (!record) return { exists: false, running: false, processes: [] };

  const processes: PidProcessStatus[] = [
    { name: 'http', pid: record.http, running: isAlive(record.http) },
    { name: 'tunnel', pid: record.tunnel, running: isAlive(record.tunnel) },
  ];
  if (record.orchestrator) {
    processes.push({
      name: 'orchestrator',
      pid: record.orchestrator,
      running: isAlive(record.orchestrator),
    });
  }

  return {
    exists: true,
    running: processes.some((processStatus) => processStatus.running),
    port: record.port,
    processes,
  };
}

export async function stopFromPidFile(
  filePath: string,
  kill: Killer = (pid, signal) => process.kill(pid, signal),
): Promise<{ stopped: boolean }> {
  const record = await readPidFile(filePath);
  if (!record) return { stopped: false };

  for (const pid of [record.http, record.tunnel, record.orchestrator]) {
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    try {
      kill(pid, 'SIGTERM');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH') throw err;
    }
  }

  await fs.rm(filePath, { force: true });
  return { stopped: true };
}
