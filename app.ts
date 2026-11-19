// app.ts — the forge server: node:http, in-memory store, routes for /healthz,
// /api/v3 (REST), /api/graphql, /mcp, and /{owner}/{repo}.git (smart HTTP).
// Auth: Authorization: Bearer $MAKEFUN_SHOP_TOKEN; when the env var is unset, any
// non-empty Bearer token is accepted (local-dev fallback). /healthz is exempt.
//
// Exported as createApp() for main.ts, which binds the ephemeral port and runs the
// env lifecycle (register, poll /done, exit 0).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleUploadPack, handleReceivePack } from './gitproto.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const login = process.env.MAKEFUN_FORGE_LOGIN ?? 'adaiversen';

function isAuthorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer\s+(\S+)$/.exec(header);
  if (match === null) return false;
  if (token === '') return true;
  return match[1] === token;
}

function send(res: ServerResponse, status: number, contentType: string, body: Buffer | string, requestId: string, extraHeaders: Record<string, string> = {}): void {
  const headers: Record<string, string> = {
    'content-type': contentType,
    'x-github-request-id': requestId,
    ...extraHeaders,
  };
  const payload = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  headers['content-length'] = String(payload.length);
  res.writeHead(status, headers);
  res.end(payload);
}

function sendJson(res: ServerResponse, status: number, body: unknown, requestId: string, extraHeaders: Record<string, string> = {}): void {
  if (body === null) {
    res.writeHead(status, { 'x-github-request-id': requestId, ...extraHeaders });
    res.end();
    return;
  }
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(body), requestId, extraHeaders);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) reject(new Error('request body too large'));
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const forge = new Forge(login);
  let requestCounter = 0;

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const requestId = `req-${++requestCounter}`;
    let method = 'GET';
    let path = '/';
    void (async () => {
      try {
        method = (req.method ?? 'GET').toUpperCase();
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
        path = url.pathname;
        const origin = url.origin;
        const segments = url.pathname.split('/').filter((part) => part !== '').map(decodeSegment);

        if (url.pathname === '/healthz') {
          sendJson(res, 200, { ok: true }, requestId);
          return;
        }

        const body = await readBody(req);

        // ---- REST v3 ---------------------------------------------------------
        if (segments[0] === 'api' && segments[1] === 'v3') {
          if (!isAuthorized(req)) {
            sendJson(res, 401, { message: 'Requires authentication' }, requestId);
            return;
          }
          let parsed: unknown;
          let bodyPresent = false;
          if (body.length > 0) {
            bodyPresent = true;
            try {
              parsed = JSON.parse(body.toString('utf8'));
            } catch {
              sendJson(res, 400, { message: 'Problems parsing JSON' }, requestId);
              return;
            }
          }
          const result = handleRest(forge, {
            method,
            segments: segments.slice(2),
            query: url.searchParams,
            body: parsed,
            bodyPresent,
            origin,
          });
          sendJson(res, result.status, result.body, requestId, result.headers);
          return;
        }

        // ---- GraphQL ---------------------------------------------------------
        if (segments[0] === 'api' && segments[1] === 'graphql') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' }, requestId);
            return;
          }
          if (!isAuthorized(req)) {
            sendJson(res, 401, { message: 'Requires authentication' }, requestId);
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            sendJson(res, 400, { message: 'Problems parsing JSON' }, requestId);
            return;
          }
          const result = handleGraphQL(forge, parsed);
          sendJson(res, result.status, result.body, requestId);
          return;
        }

        // ---- MCP -------------------------------------------------------------
        if (segments[0] === 'mcp' && segments.length === 1) {
          if (method === 'DELETE') {
            res.writeHead(405, { 'x-github-request-id': requestId });
            res.end();
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' }, requestId);
            return;
          }
          if (!isAuthorized(req)) {
            sendJson(res, 401, { message: 'Requires authentication' }, requestId);
            return;
          }
          const result = handleMcp(forge, body);
          sendJson(res, result.status, result.body, requestId, result.headers);
          return;
        }

        // ---- git smart HTTP --------------------------------------------------
        if (segments.length >= 3 && segments[1].endsWith('.git')) {
          const owner = segments[0];
          const repoName = segments[1].slice(0, -'.git'.length);
          if (!isAuthorized(req)) {
            sendJson(res, 401, { message: 'Requires authentication' }, requestId);
            return;
          }
          const gitProtocolVersion2 = (req.headers['git-protocol'] ?? '') === 'version=2';
          if (segments[2] === 'info' && segments[3] === 'refs' && method === 'GET') {
            const service = url.searchParams.get('service') ?? '';
            const result = handleInfoRefs(forge, owner, repoName, service, gitProtocolVersion2);
            send(res, result.status, result.contentType, result.body, requestId);
            return;
          }
          if (segments[2] === 'git-upload-pack' && method === 'POST') {
            const result = handleUploadPack(forge, owner, repoName, body, gitProtocolVersion2);
            send(res, result.status, result.contentType, result.body, requestId);
            return;
          }
          if (segments[2] === 'git-receive-pack' && method === 'POST') {
            const result = handleReceivePack(forge, owner, repoName, body);
            send(res, result.status, result.contentType, result.body, requestId);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' }, requestId);
          return;
        }

        sendJson(res, 404, { message: 'Not Found' }, requestId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof Error && err.stack) process.stderr.write(`[forge] 500 ${method} ${path}: ${err.stack}\n`);
        if (!res.headersSent) {
          sendJson(res, 500, { message: `Internal Server Error: ${message}` }, requestId);
        } else {
          res.destroy();
        }
      }
    })();
  });
}
