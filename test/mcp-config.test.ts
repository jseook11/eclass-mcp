import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import YAML from 'yaml';

import { resolveDoctorCredentials } from '../src/doctor.js';
import {
  createDefaultMcpJsonConfig,
  defaultMcpJsonPath,
  legacyMcpJsonPath,
  readOrCreateHermesConfig,
  readOrCreateMcpJsonConfig,
  readOrCreateProjectMcpJsonConfig,
  readProjectMcpJsonCredentialEnv,
  updateHermesEclassServer,
  updateMcpJsonEclassServer,
  writeHermesConfig,
  writeMcpJsonConfig,
} from '../src/mcp-config.js';

test('Hermes config update writes eclass server and preserves unrelated fields', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-hermes-'));
  const configPath = path.join(dir, 'config.yaml');
  if (os.platform() !== 'win32') await fs.chmod(dir, 0o755);
  await fs.writeFile(configPath, YAML.stringify({
    theme: 'dark',
    mcp_servers: {
      other: { command: 'other', enabled: false },
    },
  }));

  const { config } = await readOrCreateHermesConfig(configPath);
  updateHermesEclassServer(config, {
    projectRoot: '/root/eclass-mcp',
    username: 'my_id',
    password: 'secret',
    allowPlaintextEnv: true,
  });
  await writeHermesConfig(configPath, config);

  const written = YAML.parse(await fs.readFile(configPath, 'utf8')) as any;
  assert.equal(written.theme, 'dark');
  assert.equal(written.mcp_servers.other.command, 'other');
  assert.equal(written.mcp_servers.eclass.command, 'node');
  assert.deepEqual(written.mcp_servers.eclass.args, ['/root/eclass-mcp/dist/index.js']);
  assert.equal(written.mcp_servers.eclass.enabled, true);
  assert.equal(written.mcp_servers.eclass.env.ECLASS_USERNAME, 'my_id');
  assert.equal(written.mcp_servers.eclass.env.ECLASS_PASSWORD, 'secret');
  assert.equal(written.mcp_servers.eclass.env.ALLOW_PLAINTEXT_ENV_SECRETS, '1');
  if (os.platform() !== 'win32') {
    const stat = await fs.stat(configPath);
    assert.equal(stat.mode & 0o777, 0o600);
    assert.equal((await fs.stat(dir)).mode & 0o777, 0o755);
  }

  await fs.rm(dir, { recursive: true, force: true });
});

test('Hermes config update does not write plaintext password without explicit opt-in', () => {
  const config = {
    mcp_servers: {
      eclass: {
        command: 'old',
        env: {
          ECLASS_PASSWORD: 'old-secret',
          ALLOW_PLAINTEXT_ENV_SECRETS: '1',
          ECLASS_SECRET_KEY: 'master-secret',
          CONTROL_PLANE_API_KEY: 'control-secret',
          ECLASS_REMOTE_AUTH_TOKEN: 'remote-secret',
        },
      },
    },
  };

  updateHermesEclassServer(config, {
    projectRoot: '/root/eclass-mcp',
    username: 'my_id',
    password: 'new-secret',
    allowPlaintextEnv: false,
  });

  assert.equal(config.mcp_servers.eclass.env.ECLASS_USERNAME, 'my_id');
  assert.equal(config.mcp_servers.eclass.env.ECLASS_PASSWORD, undefined);
  assert.equal(config.mcp_servers.eclass.env.ALLOW_PLAINTEXT_ENV_SECRETS, undefined);
  assert.equal(config.mcp_servers.eclass.env.ECLASS_SECRET_KEY, undefined);
  assert.equal(config.mcp_servers.eclass.env.CONTROL_PLANE_API_KEY, undefined);
  assert.equal(config.mcp_servers.eclass.env.ECLASS_REMOTE_AUTH_TOKEN, undefined);
});

test('doctor resolves credentials from Hermes config', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-doctor-'));
  const hermesConfigPath = path.join(dir, 'config.yaml');
  await fs.writeFile(hermesConfigPath, YAML.stringify({
    mcp_servers: {
      eclass: {
        env: {
          ECLASS_USERNAME: 'hermes_user',
          ECLASS_PASSWORD: 'hermes_secret',
          ALLOW_PLAINTEXT_ENV_SECRETS: '1',
        },
      },
    },
  }));

  const credentials = await resolveDoctorCredentials(undefined, { hermesConfigPath });
  assert.equal(credentials.source, 'hermes');
  assert.equal(credentials.username, 'hermes_user');
  assert.equal(credentials.envPassword, 'hermes_secret');
  assert.equal(credentials.plaintextOverride, '1');

  await fs.rm(dir, { recursive: true, force: true });
});

