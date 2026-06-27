import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { writePidFile, readPidFile, stopFromPidFile, statusFromPidFile } from '../src/chatgptui/pidfile.js';

test('writePidFile then readPidFile round-trips and uses 0600', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-pid-'));
  const file = path.join(dir, '.chatgptui.pid');
  try {
    await writePidFile(file, { http: 111, tunnel: 222, port: 8787 });
    const stat = await fs.stat(file);
    if (os.platform() !== 'win32') assert.equal(stat.mode & 0o777, 0o600);
    const got = await readPidFile(file);
    assert.deepEqual(got, { http: 111, tunnel: 222, port: 8787 });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('readPidFile returns null when file is absent', async () => {
  const got = await readPidFile('/no/such/.chatgptui.pid');
  assert.equal(got, null);
});

test('statusFromPidFile reports missing pidfile as stopped', async () => {
  const status = await statusFromPidFile('/no/such/.chatgptui.pid', () => {
    throw new Error('liveness check must not be called');
  });
  assert.deepEqual(status, { exists: false, running: false, processes: [] });
});

test('statusFromPidFile reports live and stale pids from pidfile', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-pid-status-'));
  const file = path.join(dir, '.chatgptui.pid');
  try {
    await writePidFile(file, { http: 111, tunnel: 222, port: 8787, orchestrator: 333 });
    const status = await statusFromPidFile(file, (pid) => pid === 111 || pid === 333);
    assert.equal(status.exists, true);
    assert.equal(status.running, true);
    assert.equal(status.port, 8787);
    assert.deepEqual(status.processes, [
      { name: 'http', pid: 111, running: true },
      { name: 'tunnel', pid: 222, running: false },
      { name: 'orchestrator', pid: 333, running: true },
    ]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('stopFromPidFile signals both pids and removes the file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-pid2-'));
  const file = path.join(dir, '.chatgptui.pid');
  try {
    await writePidFile(file, { http: 111, tunnel: 222, port: 8787 });
    const killed: Array<{ pid: number; signal: string }> = [];
    const result = await stopFromPidFile(file, (pid, signal) => {
      killed.push({ pid, signal: String(signal) });
    });
    assert.equal(result.stopped, true);
    assert.deepEqual(killed.map((k) => k.pid).sort(), [111, 222]);
    await assert.rejects(() => fs.stat(file));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('stopFromPidFile signals optional orchestrator pid', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-pid-orch-'));
  const file = path.join(dir, '.chatgptui.pid');
  try {
    await writePidFile(file, { http: 111, tunnel: 222, port: 8787, orchestrator: 333 });
    const killed: number[] = [];
    const result = await stopFromPidFile(file, (pid) => {
      killed.push(pid);
    });
    assert.equal(result.stopped, true);
    assert.deepEqual(killed.sort(), [111, 222, 333]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('stopFromPidFile skips current process pid during signal-handler cleanup', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-pid-self-'));
  const file = path.join(dir, '.chatgptui.pid');
  try {
    await writePidFile(file, { http: 111, tunnel: 222, port: 8787, orchestrator: process.pid });
    const killed: number[] = [];
    const result = await stopFromPidFile(file, (pid) => {
      killed.push(pid);
    });
    assert.equal(result.stopped, true);
    assert.deepEqual(killed.sort(), [111, 222]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('stopFromPidFile reports nothing-to-stop when file absent', async () => {
  const result = await stopFromPidFile('/no/such/.chatgptui.pid', () => {
    throw new Error('killer must not be called');
  });
  assert.equal(result.stopped, false);
});

test('stopFromPidFile ignores ESRCH (already-dead process) and still removes file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-pid3-'));
  const file = path.join(dir, '.chatgptui.pid');
  try {
    await writePidFile(file, { http: 111, tunnel: 222, port: 8787 });
    const result = await stopFromPidFile(file, () => {
      const err = new Error('no such process') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });
    assert.equal(result.stopped, true);
    await assert.rejects(() => fs.stat(file));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
