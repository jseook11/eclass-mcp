import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

function runStatus(envFile: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', ['exec', 'tsx', 'scripts/chatgptui.ts', 'status'], {
      cwd: process.cwd(),
      env: { ...process.env, ECLASS_CHATGPTUI_ENV_FILE: envFile },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

test('chatgptui accepts a private custom env file and rejects unsafe or symlinked files', async (t) => {
  if (os.platform() === 'win32') return t.skip('POSIX permission/symlink test');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-chatgptui-env-'));
  const file = path.join(dir, 'custom.env');
  const link = path.join(dir, 'custom-link.env');
  try {
    await fs.writeFile(file, 'CONTROL_PLANE_API_KEY=test\n', { mode: 0o644 });
    const unsafe = await runStatus(file);
    assert.equal(unsafe.code, 1, unsafe.output);
    assert.match(unsafe.output, /unsafe permissions/);

    await fs.chmod(file, 0o600);
    const safe = await runStatus(file);
    assert.equal(safe.code, 0, safe.output);
    assert.match(safe.output, /loaded custom env file/);

    await fs.symlink(file, link);
    const symlinked = await runStatus(link);
    assert.equal(symlinked.code, 1, symlinked.output);
    assert.match(symlinked.output, /symbolic link/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
