import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import YAML from 'yaml';

function runSetupCli(
  args: string[],
  input: string,
  env: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', ['exec', 'tsx', 'scripts/setup.ts', ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
    child.stdin.end(input);
  });
}

test('setup does not require .mcp.json when Hermes config exists', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-setup-'));
  const hermesConfigPath = path.join(dir, 'config.yaml');
  await fs.writeFile(hermesConfigPath, YAML.stringify({
    existing_key: 'kept',
    mcp_servers: {},
  }));

  const result = await runSetupCli([
    '--target', 'hermes',
    '--config', hermesConfigPath,
    '--username', 'my_id',
    '--password-stdin',
    '--allow-plaintext-env',
    '--no-doctor',
  ], 'secret\n');

  assert.equal(result.code, 0, result.output);
  const written = YAML.parse(await fs.readFile(hermesConfigPath, 'utf8')) as any;
  assert.equal(written.existing_key, 'kept');
  assert.equal(written.mcp_servers.eclass.env.ECLASS_USERNAME, 'my_id');
  assert.equal(written.mcp_servers.eclass.env.ECLASS_PASSWORD, 'secret');
  assert.equal(written.mcp_servers.eclass.env.ALLOW_PLAINTEXT_ENV_SECRETS, '1');

  await fs.rm(dir, { recursive: true, force: true });
});

test('setup credential-store failure does not recommend plaintext Hermes env', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-setup-keyring-'));
  const hermesConfigPath = path.join(dir, 'config.yaml');
  await fs.writeFile(hermesConfigPath, YAML.stringify({ mcp_servers: {} }));

  const result = await runSetupCli([
    '--target', 'hermes',
    '--config', hermesConfigPath,
    '--username', 'my_id',
    '--password-stdin',
    '--no-doctor',
  ], 'secret\n', {
    ECLASS_CREDENTIAL_BACKEND: 'file',
  });

  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /Secret Service\/libsecret/);
  assert.match(result.output, /비밀번호는 Hermes config에 저장되지 않았습니다/);
  assert.doesNotMatch(result.output, /--allow-plaintext-env/);

  const written = YAML.parse(await fs.readFile(hermesConfigPath, 'utf8')) as any;
  assert.deepEqual(written.mcp_servers, {});

  await fs.rm(dir, { recursive: true, force: true });
});
