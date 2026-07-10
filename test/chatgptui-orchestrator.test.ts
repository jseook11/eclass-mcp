import test from 'node:test';
import assert from 'node:assert/strict';
import { runChatgptui } from '../src/chatgptui/orchestrator.js';

type FakeChild = { pid: number; killed: boolean; kill: () => void };

function makeDeps(overrides: Partial<any> = {}) {
  const spawned: Array<{ cmd: string; args: string[] }> = [];
  const httpChild: FakeChild = { pid: 1001, killed: false, kill() { this.killed = true; } };
  const tunnelChild: FakeChild = { pid: 2002, killed: false, kill() { this.killed = true; } };
  const writes: Array<{ path: string; record: any }> = [];

  const deps = {
    env: {
      PATH: '/usr/bin:/bin',
      HOME: '/home/test',
      ECLASS_CREDENTIAL_BACKEND: 'encrypted',
      ECLASS_SECRET_KEY: Buffer.alloc(32, 1).toString('base64'),
      CONTROL_PLANE_API_KEY: 'sk-test',
      CONTROL_PLANE_TUNNEL_ID: 'tunnel_abc',
      ECLASS_USERNAME: 'student1',
    } as Record<string, string>,
    spawn: (cmd: string, args: string[]) => {
      spawned.push({ cmd, args });
      return cmd.includes('tunnel-client') ? tunnelChild : httpChild;
    },
    waitHttpReady: async () => true,
    runDoctor: async () => ({ proceed: true, tolerated: [], blocking: [] as string[] }),
    waitTunnelReady: async () => true,
    ensureProfile: async () => ({ created: true }),
    writePid: async (pidPath: string, record: any) => { writes.push({ path: pidPath, record }); },
    log: () => {},
    ...overrides,
  };
  return { deps, spawned, httpChild, tunnelChild, writes };
}

test('runChatgptui starts http server then tunnel-client and writes pid file', async () => {
  const { deps, spawned, writes } = makeDeps();
  const result = await runChatgptui(deps as any);
  assert.equal(result.ok, true);
  assert.match(spawned[0].cmd, /node/);
  assert.ok(spawned[0].args.includes('--http'));
  assert.match(spawned[1].cmd, /tunnel-client/);
  assert.ok(spawned[1].args.includes('run'));
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].record, { http: 1001, tunnel: 2002, port: 8787 });
});

test('runChatgptui writes optional orchestrator pid for stop coordination', async () => {
  const { deps, writes } = makeDeps({ orchestratorPid: 3003 });
  const result = await runChatgptui(deps as any);
  assert.equal(result.ok, true);
  assert.deepEqual(writes[0].record, { http: 1001, tunnel: 2002, port: 8787, orchestrator: 3003 });
});

test('runChatgptui splits least-privilege HTTP and tunnel environments', async () => {
  const logs: string[] = [];
  const envsSeen: Array<{ cmd: string; env: Record<string, string> }> = [];
  let doctorEnv: Record<string, string> | undefined;
  const { deps } = makeDeps({
    env: {
      PATH: '/custom/bin',
      HOME: '/home/test',
      ECLASS_CREDENTIAL_BACKEND: 'encrypted',
      ECLASS_SECRET_KEY: Buffer.alloc(32, 2).toString('base64'),
      ECLASS_DB_PATH: '/home/test/files.db',
      ECLASS_PASSWORD: 'must-not-propagate',
      ALLOW_PLAINTEXT_ENV_SECRETS: ' true ',
      CONTROL_PLANE_API_KEY: 'sk-control',
      CONTROL_PLANE_TUNNEL_ID: 'tunnel_abc',
      ECLASS_USERNAME: 'student1',
      OPENAI_API_KEY: 'must-not-propagate',
      UNRELATED_SECRET: 'must-not-propagate',
    },
    spawn: (cmd: string, _args: string[], opts?: any) => {
      envsSeen.push({ cmd, env: opts?.env ?? {} });
      return { pid: cmd.includes('tunnel-client') ? 2002 : 1001, killed: false, kill() {} };
    },
    runDoctor: async (_profilePath: string, env: Record<string, string>) => {
      doctorEnv = env;
      return { proceed: true, tolerated: [], blocking: [] as string[] };
    },
    log: (m: string) => logs.push(m),
  });
  const result = await runChatgptui(deps as any);
  assert.equal(result.ok, true);
  const httpEnv = envsSeen[0].env;
  const tunnelEnv = envsSeen[1].env;
  const httpToken = httpEnv.ECLASS_REMOTE_AUTH_TOKEN;
  const tunnelToken = tunnelEnv.ECLASS_REMOTE_AUTH_TOKEN;
  assert.ok(httpToken && httpToken.length >= 32);
  assert.equal(httpToken, tunnelToken);
  assert.equal(httpEnv.ECLASS_SECRET_KEY?.length, 44);
  assert.equal(httpEnv.ECLASS_USERNAME, 'student1');
  assert.equal(httpEnv.ECLASS_DB_PATH, '/home/test/files.db');
  assert.equal(httpEnv.CONTROL_PLANE_API_KEY, undefined);
  assert.equal(httpEnv.OPENAI_API_KEY, undefined);
  assert.equal(httpEnv.ECLASS_PASSWORD, 'must-not-propagate');
  assert.equal(httpEnv.ALLOW_PLAINTEXT_ENV_SECRETS, '1');
  assert.equal(httpEnv.UNRELATED_SECRET, undefined);
  assert.equal(tunnelEnv.CONTROL_PLANE_API_KEY, 'sk-control');
  assert.equal(tunnelEnv.CONTROL_PLANE_TUNNEL_ID, 'tunnel_abc');
  assert.equal(tunnelEnv.ECLASS_SECRET_KEY, undefined);
  assert.equal(tunnelEnv.ECLASS_USERNAME, undefined);
  assert.equal(tunnelEnv.ECLASS_DB_PATH, undefined);
  assert.equal(tunnelEnv.ECLASS_PASSWORD, undefined);
  assert.equal(tunnelEnv.ALLOW_PLAINTEXT_ENV_SECRETS, undefined);
  assert.equal(tunnelEnv.OPENAI_API_KEY, undefined);
  assert.equal(tunnelEnv.UNRELATED_SECRET, undefined);
  assert.equal(tunnelEnv.PATH, '/custom/bin');
  assert.deepEqual(doctorEnv, tunnelEnv);
  assert.ok(!logs.join('\n').includes(httpToken));
});

