import * as fs from 'node:fs/promises';

export type PidRecord = {
  http: number;
  tunnel: number;
  port: number;
  orchestrator?: number;
};

export type Killer = (pid: number, signal: NodeJS.Signals | number) => void;

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