test('doctor plaintext override requires a secure Canvas cache backend but no stored LMS password', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-doctor-plaintext-'));
  const hermesConfigPath = path.join(dir, 'config.yaml');
  const emptyBrowserPath = path.join(dir, 'no-playwright-browsers');
  const encryptedStorePath = path.join(dir, 'secrets.enc');
  await fs.mkdir(emptyBrowserPath);
  await fs.writeFile(hermesConfigPath, YAML.stringify({
    mcp_servers: {
      eclass: {
        env: {
          ECLASS_USERNAME: 'hermes_plaintext_user',
          ECLASS_PASSWORD: 'hermes_plaintext_secret',
          ALLOW_PLAINTEXT_ENV_SECRETS: '1',
        },
      },
    },
  }));

  try {
    const script = [
      "import { runDoctor } from './src/doctor.ts';",
      'void (async () => {',
      '  const results = await runDoctor(undefined, { hermesConfigPath: process.env.TEST_HERMES_CONFIG_PATH });',
      "  const credential = results.find((result) => result.name === 'credential backend');",
      '  process.stdout.write(JSON.stringify(credential));',
      '})();',
    ].join('\n');

    const runPreflight = async (
      backend: string,
      masterKey?: string,
    ): Promise<{ ok: boolean; detail: string }> => {
      const childEnv = {
        ...process.env,
        ECLASS_CREDENTIAL_BACKEND: backend,
        PLAYWRIGHT_BROWSERS_PATH: emptyBrowserPath,
        TEST_HERMES_CONFIG_PATH: hermesConfigPath,
        ECLASS_ENC_STORE_PATH: encryptedStorePath,
      };
      delete childEnv.ECLASS_USERNAME;
      delete childEnv.ECLASS_PASSWORD;
      delete childEnv.ALLOW_PLAINTEXT_ENV_SECRETS;
      delete childEnv.ECLASS_SECRET_KEY;
      delete childEnv.ECLASS_SECRET_KEY_FILE;
      if (masterKey) childEnv.ECLASS_SECRET_KEY = masterKey;

      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn('pnpm', ['exec', 'tsx', '-e', script], {
          cwd: process.cwd(),
          env: childEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += String(chunk); });
        child.stderr.on('data', (chunk) => { stderr += String(chunk); });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stdout, stderr }));
      });

      assert.equal(result.code, 0, result.stderr);
      return JSON.parse(result.stdout) as { ok: boolean; detail: string };
    };

    const secure = await runPreflight('encrypted', Buffer.alloc(32, 1).toString('base64'));
    assert.equal(secure.ok, true);
    assert.match(secure.detail, /secure Canvas token\/session cache backend readable/);
    await assert.rejects(() => fs.stat(encryptedStorePath), (err: NodeJS.ErrnoException) => err.code === 'ENOENT');

    const unavailable = await runPreflight('invalid-backend');
    assert.equal(unavailable.ok, false);
    assert.match(unavailable.detail, /backend=unavailable/);
    assert.match(unavailable.detail, /requires encrypted or keytar storage/);

    const legacyFile = await runPreflight('file');
    assert.equal(legacyFile.ok, false);
    assert.match(legacyFile.detail, /backend=file/);
    assert.match(legacyFile.detail, /requires encrypted or keytar storage/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('existing .mcp.json behavior still writes username and strips plaintext secrets', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-mcp-json-'));
  const mcpJsonPath = path.join(dir, '.mcp.json');
  await fs.writeFile(mcpJsonPath, JSON.stringify({
    mcpServers: {
      eclass: {
        command: 'node',
        env: {
          ECLASS_USERNAME: 'old',
          ECLASS_PASSWORD: 'secret',
          ALLOW_PLAINTEXT_ENV_SECRETS: '1',
          OPENAI_API_KEY: 'openai',
          CONTROL_PLANE_API_KEY: 'control',
          ECLASS_REMOTE_AUTH_TOKEN: 'remote',
          ECLASS_SECRET_KEY: 'master',
          ECLASS_OCR_MODEL: 'model',
        },
      },
      other: { command: 'other' },
    },
  }));

  const { config } = await readOrCreateMcpJsonConfig(mcpJsonPath, dir);
  updateMcpJsonEclassServer(config, { projectRoot: dir, username: 'new_user' });
  await writeMcpJsonConfig(mcpJsonPath, config);

  const written = JSON.parse(await fs.readFile(mcpJsonPath, 'utf8')) as any;
  assert.equal(written.mcpServers.eclass.env.ECLASS_USERNAME, 'new_user');
  assert.equal(written.mcpServers.eclass.env.ECLASS_PASSWORD, undefined);
  assert.equal(written.mcpServers.eclass.env.ALLOW_PLAINTEXT_ENV_SECRETS, undefined);
  assert.equal(written.mcpServers.eclass.env.OPENAI_API_KEY, undefined);
  assert.equal(written.mcpServers.eclass.env.CONTROL_PLANE_API_KEY, undefined);
  assert.equal(written.mcpServers.eclass.env.ECLASS_REMOTE_AUTH_TOKEN, undefined);
  assert.equal(written.mcpServers.eclass.env.ECLASS_SECRET_KEY, undefined);
  assert.equal(written.mcpServers.eclass.env.ECLASS_OCR_MODEL, undefined);
  assert.equal(written.mcpServers.other.command, 'other');
  // Must launch node directly (not `pnpm start`, whose stdout banner breaks JSON-RPC)
  assert.equal(written.mcpServers.eclass.command, 'node');
  assert.deepEqual(written.mcpServers.eclass.args, [path.join(dir, 'dist', 'index.js')]);
  if (os.platform() !== 'win32') {
    const stat = await fs.stat(mcpJsonPath);
    assert.equal(stat.mode & 0o777, 0o600);
  }

  await fs.rm(dir, { recursive: true, force: true });
});

