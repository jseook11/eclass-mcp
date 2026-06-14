import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { BrowserSession } from './browser-session.js';
import { ExamCache } from './exam-cache.js';
import { FileCache } from './file-cache.js';
import { sanitizeDebug } from './errors.js';
import { getEclassPassword, getSecretEnvWarning } from './secrets.js';
import { createEclassServer } from './server.js';
import { startHttpServer } from './http.js';

type CliOptions = {
  transport: 'stdio' | 'http';
  port: number;
};

function parseCli(argv: string[]): CliOptions {
  const envTransport = process.env.ECLASS_TRANSPORT === 'http' ? 'http' : 'stdio';
  const envPort = Number(process.env.ECLASS_HTTP_PORT ?? process.env.PORT ?? '8787');
  const options: CliOptions = {
    transport: envTransport,
    port: Number.isFinite(envPort) && envPort > 0 ? envPort : 8787,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--http':
        options.transport = 'http';
        break;
      case '--stdio':
        options.transport = 'stdio';
        break;
      case '--port': {
        const raw = argv[++index];
        const port = Number(raw);
        if (!raw || !Number.isInteger(port) || port <= 0 || port > 65535) {
          throw new Error('--port must be an integer from 1 to 65535');
        }
        options.port = port;
        break;
      }
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function installProcessSafetyNet(): void {
  process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    process.stderr.write(`[eclass-mcp] Unhandled rejection: ${sanitizeDebug(message)}\n`);
  });
  process.on('uncaughtException', (err) => {
    process.stderr.write(`[eclass-mcp] Uncaught exception: ${sanitizeDebug(err.message)}\n`);
  });
}

function createRuntimeContext(username: string): {
  session: BrowserSession;
  fileCache: FileCache;
  examCache: ExamCache;
} {
  const credentialFactory = (): Promise<string> => getEclassPassword(username);
  return {
    session: new BrowserSession(username, credentialFactory),
    fileCache: new FileCache(),
    examCache: new ExamCache(),
  };
}

async function startStdio(username: string): Promise<void> {
  const context = createRuntimeContext(username);
  const server = createEclassServer({ username, ...context });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[eclass-mcp] Server running on stdio\n');
}

async function main(): Promise<void> {
  installProcessSafetyNet();
  const options = parseCli(process.argv.slice(2));

  const username = process.env.ECLASS_USERNAME;
  if (!username) {
    process.stderr.write(
      '[eclass-mcp] ERROR: ECLASS_USERNAME이 설정되지 않았습니다.\n' +
      '  eclass MCP 설정을 위해 다음을 실행하세요:\n' +
      '  pnpm run setup\n',
    );
    process.exit(1);
  }

  if (process.env.ECLASS_PASSWORD) {
    process.stderr.write(getSecretEnvWarning('ECLASS_PASSWORD', '비밀번호') ?? '');
  }

  if (options.transport === 'http') {
    const context = createRuntimeContext(username);
    await startHttpServer({
      port: options.port,
      createServer: () => createEclassServer({ username, ...context }),
      authToken: process.env.ECLASS_REMOTE_AUTH_TOKEN,
      allowedOrigins: process.env.ECLASS_HTTP_ALLOWED_ORIGINS,
    });
    return;
  }

  await startStdio(username);
}

await main();
