import { createServer as createNodeServer } from 'node:http';
import type { IncomingMessage, Server as NodeHttpServer, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

import { sanitizeDebug } from './errors.js';

const MCP_PATH = '/mcp';

export type HttpServerOptions = {
  port: number;
  createServer: () => Server;
  authToken?: string;
  allowedOrigins?: string;
};

function parseAllowedOrigins(raw: string | undefined): Set<string> | null {
  const values = raw?.split(',').map((value) => value.trim()).filter(Boolean) ?? [];
  return values.length > 0 ? new Set(values) : null;
}

function originForRequest(req: IncomingMessage, allowedOrigins: Set<string> | null): string | null {
  const origin = req.headers.origin;
  if (!origin) return null;
  if (!allowedOrigins) return null;
  return allowedOrigins.has(origin) ? origin : null;
}

function writeCorsHeaders(
  req: IncomingMessage,
  res: ServerResponse,
  allowedOrigins: Set<string> | null,
): boolean {
  const origin = originForRequest(req, allowedOrigins);
  if (!origin && req.headers.origin) return false;
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, x-eclass-auth, content-type, mcp-session-id');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  return true;
}

function timingSafeEqualStr(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  const actualBuffer = Buffer.from(actual, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function hasValidRemoteAuth(req: IncomingMessage, expected: string | undefined): boolean {
  if (!expected) return true;
  const auth = req.headers.authorization;
  const bearerToken = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined;
  const rawXAuth = req.headers['x-eclass-auth'];
  const xAuthToken = Array.isArray(rawXAuth) ? rawXAuth[0] : rawXAuth;
  return timingSafeEqualStr(bearerToken, expected) || timingSafeEqualStr(xAuthToken, expected);
}

function writeJsonRpcError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    jsonrpc: '2.0',
    error: { code: -32000, message },
    id: null,
  }));
}

export async function startHttpServer(options: HttpServerOptions): Promise<NodeHttpServer> {
  const allowedOrigins = parseAllowedOrigins(options.allowedOrigins);
  const httpServer = createNodeServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('eclass-mcp remote MCP server');
      return;
    }

    if (url.pathname !== MCP_PATH) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    if (!writeCorsHeaders(req, res, allowedOrigins)) {
      writeJsonRpcError(res, 403, 'Origin not allowed');
      return;
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (!hasValidRemoteAuth(req, options.authToken)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      writeJsonRpcError(res, 401, 'Unauthorized');
      return;
    }

    if (!['POST', 'GET', 'DELETE'].includes(req.method ?? '')) {
      writeJsonRpcError(res, 405, 'Method not allowed');
      return;
    }

    const server = options.createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on('close', () => {
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[eclass-mcp] HTTP MCP error: ${sanitizeDebug(message)}\n`);
      if (!res.headersSent) {
        writeJsonRpcError(res, 500, 'Internal server error');
      }
    }
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(options.port, '127.0.0.1', resolve);
  });

  const address = httpServer.address();
  const boundPort = address && typeof address === 'object' ? address.port : options.port;
  const authMode = options.authToken ? 'bearer auth enabled' : 'no bearer auth';
  process.stderr.write(`[eclass-mcp] Server running on http://127.0.0.1:${boundPort}${MCP_PATH} (${authMode})\n`);
  if (!options.authToken) {
    process.stderr.write('[eclass-mcp] WARNING: ECLASS_REMOTE_AUTH_TOKEN is not set. Do not expose this server publicly without a tunnel/access control.\n');
  }
  return httpServer;
}
