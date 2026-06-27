import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import YAML from 'yaml';

import { resolveDoctorCredentials } from '../src/doctor.js';
import {
  createDefaultMcpJsonConfig,
  readOrCreateHermesConfig,
  readOrCreateMcpJsonConfig,
  updateHermesEclassServer,
  updateMcpJsonEclassServer,
  writeHermesConfig,
} from '../src/mcp-config.js';

test('Hermes config update writes eclass server and preserves unrelated fields', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-hermes-'));
  const configPath = path.join(dir, 'config.yaml');
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
          OPENAI_API_KEY: 'openai',
          ECLASS_OCR_MODEL: 'model',
        },
      },
      other: { command: 'other' },
    },
  }));

  const { config } = await readOrCreateMcpJsonConfig(mcpJsonPath, dir);
  updateMcpJsonEclassServer(config, { projectRoot: dir, username: 'new_user' });
  await fs.writeFile(mcpJsonPath, JSON.stringify(config, null, 2) + '\n');

  const written = JSON.parse(await fs.readFile(mcpJsonPath, 'utf8')) as any;
  assert.equal(written.mcpServers.eclass.env.ECLASS_USERNAME, 'new_user');
  assert.equal(written.mcpServers.eclass.env.ECLASS_PASSWORD, undefined);
  assert.equal(written.mcpServers.eclass.env.OPENAI_API_KEY, undefined);
  assert.equal(written.mcpServers.eclass.env.ECLASS_OCR_MODEL, undefined);
  assert.equal(written.mcpServers.other.command, 'other');
  // Must launch node directly (not `pnpm start`, whose stdout banner breaks JSON-RPC)
  assert.equal(written.mcpServers.eclass.command, 'node');
  assert.deepEqual(written.mcpServers.eclass.args, [path.join(dir, 'dist', 'index.js')]);

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