test('.mcp.json generators use node, never pnpm start (stdout banner corrupts stdio)', () => {
  const def = createDefaultMcpJsonConfig('/root/eclass-mcp');
  assert.equal(def.mcpServers?.eclass.command, 'node');
  assert.deepEqual(def.mcpServers?.eclass.args, ['/root/eclass-mcp/dist/index.js']);
  assert.equal(def.mcpServers?.eclass.env?.ECLASS_TRANSPORT, undefined);
  assert.equal(def.mcpServers?.eclass.env?.CONTROL_PLANE_API_KEY, undefined);
  assert.equal(def.mcpServers?.eclass.env?.CONTROL_PLANE_TUNNEL_ID, undefined);
  assert.equal(def.mcpServers?.eclass.env?.ECLASS_CREDENTIAL_BACKEND, undefined);

  // Repairs a pre-existing broken pnpm-based entry on re-run
  const broken: any = { mcpServers: { eclass: { command: 'pnpm', args: ['--dir', '/root/eclass-mcp', 'start'], env: { KEEP: '1' } } } };
  updateMcpJsonEclassServer(broken, { projectRoot: '/root/eclass-mcp', username: 'u' });
  assert.equal(broken.mcpServers.eclass.command, 'node');
  assert.deepEqual(broken.mcpServers.eclass.args, ['/root/eclass-mcp/dist/index.js']);
  assert.equal(broken.mcpServers.eclass.env.KEEP, '1');
  assert.equal(broken.mcpServers.eclass.env.ECLASS_USERNAME, 'u');
});

test('.mcp.json default path is repository-local and legacy path remains parent-local', () => {
  assert.equal(defaultMcpJsonPath('/work/eclass-mcp'), path.join('/work/eclass-mcp', '.mcp.json'));
  assert.equal(legacyMcpJsonPath('/work/eclass-mcp'), path.join('/work', '.mcp.json'));
});

