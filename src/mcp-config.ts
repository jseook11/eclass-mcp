import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import YAML from 'yaml';

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
  await fs.mkdir(path.dirname(hermesConfigPath), { recursive: true });
  await fs.writeFile(hermesConfigPath, YAML.stringify(config), 'utf-8');
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
  env.ECLASS_USERNAME = options.username;
  delete env.ECLASS_PASSWORD;
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
