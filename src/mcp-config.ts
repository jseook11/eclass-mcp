import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import YAML from 'yaml';
import { writePrivateTextFileAtomic } from './private-file.js';

export type McpServerConfig = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
};

export type McpJsonConfig = {
  mcpServers?: Record<string, McpServerConfig>;
};

export type HermesConfig = {
  mcp_servers?: Record<string, McpServerConfig>;
  [key: string]: unknown;
};

export type CredentialEnv = {
  username?: string;
  password?: string;
  plaintextOverride?: string;
};

export function defaultHermesConfigPath(): string {
  return path.join(os.homedir(), '.hermes', 'config.yaml');
}

export function defaultMcpJsonPath(projectRoot: string): string {
  return path.join(projectRoot, '.mcp.json');
}

export function legacyMcpJsonPath(projectRoot: string): string {
  return path.resolve(projectRoot, '..', '.mcp.json');
}

export function serverEntryPoint(projectRoot: string): string {
  return path.join(projectRoot, 'dist', 'index.js');
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function createDefaultMcpJsonConfig(projectRoot: string): McpJsonConfig {
  // Launch node directly. Going through `pnpm start` prints a lifecycle banner
  // to stdout, which corrupts the JSON-RPC stdio stream and breaks the MCP
  // handshake (intermittent -32000 / reconnect failures).
  return {
    mcpServers: {
      eclass: {
        command: 'node',
        args: [serverEntryPoint(projectRoot)],
        env: {},
      },
    },
  };
}

export async function readOrCreateMcpJsonConfig(
  mcpJsonPath: string,
  projectRoot: string,
): Promise<{ config: McpJsonConfig; created: boolean }> {
  try {
    const raw = await fs.readFile(mcpJsonPath, 'utf-8');
    return { config: JSON.parse(raw) as McpJsonConfig, created: false };
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return { config: createDefaultMcpJsonConfig(projectRoot), created: true };
    }
    throw err;
  }
}

function isErrnoException(err: unknown, code: string): boolean {
  return Boolean(err && typeof err === 'object' && 'code' in err && err.code === code);
}

function eclassEntryTargetsProject(
  entry: McpServerConfig | undefined,
  projectRoot: string,
  configPath: string,
): boolean {
  if (!entry || entry.command !== 'node' || entry.args?.length !== 1) return false;
  const expected = path.resolve(serverEntryPoint(projectRoot));
  const scriptArg = entry.args[0];
  const resolved = path.isAbsolute(scriptArg)
    ? path.resolve(scriptArg)
    : path.resolve(path.dirname(configPath), scriptArg);
  return resolved === expected;
}

export type ProjectMcpJsonConfigResult = {
  config: McpJsonConfig;
  created: boolean;
  targetPath: string;
  legacySource?: string;
};

/**
 * Reads the repository-local .mcp.json. For the one-time migration from the
 * historical parent-directory path, only an eclass entry that points at this
 * exact checkout is copied. The legacy file is never modified here.
 */
export async function readOrCreateProjectMcpJsonConfig(
  projectRoot: string,
  explicitPath?: string,
): Promise<ProjectMcpJsonConfigResult> {
  const targetPath = explicitPath ?? defaultMcpJsonPath(projectRoot);
  if (explicitPath) {
    const result = await readOrCreateMcpJsonConfig(targetPath, projectRoot);
    return { ...result, targetPath };
  }

  try {
    const raw = await fs.readFile(targetPath, 'utf8');
    return { config: JSON.parse(raw) as McpJsonConfig, created: false, targetPath };
  } catch (err) {
    if (!isErrnoException(err, 'ENOENT')) throw err;
  }

  const legacyPath = legacyMcpJsonPath(projectRoot);
  try {
    const raw = await fs.readFile(legacyPath, 'utf8');
    const legacy = JSON.parse(raw) as McpJsonConfig;
    const eclass = legacy.mcpServers?.eclass;
    if (eclassEntryTargetsProject(eclass, projectRoot, legacyPath)) {
      return {
        config: { mcpServers: { eclass: structuredClone(eclass!) } },
        created: true,
        targetPath,
        legacySource: legacyPath,
      };
    }
  } catch (err) {
    if (!isErrnoException(err, 'ENOENT') && !(err instanceof SyntaxError)) throw err;
  }

  return {
    config: createDefaultMcpJsonConfig(projectRoot),
    created: true,
    targetPath,
  };
}

export async function readOrCreateHermesConfig(
  hermesConfigPath: string,
): Promise<{ config: HermesConfig; created: boolean }> {
  try {
    const raw = await fs.readFile(hermesConfigPath, 'utf-8');
    const parsed = YAML.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { config: {}, created: false };
    }
    return { config: parsed as HermesConfig, created: false };
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return { config: {}, created: true };
    }
    throw err;
  }
}

export async function writeHermesConfig(
  hermesConfigPath: string,
  config: HermesConfig,
): Promise<void> {
  await writePrivateTextFileAtomic(hermesConfigPath, YAML.stringify(config), {
    label: 'Hermes config',
  });
}

export async function writeMcpJsonConfig(
  mcpJsonPath: string,
  config: McpJsonConfig,
): Promise<void> {
  await writePrivateTextFileAtomic(mcpJsonPath, JSON.stringify(config, null, 2) + '\n', {
    label: '.mcp.json',
  });
}