test('runChatgptui omits an ambient LMS password unless plaintext override is explicit', async () => {
  for (const override of [undefined, '0', 'false']) {
    const envsSeen: Array<Record<string, string>> = [];
    const { deps } = makeDeps({
      env: {
        PATH: '/usr/bin:/bin',
        HOME: '/home/test',
        ECLASS_CREDENTIAL_BACKEND: 'encrypted',
        ECLASS_SECRET_KEY: Buffer.alloc(32, 3).toString('base64'),
        ECLASS_PASSWORD: 'ambient-password-must-stay-out',
        ...(override === undefined ? {} : { ALLOW_PLAINTEXT_ENV_SECRETS: override }),
        CONTROL_PLANE_API_KEY: 'sk-control',
        CONTROL_PLANE_TUNNEL_ID: 'tunnel_abc',
        ECLASS_USERNAME: 'student1',
      },
      spawn: (_cmd: string, _args: string[], opts?: { env?: Record<string, string> }) => {
        envsSeen.push(opts?.env ?? {});
        return { pid: envsSeen.length === 1 ? 1001 : 2002, kill() {} };
      },
    });

    const result = await runChatgptui(deps as any);
    assert.equal(result.ok, true);
    assert.equal(envsSeen[0].ECLASS_PASSWORD, undefined);
    assert.equal(envsSeen[0].ALLOW_PLAINTEXT_ENV_SECRETS, undefined);
    assert.equal(envsSeen[1].ECLASS_PASSWORD, undefined);
  }
});

test('runChatgptui rejects OPENAI_API_KEY as a control-plane fallback', async () => {
  const { deps, spawned } = makeDeps({
    env: {
      ECLASS_CREDENTIAL_BACKEND: 'encrypted',
      ECLASS_SECRET_KEY: Buffer.alloc(32, 1).toString('base64'),
      OPENAI_API_KEY: 'sk-fallback',
      CONTROL_PLANE_TUNNEL_ID: 'tunnel_abc',
      ECLASS_USERNAME: 'student1',
    },
  });
  const result = await runChatgptui(deps as any);
  assert.equal(result.ok, false);
  assert.equal(spawned.length, 0);
  assert.ok(result.errors?.some((error) => error.includes('CONTROL_PLANE_API_KEY')));
});

test('runChatgptui resolves ECLASS_USERNAME from local config when env is missing', async () => {
  const envsSeen: Array<Record<string, string>> = [];
  const { deps } = makeDeps({
    env: {
      CONTROL_PLANE_API_KEY: 'sk-test',
      CONTROL_PLANE_TUNNEL_ID: 'tunnel_abc',
    },
    resolveUsername: async () => 'student-from-config',
    spawn: (_cmd: string, _args: string[], opts?: any) => {
      envsSeen.push(opts?.env ?? {});
      return { pid: envsSeen.length === 1 ? 1001 : 2002, killed: false, kill() {} };
    },
  });
  const result = await runChatgptui(deps as any);
  assert.equal(result.ok, true);
  assert.equal(envsSeen[0].ECLASS_USERNAME, 'student-from-config');
  assert.equal(envsSeen[1].ECLASS_USERNAME, undefined);
});

test('runChatgptui aborts (and kills http) when env invalid', async () => {
  const { deps, spawned } = makeDeps({ env: { ECLASS_USERNAME: 'x' } });
  const result = await runChatgptui(deps as any);
  assert.equal(result.ok, false);
  assert.ok(result.errors && result.errors.length > 0);
  assert.equal(spawned.length, 0);
});

test('runChatgptui aborts and kills http server when http readiness times out', async () => {
  const { deps, httpChild } = makeDeps({ waitHttpReady: async () => false });
  const result = await runChatgptui(deps as any);
  assert.equal(result.ok, false);
  assert.equal(httpChild.killed, true);
});

test('runChatgptui aborts and kills http server when doctor reports blocking failure', async () => {
  const { deps, httpChild } = makeDeps({
    runDoctor: async () => ({ proceed: false, tolerated: [], blocking: ['tunnel_id'] }),
  });
  const result = await runChatgptui(deps as any);
  assert.equal(result.ok, false);
  assert.equal(httpChild.killed, true);
});

test('runChatgptui kills http server when profile setup throws after startup', async () => {
  const { deps, httpChild } = makeDeps({
    ensureProfile: async () => {
      throw new Error('profile conflict');
    },
  });
  const result = await runChatgptui(deps as any);
  assert.equal(result.ok, false);
  assert.equal(httpChild.killed, true);
});

test('runChatgptui kills both children when pid write throws after tunnel startup', async () => {
  const { deps, httpChild, tunnelChild } = makeDeps({
    writePid: async () => {
      throw new Error('pid write failed');
    },
  });
  const result = await runChatgptui(deps as any);
  assert.equal(result.ok, false);
  assert.equal(httpChild.killed, true);
  assert.equal(tunnelChild.killed, true);
});
