#!/usr/bin/env node
/**
 * eclass MCP 설정 스크립트
 * 사용: pnpm run setup -- [--target hermes|mcp-json|both]
 */
import { execFile } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as readline from 'node:readline';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  deleteCredential,
  getCredential,
  getCredentialBackend,
  setCredential,
  resolveMasterKey,
  SECRET_KEY_ENV,
  SECRET_KEY_FILE_ENV,
  CREDENTIAL_BACKEND_ENV,
  type CredentialBackend,
} from '../src/credential-store.js';
import {
  defaultHermesConfigPath,
  defaultMcpJsonPath,
  pathExists,
  readHermesCredentialEnv,
  readOrCreateHermesConfig,
  readOrCreateProjectMcpJsonConfig,
  readProjectMcpJsonCredentialEnv,
  updateHermesEclassServer,
  updateMcpJsonEclassServer,
  writeHermesConfig,
  writeMcpJsonConfig,
} from '../src/mcp-config.js';
import { KEYCHAIN_SERVICE } from '../src/secrets.js';
import { runDoctor } from '../src/doctor.js';
import { sanitizeDebug } from '../src/errors.js';
import { createPrivateFileExclusive } from '../src/private-file.js';
import { expandTilde } from '../src/utils.js';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type SetupTarget = 'hermes' | 'mcp-json' | 'both' | 'encrypted';

type SetupOptions = {
  target?: SetupTarget;
  username?: string;
  passwordStdin: boolean;
  allowPlaintextEnv: boolean;
  noDoctor: boolean;
  configPath?: string;
  generateMasterKeyFile?: string;
};

export function parseArgs(argv: string[]): SetupOptions {
  const options: SetupOptions = {
    passwordStdin: false,
    allowPlaintextEnv: false,
    noDoctor: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--target': {
        const value = argv[++index] as SetupTarget | undefined;
        if (
          value !== 'hermes' &&
          value !== 'mcp-json' &&
          value !== 'both' &&
          value !== 'encrypted'
        ) {
          throw new Error('--target 값은 hermes, mcp-json, both, encrypted 중 하나여야 합니다.');
        }
        options.target = value;
        break;
      }
      case '--username':
        options.username = argv[++index];
        if (!options.username) throw new Error('--username 값이 필요합니다.');
        break;
      case '--password-stdin':
        options.passwordStdin = true;
        break;
      case '--allow-plaintext-env':
        options.allowPlaintextEnv = true;
        break;
      case '--no-doctor':
        options.noDoctor = true;
        break;
      case '--config':
        {
          const value = argv[++index];
          if (!value) throw new Error('--config 값이 필요합니다.');
          options.configPath = path.resolve(value);
        }
        break;
      case '--generate-master-key-file': {
        const value = argv[++index];
        if (!value) throw new Error('--generate-master-key-file 경로가 필요합니다.');
        options.generateMasterKeyFile = path.resolve(expandTilde(value));
        break;
      }
      default:
        throw new Error(`알 수 없는 옵션: ${arg}`);
    }
  }

  return options;
}

function question(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

function readPasswordFromStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      input += chunk;
    });
    process.stdin.on('end', () => resolve(input.replace(/\r?\n$/, '')));
    process.stdin.on('error', reject);
  });
}

function questionHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);

    let input = '';
    const canUseRawMode = typeof process.stdin.setRawMode === 'function';
    if (canUseRawMode) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    const handler = (char: string) => {
      if (char === '\r' || char === '\n') {
        process.stdout.write('\n');
        if (canUseRawMode) process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', handler);
        resolve(input);
      } else if (char === '\u0003') {
        process.stdout.write('\n');
        if (canUseRawMode) process.stdin.setRawMode(false);
        process.exit(130);
      } else if (char === '\u007f') {
        if (input.length > 0) {
          process.stdout.write('\b \b');
          input = input.slice(0, -1);
        }
      } else {
        process.stdout.write('•');
        input += char;
      }
    };

    process.stdin.on('data', handler);
  });
}

