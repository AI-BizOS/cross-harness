// `cross-harness gui`: a local web UI over the same engine client as the terminal UI.
// Only this machine can reach it (127.0.0.1), every API call needs the random
// token the browser gets in the URL fragment, and requests from other origins or
// with an unexpected Host header (DNS rebinding) are refused.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { METHODS, VERSION } from '../engine/engine.js';
import { CODES, fail } from '../protocol/errors.js';
import { openUrl } from '../util/open.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');
const MAX_BODY = 1024 * 1024;
const HEARTBEAT_MS = 15_000;
const LOOPBACK = ['127.0.0.1', '::1', 'localhost'];

const STATIC = {
  '/': { file: path.join(HERE, 'public', 'index.html'), type: 'text/html; charset=utf-8', template: true },
  '/index.html': { file: path.join(HERE, 'public', 'index.html'), type: 'text/html; charset=utf-8', template: true },
  '/app.js': { file: path.join(HERE, 'public', 'app.js'), type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: path.join(HERE, 'public', 'style.css'), type: 'text/css; charset=utf-8' },
  '/i18n.js': { file: path.join(SRC, 'i18n', 'strings.js'), type: 'text/javascript; charset=utf-8' },
  '/store.js': { file: path.join(SRC, 'tui', 'store.js'), type: 'text/javascript; charset=utf-8' },
  '/favicon.svg': { file: path.join(HERE, 'public', 'favicon.svg'), type: 'image/svg+xml' },
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function errorBody(error) {
  return { ok: false, error: { code: error.code || 'CROSS_HARNESS_INTERNAL', message: String(error.message || error) } };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      // The rest is read and dropped rather than cut off, so the 413 reply still arrives.
      if (size <= MAX_BODY) chunks.push(chunk);
      else reject(Object.assign(new Error('Request body too large'), { status: 413 }));
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * The request handler, separate from the socket so it can be tested in-process.
 * @param {{client:{call:Function, subscribe:Function}, token:string, lang:string, port:()=>number, star?:object|null}} options
 *   `star` is the GitHub star prompt (src/star.js), local to this machine like the page.
 */
export function createGuiHandler({ client, token, lang = 'en', port, star = null, update = null }) {
  const tokenBuffer = Buffer.from(token);
  const authorized = (req) => {
    const header = String(req.headers.authorization || '');
    const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
    return given.length === tokenBuffer.length && timingSafeEqual(given, tokenBuffer);
  };
  const names = () => {
    const p = port();
    return [`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`];
  };
  const hostAllowed = (req) => names().includes(String(req.headers.host || '').toLowerCase());
  const originAllowed = (req) => {
    const origin = req.headers.origin;
    if (!origin) return true;
    return names().some((name) => String(origin).toLowerCase() === `http://${name}`);
  };

  async function events(req, res) {
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const buffered = [];
    let live = false;
    const write = (event) => {
      try {
        res.write(`id: ${event.seq || 0}\ndata: ${JSON.stringify(event)}\n\n`);
      } catch {
        /* The browser went away; close cleans up. */
      }
    };
    // Subscribe before taking the snapshot so nothing falls between the two.
    const unsubscribe = client.subscribe((event) => (live ? write(event) : buffered.push(event)));
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* closed */
      }
    }, HEARTBEAT_MS);
    heartbeat.unref?.();
    const stop = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on('close', stop);
    res.on?.('close', stop);
    try {
      const snapshot = await client.call('snapshot');
      res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
      for (const event of buffered) if (!event.seq || event.seq > snapshot.seq) write(event);
      live = true;
    } catch (error) {
      res.write(`event: failure\ndata: ${JSON.stringify(errorBody(error))}\n\n`);
      stop();
      res.end();
    }
  }

  return async function handle(req, res) {
    try {
      if (!hostAllowed(req)) return send(res, 421, errorBody({ code: 'CROSS_HARNESS_UNAUTHORIZED', message: 'Unexpected Host header' }));
      if (!originAllowed(req)) return send(res, 403, errorBody({ code: 'CROSS_HARNESS_UNAUTHORIZED', message: 'Cross-origin requests are refused' }));
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && STATIC[url.pathname]) {
        const entry = STATIC[url.pathname];
        let body = fs.readFileSync(entry.file);
        if (entry.template) body = body.toString('utf8').replaceAll('{{LANG}}', lang === 'zh' ? 'zh' : 'en').replaceAll('{{VERSION}}', VERSION);
        return send(res, 200, body, entry.type);
      }
      if (!url.pathname.startsWith('/api/')) return send(res, 404, errorBody({ code: 'CROSS_HARNESS_NOT_FOUND', message: 'Not found' }));
      if (!authorized(req)) return send(res, 401, errorBody({ code: 'CROSS_HARNESS_UNAUTHORIZED', message: 'Open cross-harness from the link it printed (the token is in the address)' }));
      if (req.method === 'GET' && url.pathname === '/api/events') return events(req, res);
      // The star prompt lives with this server, not with the engine, which may be remote.
      if (req.method === 'GET' && url.pathname === '/api/star') {
        const moment = url.searchParams.get('moment') === 'merged' ? 'merged' : 'launch';
        let due = false;
        try {
          due = Boolean(star?.due(moment));
        } catch {
          /* An unreadable prompt file never gets in the way. */
        }
        return send(res, 200, { ok: true, result: { due, url: star?.url || null } });
      }
      if (req.method === 'GET' && url.pathname === '/api/update') {
        // The server checks at most once a day (src/update.js); the page only shows the result.
        return send(res, 200, { ok: true, result: (await update?.check()) || null });
      }
      if (req.method === 'POST' && url.pathname === '/api/star') {
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, errorBody({ code: 'CROSS_HARNESS_ARGUMENT_INVALID', message: 'Send JSON' }));
        let body;
        try {
          body = JSON.parse(await readBody(req));
          if (!star) throw new Error('The star prompt is off');
          star.answer(body?.answer);
        } catch (error) {
          return send(res, 400, errorBody({ code: 'CROSS_HARNESS_ARGUMENT_INVALID', message: error.message }));
        }
        return send(res, 200, { ok: true, result: { answer: body.answer } });
      }
      if (req.method === 'POST' && url.pathname === '/api/call') {
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, errorBody({ code: 'CROSS_HARNESS_ARGUMENT_INVALID', message: 'Send JSON' }));
        let request;
        try {
          request = JSON.parse(await readBody(req));
        } catch (error) {
          return send(res, error.status || 400, errorBody({ code: 'CROSS_HARNESS_ARGUMENT_INVALID', message: error.status ? error.message : 'Invalid JSON' }));
        }
        if (!request || typeof request.method !== 'string' || !METHODS.includes(request.method)) {
          return send(res, 400, errorBody({ code: 'CROSS_HARNESS_METHOD_UNKNOWN', message: `Unknown method: ${request?.method}` }));
        }
        try {
          const result = await client.call(request.method, request.params && typeof request.params === 'object' ? request.params : {});
          return send(res, 200, { ok: true, result: result === undefined ? null : result });
        } catch (error) {
          return send(res, 200, errorBody(error));
        }
      }
      return send(res, 404, errorBody({ code: 'CROSS_HARNESS_NOT_FOUND', message: 'Not found' }));
    } catch (error) {
      if (!res.headersSent) send(res, 500, errorBody(error));
      else res.end?.();
    }
  };
}

/** Starts the GUI server on a loopback address and resolves once it listens. */
export async function startGui({ client, port = 0, host = '127.0.0.1', lang = 'en', token = randomBytes(24).toString('hex'), star = null, update = null }) {
  // The token travels in plain HTTP, so the server must not be reachable from other machines.
  if (!LOOPBACK.includes(host)) throw fail(CODES.ARGUMENT_INVALID, `cross-harness gui only listens on this machine (${LOOPBACK.join(', ')}), not ${host}`);
  let actualPort = port;
  const handler = createGuiHandler({ client, token, lang, port: () => actualPort, star, update });
  try {
    star?.opened();
  } catch {
    /* Counting launches is best effort. */
  }
  const server = http.createServer((req, res) => void handler(req, res));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  actualPort = server.address().port;
  const base = `http://${host.includes(':') ? `[${host}]` : host}:${actualPort}/`;
  const url = `${base}#token=${token}`;
  return {
    url,
    port: actualPort,
    token,
    server,
    openBrowser: () => openUrl(url),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
