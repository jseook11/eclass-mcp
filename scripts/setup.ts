#!/usr/bin/env node
/**
 * eclass MCP 설정 스크립트
 * 사용: pnpm run setup -- [--target hermes|mcp-json|both]
 */
import { execFile } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as readline from 'node:readline';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  setCredential,
  resolveMasterKey,
  SECRET_KEY_ENV,
  CREDENTIAL_BACKEND_ENV,
} from '../src/credential-store.js';
import {
  defaultHermesConfigPath,
  defaultMcpJsonPath,
  pathExists,
  readHermesCredentialEnv,
  readOrCreateHermesConfig,
  readOrCreateMcpJsonConfig,
  updateHermesEclassServer,
  updateMcpJsonEclassServer,
  writeHermesConfig,
} from '../src/mcp-config.js';
import { KEYCHAIN_SERVICE } from '../src/secrets.js';
import { runDoctor } from '../src/doctor.js';

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

function formatCredentialStoreFailure(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
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
    `   원인: ${detail}`,
  ].join('\n');
}

async function readCurrentUsername(
  target: SetupTarget,
  hermesConfigPath: string,
  mcpJsonPath: string,
): Promise<string> {
  if (target === 'hermes' || target === 'both') {
    const hermesEnv = await readHermesCredentialEnv(hermesConfigPath);
    if (hermesEnv?.username) return hermesEnv.username;
  }

  try {
    const { config } = await readOrCreateMcpJsonConfig(mcpJsonPath, path.resolve(__dirname, '..'));
    return config.mcpServers?.eclass?.env?.ECLASS_USERNAME?.trim() || '';
  } catch {
    return '';
  }
}

export async function runSetup(
  rawOptions: SetupOptions,
  projectRoot: string = path.resolve(__dirname, '..'),
): Promise<number> {
  console.log('eclass MCP 설정');
  console.log('─'.repeat(30));

  const target = await resolveTarget(rawOptions);
  const defaultHermesPath = rawOptions.configPath && target === 'hermes'
    ? rawOptions.configPath
    : await detectHermesConfigPath() ?? defaultHermesConfigPath();
  const hermesConfigPath = rawOptions.configPath && target !== 'mcp-json'
    ? rawOptions.configPath
    : defaultHermesPath;
  const mcpJsonPath = rawOptions.configPath && target === 'mcp-json'
    ? rawOptions.configPath
    : defaultMcpJsonPath(projectRoot);

  const currentUsername = await readCurrentUsername(target, hermesConfigPath, mcpJsonPath);
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

  const password = rawOptions.passwordStdin
    ? (await readPasswordFromStdin()).trim()
    : (await questionHidden('Password: ')).trim();
  const summary: string[] = [];

  if (!password) {
    console.error('❌ Password를 입력해야 합니다.');
    return 1;
  }

  if (target === 'encrypted') {
    let masterKey = await resolveMasterKey();
    if (!masterKey) {
      masterKey = crypto.randomBytes(32);
      const b64 = masterKey.toString('base64');
      process.env[SECRET_KEY_ENV] = b64;
      console.error('🔑 새 마스터 키를 생성했습니다(디스크에 저장되지 않음):');
      console.error(`   ${SECRET_KEY_ENV}=${b64}`);
      console.error('   서버 기동 시 이 값을 환경변수로 주입하거나 0o600 키파일로 저장하세요.');
      console.error('   이 키를 잃어버리면 저장된 비밀번호를 복호화할 수 없습니다.');
    }
    process.env[CREDENTIAL_BACKEND_ENV] = 'encrypted';
  }

  if (rawOptions.allowPlaintextEnv) {
    console.error('⚠️  ECLASS_PASSWORD를 MCP config env에 plaintext로 저장합니다.');
    console.error('   Hermes client에서 env가 보일 수 있으므로 권장하지 않습니다.');
    console.error('   OS credential store 사용이 불가능한 환경에서만 명시적으로 선택하세요.');
  } else {
    try {
      await setCredential(KEYCHAIN_SERVICE, username, password, { allowFileFallback: false });
      summary.push(
        target === 'encrypted'
          ? 'LMS password: stored in encrypted file (secrets.enc)'
          : 'LMS password: stored in OS credential store',
      );
    } catch (err) {
      console.error(formatCredentialStoreFailure(err));
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
      const { config, created } = await readOrCreateMcpJsonConfig(mcpJsonPath, projectRoot);
      updateMcpJsonEclassServer(config, { projectRoot, username });
      await fs.writeFile(mcpJsonPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
      summary.push(`.mcp.json: ${created ? 'created' : 'updated'} ${mcpJsonPath}`);
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
    console.log('검차 생략 (--no-doctor)');
    return 0;
  }

  const checkResults = await runDoctor(username, {
    hermesConfigPath,
    mcpJsonPath,
    envPassword: rawOptions.allowPlaintextEnv ? password : undefined,
    plaintextOverride: rawOptions.allowPlaintextEnv ? '1' : undefined,
  });
  console.log('검차');
  console.log('─'.repeat(30));
  for (const result of checkResults) {
    const prefix = result.ok ? '✓' : '✗';
    console.log(`${prefix} ${result.name}: ${result.detail}`);
  }

  if (checkResults.some((result) => !result.ok)) {
    console.log('');
    console.error('❌ 설정은 저장됐지만 검차에 실패했습니다. 위 항목을 확인하세요.');
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