async function detectHermesConfigPath(): Promise<string | undefined> {
  const defaultPath = defaultHermesConfigPath();
  if (await pathExists(defaultPath)) return defaultPath;

  try {
    const { stdout } = await execFileAsync('hermes', ['config', 'path']);
    const detected = stdout.trim();
    return detected || undefined;
  } catch {
    return undefined;
  }
}

async function resolveTarget(options: SetupOptions): Promise<SetupTarget> {
  if (options.target) return options.target;
  if (options.configPath) {
    const ext = path.extname(options.configPath).toLowerCase();
    if (ext === '.yaml' || ext === '.yml') return 'hermes';
    if (ext === '.json') return 'mcp-json';
  }
  return (await detectHermesConfigPath()) ? 'hermes' : 'mcp-json';
}

type CredentialFailureContext = {
  target: SetupTarget;
  resolvedBackend?: CredentialBackend;
  configuredBackend?: string;
  secretValues?: ReadonlyArray<string | undefined>;
};

type CredentialFailureKind = 'encrypted' | 'keytar' | 'unavailable';

function credentialFailureKind(context: CredentialFailureContext): CredentialFailureKind {
  if (
    context.target === 'encrypted' ||
    context.resolvedBackend === 'encrypted' ||
    context.configuredBackend === 'encrypted'
  ) {
    return 'encrypted';
  }
  if (context.resolvedBackend === 'keytar' || context.configuredBackend === 'keytar') {
    return 'keytar';
  }
  return 'unavailable';
}