const ALWAYS_STRIPPED_ECLASS_ENV = [
  'ECLASS_SECRET_KEY',
  'OPENAI_API_KEY',
  'CONTROL_PLANE_API_KEY',
  'ECLASS_REMOTE_AUTH_TOKEN',
  'ECLASS_TOKEN',
] as const;

function stripAmbientSecrets(env: Record<string, string>): void {
  for (const key of ALWAYS_STRIPPED_ECLASS_ENV) delete env[key];
}

export function updateHermesEclassServer(
  config: HermesConfig,
  options: {
    projectRoot: string;
    username: string;
    password?: string;
    allowPlaintextEnv: boolean;
  },
): void {
  config.mcp_servers ??= {};
  const existing = config.mcp_servers.eclass ?? {};
  const env = { ...(existing.env ?? {}) };
  stripAmbientSecrets(env);
  env.ECLASS_USERNAME = options.username;
  if (options.allowPlaintextEnv) {
    env.ALLOW_PLAINTEXT_ENV_SECRETS = '1';
    if (options.password !== undefined) env.ECLASS_PASSWORD = options.password;
  } else {
    delete env.ECLASS_PASSWORD;
    delete env.ALLOW_PLAINTEXT_ENV_SECRETS;
  }

  config.mcp_servers.eclass = {
    ...existing,
    command: 'node',
    args: [serverEntryPoint(options.projectRoot)],
    env,
    enabled: true,
  };
}

export function updateMcpJsonEclassServer(
  config: McpJsonConfig,
  options: {
    projectRoot: string;
    username: string;
  },
): void {
  config.mcpServers ??= {};
  const existing = config.mcpServers.eclass ?? {};
  const env = { ...(existing.env ?? {}) };
  stripAmbientSecrets(env);
  env.ECLASS_USERNAME = options.username;
  delete env.ECLASS_PASSWORD;
  delete env.ALLOW_PLAINTEXT_ENV_SECRETS;
  delete env.OPENAI_API_KEY;
  delete env.ECLASS_OCR_MODEL;

  // Always launch node directly (repairs older `pnpm start` configs whose
  // stdout banner corrupts the JSON-RPC stream).
  config.mcpServers.eclass = {
    ...existing,
    command: 'node',
    args: [serverEntryPoint(options.projectRoot)],
    env,
  };
}

export async function readHermesCredentialEnv(
  hermesConfigPath: string = defaultHermesConfigPath(),
): Promise<CredentialEnv | undefined> {
  try {
    const { config } = await readOrCreateHermesConfig(hermesConfigPath);
    const env = config.mcp_servers?.eclass?.env;
    if (!env) return undefined;
    return {
      username: env.ECLASS_USERNAME?.trim() || undefined,
      password: env.ECLASS_PASSWORD,
      plaintextOverride: env.ALLOW_PLAINTEXT_ENV_SECRETS,
    };
  } catch {
    return undefined;
  }
}

export async function readMcpJsonCredentialEnv(
  mcpJsonPath: string,
): Promise<CredentialEnv | undefined> {
  try {
    const raw = await fs.readFile(mcpJsonPath, 'utf-8');
    const config = JSON.parse(raw) as McpJsonConfig;
    const env = config.mcpServers?.eclass?.env;
    if (!env) return undefined;
    return {
      username: env.ECLASS_USERNAME?.trim() || undefined,
      password: env.ECLASS_PASSWORD,
      plaintextOverride: env.ALLOW_PLAINTEXT_ENV_SECRETS,
    };
  } catch {
    return undefined;
  }
}

async function readMcpJsonCredentialEnvStrict(mcpJsonPath: string): Promise<CredentialEnv> {
  const raw = await fs.readFile(mcpJsonPath, 'utf8');
  const config = JSON.parse(raw) as McpJsonConfig;
  const env = config.mcpServers?.eclass?.env;
  return {
    username: env?.ECLASS_USERNAME?.trim() || undefined,
    password: env?.ECLASS_PASSWORD,
    plaintextOverride: env?.ALLOW_PLAINTEXT_ENV_SECRETS,
  };
}

/** Root-first credential lookup with a read-only fallback to the matching
 * historical parent config. A malformed root config is surfaced to the caller
 * and is never bypassed with legacy data. */
export async function readProjectMcpJsonCredentialEnv(
  projectRoot: string,
  explicitPath?: string,
): Promise<CredentialEnv | undefined> {
  if (explicitPath) {
    try {
      return await readMcpJsonCredentialEnvStrict(explicitPath);
    } catch (err) {
      if (isErrnoException(err, 'ENOENT')) return undefined;
      throw err;
    }
  }

  const rootPath = defaultMcpJsonPath(projectRoot);
  try {
    return await readMcpJsonCredentialEnvStrict(rootPath);
  } catch (err) {
    if (!isErrnoException(err, 'ENOENT')) throw err;
  }

  const legacyPath = legacyMcpJsonPath(projectRoot);
  try {
    const raw = await fs.readFile(legacyPath, 'utf8');
    const config = JSON.parse(raw) as McpJsonConfig;
    if (!eclassEntryTargetsProject(config.mcpServers?.eclass, projectRoot, legacyPath)) {
      return undefined;
    }
    const env = config.mcpServers?.eclass?.env;
    return {
      username: env?.ECLASS_USERNAME?.trim() || undefined,
      password: env?.ECLASS_PASSWORD,
      plaintextOverride: env?.ALLOW_PLAINTEXT_ENV_SECRETS,
    };
  } catch (err) {
    if (isErrnoException(err, 'ENOENT')) return undefined;
    throw err;
  }
}
