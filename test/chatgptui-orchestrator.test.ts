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
      ECLASS_CREDENTIAL_BACKEND: 'encrypted',
      ECLASS_SECRET_KEY: 'a'.repeat(44),
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

test('runChatgptui injects the same auth token into both child envs but never logs it', async () => {
  const logs: string[] = [];
  const envsSeen: Array<Record<string, string>> = [];
  const { deps } = makeDeps({
    spawn: (cmd: string, _args: string[], opts?: any) => {
      envsSeen.push(opts?.env ?? {});
      return { pid: cmd.includes('tunnel-client') ? 2002 : 1001, killed: false, kill() {} };
    },
    log: (m: string) => logs.push(m),
  });
  const result = await runChatgptui(deps as any);
  assert.equal(result.ok, true);
  const httpToken = envsSeen[0].ECLASS_REMOTE_AUTH_TOKEN;
  const tunnelToken = envsSeen[1].ECLASS_REMOTE_AUTH_TOKEN;
  assert.ok(httpToken && httpToken.length >= 32);
  assert.equal(httpToken, tunnelToken);
  assert.ok(!logs.join('\n').includes(httpToken));
});

test('runChatgptui maps OPENAI_API_KEY fallback to CONTROL_PLANE_API_KEY for tunnel profile env refs', async () => {
  const envsSeen: Array<Record<string, string>> = [];
  const { deps } = makeDeps({
    env: {
      ECLASS_CREDENTIAL_BACKEND: 'encrypted',
      ECLASS_SECRET_KEY: 'a'.repeat(44),
      OPENAI_API_KEY: 'sk-fallback',
      CONTROL_PLANE_TUNNEL_ID: 'tunnel_abc',
      ECLASS_USERNAME: 'student1',
    },
    spawn: (cmd: string, _args: string[], opts?: any) => {
      envsSeen.push(opts?.env ?? {});
      return { pid: cmd.includes('tunnel-client') ? 2002 : 1001, killed: false, kill() {} };
    },
  });
  const result = await runChatgptui(deps as any);
  assert.equal(result.ok, true);
  assert.equal(envsSeen[0].CONTROL_PLANE_API_KEY, 'sk-fallback');
  assert.equal(envsSeen[1].CONTROL_PLANE_API_KEY, 'sk-fallback');
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
  assert.equal(envsSeen[1].ECLASS_USERNAME, 'student-from-config');
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