function safeCredentialFailureDetail(
  err: unknown,
  secretValues: ReadonlyArray<string | undefined> = [],
): string {
  let detail = err instanceof Error ? err.message : String(err);
  for (const secret of secretValues) {
    if (secret) detail = detail.split(secret).join('[redacted]');
  }
  detail = detail
    .replace(
      /((?:password|secret|token|api[_ -]?key|master[_ -]?key)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1[redacted]',
    )
    .replace(/\b[A-Za-z0-9+/_-]{32,}={0,2}\b/g, '[redacted]');
  return sanitizeDebug(detail) || '알 수 없는 오류';
}

function formatEncryptedCredentialStoreFailure(detail: string): string {
  return [
    '❌ encrypted credential store에 비밀번호를 저장하지 못했습니다.',
    '   MCP/Hermes 설정 파일은 아직 변경하지 않았습니다.',
    '',
    '   조치:',
    '   1. ECLASS_ENC_STORE_PATH의 파일이 일반 파일·0600이고 상위 디렉터리가 본인 소유·0700인지 확인하세요.',
    '   2. 기존 secrets.enc는 생성 당시와 같은 master key로만 열 수 있습니다. 올바른 키나 백업을 복구하세요.',
    '   3. 손상 가능성이 있으면 기존 파일을 보존한 뒤 복구하고, 디스크 여유 공간과 atomic rename 권한을 확인하세요.',
    '   4. 같은 setup 명령을 다시 실행하세요.',
    `   원인: ${detail}`,
  ].join('\n');
}

function formatKeytarCredentialStoreFailure(detail: string): string {
  return [
    '❌ OS credential store를 사용할 수 없습니다.',
    '   Linux에서도 keytar는 Secret Service/libsecret 백엔드로 저장할 수 있습니다.',
    '   이 오류는 보통 GNOME Keyring/KWallet 같은 Secret Service가 실행 중이 아니거나,',
    '   기본/login collection이 없거나 잠겨 있을 때 발생합니다.',
    '   비밀번호는 Hermes config에 저장되지 않았습니다.',
    '',
    '   조치:',
    '   1. libsecret/secret-tool 및 GNOME Keyring 또는 KWallet을 설치하세요.',
    '   2. 사용자 세션 D-Bus에서 Secret Service를 시작하고 기본/login collection을 생성 또는 잠금해제하세요.',
    '   3. `secret-tool store --label=eclass-mcp service eclass-mcp account test`가 성공하는지 확인하세요.',
    '   4. 같은 setup 명령을 다시 실행하세요.',
    '   5. 헤드리스 서버라면 --target encrypted와 명시적 master key를 사용하세요.',
    `   원인: ${detail}`,
  ].join('\n');
}

function formatUnavailableCredentialStoreFailure(detail: string): string {
  return [
    '❌ 쓰기 가능한 secure credential backend를 사용할 수 없습니다.',
    '   plaintext secrets.json backend는 legacy read-only이며 새 credential을 저장하지 않습니다.',
    '   MCP/Hermes 설정 파일은 아직 변경하지 않았습니다.',
    '',
    '   조치:',
    '   1. OS credential store를 사용하려면 ECLASS_CREDENTIAL_BACKEND=keytar와 사용 가능한 keychain을 준비하세요.',
    '   2. 헤드리스 환경에서는 ECLASS_CREDENTIAL_BACKEND=encrypted와 명시적 master key를 설정하세요.',
    '   3. 같은 setup 명령을 다시 실행하세요.',
    `   원인: ${detail}`,
  ].join('\n');
}

export function formatCredentialStoreFailure(
  err: unknown,
  context: CredentialFailureContext,
): string {
  const detail = safeCredentialFailureDetail(err, context.secretValues);
  switch (credentialFailureKind(context)) {
    case 'encrypted':
      return formatEncryptedCredentialStoreFailure(detail);
    case 'keytar':
      return formatKeytarCredentialStoreFailure(detail);
    default:
      return formatUnavailableCredentialStoreFailure(detail);
  }
}

function formatPlaintextOverrideBackendFailure(
  err: unknown,
  context: CredentialFailureContext,
): string {
  const detail = safeCredentialFailureDetail(err, context.secretValues);
  const remediation = credentialFailureKind(context) === 'encrypted'
    ? `ECLASS_CREDENTIAL_BACKEND=encrypted와 ${SECRET_KEY_ENV} 또는 ${SECRET_KEY_FILE_ENV}를 올바르게 설정하세요.`
    : 'ECLASS_CREDENTIAL_BACKEND=keytar 또는 master key가 설정된 encrypted backend를 준비하세요.';
  return [
    '❌ --allow-plaintext-env에도 쓰기 가능한 secure credential backend가 필요합니다.',
    '   LMS 비밀번호만 Hermes config에 저장되며 Canvas token/session은 secure backend에 저장됩니다.',
    `   조치: ${remediation}`,
    `   원인: ${detail}`,
  ].join('\n');
}

async function probeSecureCredentialBackend(): Promise<CredentialBackend> {
  const backend = await getCredentialBackend();
  if (backend === 'file') {
    throw new Error(
      'The plaintext file credential backend is legacy read-only and cannot persist Canvas tokens or sessions.',
    );
  }

  const service = 'eclass-mcp-setup-probe';
  const account = `probe:${crypto.randomUUID()}`;
  const value = crypto.randomBytes(32).toString('base64url');
  let stored = false;
  try {
    try {
      await setCredential(service, account, value, { allowFileFallback: false });
      stored = true;
    } catch (writeErr) {
      // setCredential can report a post-write cleanup error. Read back without
      // treating backend failures as misses so a durable probe is still removed.
      try {
        stored = (await getCredential(service, account)) === value;
      } catch {
        // The original write error is the most actionable failure.
      }
      throw writeErr;
    }

    const observed = await getCredential(service, account);
    if (observed !== value) {
      throw new Error('Secure credential backend probe readback verification failed');
    }
    return backend;
  } finally {
    if (stored) {
      await deleteCredential(service, account);
    }
  }
}

async function readCurrentUsername(
  target: SetupTarget,
  hermesConfigPath: string,
  projectRoot: string,
  explicitMcpJsonPath?: string,
): Promise<string> {
  if (target === 'hermes' || target === 'both') {
    const hermesEnv = await readHermesCredentialEnv(hermesConfigPath);
    if (hermesEnv?.username) return hermesEnv.username;
  }

  const mcpJsonEnv = await readProjectMcpJsonCredentialEnv(projectRoot, explicitMcpJsonPath);
  return mcpJsonEnv?.username ?? '';
}

export async function runSetup(
  rawOptions: SetupOptions,
  projectRoot: string = path.resolve(__dirname, '..'),
): Promise<number> {
  console.log('eclass MCP 설정');
  console.log('─'.repeat(30));

  const target = await resolveTarget(rawOptions);
  if (rawOptions.configPath && (target === 'both' || target === 'encrypted')) {
    console.error(`❌ --config는 --target ${target}와 함께 사용할 수 없습니다.`);
    console.error(
      target === 'both'
        ? '   Hermes와 .mcp.json 경로가 하나로 모호해지므로 hermes/mcp-json setup을 각각 실행하세요.'
        : '   encrypted target은 client config를 수정하지 않으므로 --config가 적용될 대상이 없습니다.',
    );
    return 1;
  }
  if (rawOptions.allowPlaintextEnv && target !== 'hermes') {
    console.error('❌ --allow-plaintext-env는 --target hermes에서만 사용할 수 있습니다.');
    console.error('   mcp-json/both/encrypted 대상은 secure credential store가 필요합니다.');
    return 1;
  }
  const defaultHermesPath = rawOptions.configPath && target === 'hermes'
    ? rawOptions.configPath
    : await detectHermesConfigPath() ?? defaultHermesConfigPath();
  const hermesConfigPath = rawOptions.configPath && target !== 'mcp-json'
    ? rawOptions.configPath
    : defaultHermesPath;
  const explicitMcpJsonPath = rawOptions.configPath && target === 'mcp-json'
    ? rawOptions.configPath
    : undefined;
  const mcpJsonPath = explicitMcpJsonPath ?? defaultMcpJsonPath(projectRoot);

  const currentUsername = await readCurrentUsername(
    target,
    hermesConfigPath,
    projectRoot,
    explicitMcpJsonPath,
  );
  const summary: string[] = [];
  let username = rawOptions.username?.trim() ?? '';
  if (!username) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const usernameInput = (await question(
      rl,
      currentUsername ? `Username [${currentUsername}]: ` : 'Username: ',
    )).trim();
    rl.close();
    username = usernameInput || currentUsername;
  }

  if (!username) {
    console.error('❌ Username을 입력해야 합니다.');
    return 1;
  }

  if (rawOptions.generateMasterKeyFile && target !== 'encrypted') {
    console.error('❌ --generate-master-key-file은 --target encrypted와 함께 사용해야 합니다.');
    return 1;
  }

  if (target === 'encrypted') {
    let masterKey: Buffer | null;
    try {
      masterKey = await resolveMasterKey();
    } catch (err) {
      console.error('❌ 마스터 키를 읽지 못했습니다:', err instanceof Error ? err.message : String(err));
      return 1;
    }

    if (rawOptions.generateMasterKeyFile) {
      if (masterKey) {
        console.error(
          `❌ ${SECRET_KEY_ENV}/${SECRET_KEY_FILE_ENV}가 이미 설정되어 있어 새 키 파일을 생성하지 않습니다.`,
        );
        return 1;
      }
      try {
        await createPrivateFileExclusive(rawOptions.generateMasterKeyFile, crypto.randomBytes(32));
        process.env[SECRET_KEY_FILE_ENV] = rawOptions.generateMasterKeyFile;
        masterKey = await resolveMasterKey();
        summary.push(`Master key: generated private file ${rawOptions.generateMasterKeyFile}`);
      } catch (err) {
        console.error('❌ 마스터 키 파일 생성 실패:', err instanceof Error ? err.message : String(err));
        return 1;
      }
    }

    if (!masterKey) {
      console.error(
        `❌ encrypted backend에는 ${SECRET_KEY_ENV} 또는 ${SECRET_KEY_FILE_ENV}가 필요합니다.\n` +
        '   새 키가 필요하면 --generate-master-key-file <private-path>를 명시하세요.',
      );
      return 1;
    }
    process.env[CREDENTIAL_BACKEND_ENV] = 'encrypted';
  }

  let resolvedCredentialBackend: CredentialBackend | undefined;
  if (rawOptions.allowPlaintextEnv) {
    try {
      resolvedCredentialBackend = await probeSecureCredentialBackend();
    } catch (err) {
      console.error(formatPlaintextOverrideBackendFailure(err, {
        target,
        resolvedBackend: resolvedCredentialBackend,
        configuredBackend: process.env[CREDENTIAL_BACKEND_ENV],
        secretValues: [process.env[SECRET_KEY_ENV]],
      }));
      return 1;
    }
  }

  const password = rawOptions.passwordStdin
    ? (await readPasswordFromStdin()).trim()
    : (await questionHidden('Password: ')).trim();

  if (!password) {
    console.error('❌ Password를 입력해야 합니다.');
    return 1;
  }

  if (rawOptions.allowPlaintextEnv) {
    console.error('⚠️  ECLASS_PASSWORD를 MCP config env에 plaintext로 저장합니다.');
    console.error('   Hermes client에서 env가 보일 수 있으므로 권장하지 않습니다.');
    console.error(
      `   Canvas token/session은 ${resolvedCredentialBackend} secure backend에 별도로 저장됩니다.`,
    );
  } else {
    try {
      resolvedCredentialBackend = await getCredentialBackend();
      await setCredential(KEYCHAIN_SERVICE, username, password, { allowFileFallback: false });
      summary.push(
        resolvedCredentialBackend === 'encrypted'
          ? 'LMS password: stored in encrypted file (secrets.enc)'
          : 'LMS password: stored in OS credential store',
      );
    } catch (err) {
      console.error(formatCredentialStoreFailure(err, {
        target,
        resolvedBackend: resolvedCredentialBackend,
        configuredBackend: process.env[CREDENTIAL_BACKEND_ENV],
        secretValues: [password, process.env[SECRET_KEY_ENV]],
      }));
      return 1;
    }
  }

  if (target === 'hermes' || target === 'both') {
    try {
      const { config, created } = await readOrCreateHermesConfig(hermesConfigPath);
      updateHermesEclassServer(config, {
        projectRoot,
        username,
        password: rawOptions.allowPlaintextEnv ? password : undefined,
        allowPlaintextEnv: rawOptions.allowPlaintextEnv,
      });
      await writeHermesConfig(hermesConfigPath, config);
      summary.push(`Hermes config: ${created ? 'created' : 'updated'} ${hermesConfigPath}`);
    } catch (err) {
      console.error('❌ Hermes config 업데이트 실패:', err instanceof Error ? err.message : err);
      return 1;
    }
  }

  if (target === 'mcp-json' || target === 'both') {
    try {
      const { config, created, targetPath, legacySource } =
        await readOrCreateProjectMcpJsonConfig(projectRoot, explicitMcpJsonPath);
      updateMcpJsonEclassServer(config, { projectRoot, username });
      await writeMcpJsonConfig(targetPath, config);
      summary.push(`.mcp.json: ${created ? 'created' : 'updated'} ${targetPath}`);
      if (legacySource) {
        summary.push(`.mcp.json: imported matching eclass entry from ${legacySource}`);
        summary.push(`.mcp.json: legacy parent file left unchanged; remove its old eclass entry manually`);
      }
      summary.push('.mcp.json: cleaned plaintext secret env entries');
    } catch (err) {
      console.error('❌ .mcp.json 업데이트 실패:', err instanceof Error ? err.message : err);
      return 1;
    }
  }

  console.log('─'.repeat(30));
  console.log(summary.map((line) => `- ${line}`).join('\n'));
  console.log('');

  if (rawOptions.noDoctor) {
    console.log('검사 생략 (--no-doctor)');
    return 0;
  }

  const checkResults = await runDoctor(username, {
    hermesConfigPath,
    mcpJsonPath,
    envPassword: rawOptions.allowPlaintextEnv ? password : undefined,
    plaintextOverride: rawOptions.allowPlaintextEnv ? '1' : undefined,
  });
  console.log('검사');
  console.log('─'.repeat(30));
  for (const result of checkResults) {
    const prefix = result.ok ? '✓' : '✗';
    console.log(`${prefix} ${result.name}: ${result.detail}`);
  }

  if (checkResults.some((result) => !result.ok)) {
    console.log('');
    console.error('❌ 설정은 저장됐지만 검사에 실패했습니다. 위 항목을 확인하세요.');
    return 1;
  }

  console.log('');
  console.log('✅ 설정 완료');
  return 0;
}

async function main(): Promise<void> {
  const exitCode = await runSetup(parseArgs(process.argv.slice(2)));
  process.exit(exitCode);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