test('project .mcp.json seeds only a matching legacy eclass entry without modifying parent', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-mcp-parent-'));
  const projectRoot = path.join(parent, 'eclass-mcp');
  await fs.mkdir(projectRoot);
  const legacyPath = legacyMcpJsonPath(projectRoot);
  const legacyRaw = JSON.stringify({
    mcpServers: {
      eclass: {
        command: 'node',
        args: [path.join(projectRoot, 'dist', 'index.js')],
        env: {
          ECLASS_USERNAME: 'legacy-user',
          ECLASS_PASSWORD: 'legacy-password',
          CONTROL_PLANE_API_KEY: 'legacy-control-key',
          KEEP: 'safe',
        },
      },
      unrelated: { command: 'do-not-copy' },
    },
  }, null, 2) + '\n';
  await fs.writeFile(legacyPath, legacyRaw);

  try {
    const result = await readOrCreateProjectMcpJsonConfig(projectRoot);
    assert.equal(result.created, true);
    assert.equal(result.targetPath, defaultMcpJsonPath(projectRoot));
    assert.equal(result.legacySource, legacyPath);
    assert.equal(result.config.mcpServers?.unrelated, undefined);
    assert.equal(result.config.mcpServers?.eclass?.env?.KEEP, 'safe');

    updateMcpJsonEclassServer(result.config, { projectRoot, username: 'new-user' });
    await writeMcpJsonConfig(result.targetPath, result.config);

    const written = JSON.parse(await fs.readFile(result.targetPath, 'utf8')) as McpJsonShape;
    assert.equal(written.mcpServers.eclass.env.ECLASS_USERNAME, 'new-user');
    assert.equal(written.mcpServers.eclass.env.ECLASS_PASSWORD, undefined);
    assert.equal(written.mcpServers.eclass.env.CONTROL_PLANE_API_KEY, undefined);
    assert.equal(written.mcpServers.eclass.env.KEEP, 'safe');
    assert.equal(await fs.readFile(legacyPath, 'utf8'), legacyRaw);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('nonmatching legacy .mcp.json is ignored', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-mcp-other-'));
  const projectRoot = path.join(parent, 'eclass-mcp');
  await fs.mkdir(projectRoot);
  await fs.writeFile(legacyMcpJsonPath(projectRoot), JSON.stringify({
    mcpServers: {
      eclass: {
        command: 'node',
        args: ['/another/checkout/dist/index.js'],
        env: { ECLASS_USERNAME: 'wrong-user' },
      },
    },
  }));

  try {
    const result = await readOrCreateProjectMcpJsonConfig(projectRoot);
    assert.equal(result.legacySource, undefined);
    assert.deepEqual(result.config, createDefaultMcpJsonConfig(projectRoot));
    assert.equal(await readProjectMcpJsonCredentialEnv(projectRoot), undefined);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('legacy migration rejects an extra-argument command that only mentions this checkout', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-mcp-misleading-'));
  const projectRoot = path.join(parent, 'eclass-mcp');
  await fs.mkdir(projectRoot);
  await fs.writeFile(legacyMcpJsonPath(projectRoot), JSON.stringify({
    mcpServers: {
      eclass: {
        command: 'node',
        args: ['/another/entrypoint.js', path.join(projectRoot, 'dist', 'index.js')],
        env: { ECLASS_USERNAME: 'must-not-migrate' },
      },
    },
  }));

  try {
    const result = await readOrCreateProjectMcpJsonConfig(projectRoot);
    assert.equal(result.legacySource, undefined);
    assert.deepEqual(result.config, createDefaultMcpJsonConfig(projectRoot));
    assert.equal(await readProjectMcpJsonCredentialEnv(projectRoot), undefined);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('malformed root .mcp.json is never bypassed by a valid legacy config', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-mcp-malformed-'));
  const projectRoot = path.join(parent, 'eclass-mcp');
  await fs.mkdir(projectRoot);
  await fs.writeFile(defaultMcpJsonPath(projectRoot), '{not json');
  await fs.writeFile(legacyMcpJsonPath(projectRoot), JSON.stringify({
    mcpServers: {
      eclass: {
        command: 'node',
        args: [path.join(projectRoot, 'dist', 'index.js')],
        env: { ECLASS_USERNAME: 'legacy-user' },
      },
    },
  }));

  try {
    await assert.rejects(() => readOrCreateProjectMcpJsonConfig(projectRoot), SyntaxError);
    await assert.rejects(() => readProjectMcpJsonCredentialEnv(projectRoot), SyntaxError);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('explicit .mcp.json path bypasses root and legacy migration', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-mcp-explicit-'));
  const projectRoot = path.join(parent, 'eclass-mcp');
  const explicitPath = path.join(parent, 'custom', 'client.json');
  await fs.mkdir(projectRoot);
  await fs.writeFile(legacyMcpJsonPath(projectRoot), JSON.stringify({
    mcpServers: {
      eclass: {
        command: 'node',
        args: [path.join(projectRoot, 'dist', 'index.js')],
        env: { ECLASS_USERNAME: 'legacy-user' },
      },
    },
  }));

  try {
    const result = await readOrCreateProjectMcpJsonConfig(projectRoot, explicitPath);
    assert.equal(result.targetPath, explicitPath);
    assert.equal(result.legacySource, undefined);
    assert.equal(result.config.mcpServers?.eclass?.env?.ECLASS_USERNAME, undefined);
    assert.equal(await readProjectMcpJsonCredentialEnv(projectRoot, explicitPath), undefined);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

type McpJsonShape = {
  mcpServers: Record<string, { env: Record<string, string> }>;
};
