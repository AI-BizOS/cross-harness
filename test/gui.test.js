import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { createGuiHandler, startGui } from '../src/gui/server.js';
import { Engine } from '../src/engine/engine.js';
import { localClient } from '../src/engine/rpc.js';
import { gitEnv, gitRepo, mockProviders, tempDir, until } from './helpers.js';

const PORT = 4321;
const TOKEN = 'a'.repeat(48);

/** Calls the handler like node:http would, collecting the response. */
function request(handler, { method = 'GET', url = '/', headers = {}, body = null, keepOpen = 0 }) {
  return new Promise((resolve) => {
    const req = Readable.from(body === null ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
    Object.assign(req, { method, url, headers: { host: `127.0.0.1:${PORT}`, ...headers } });
    const chunks = [];
    const res = new FakeResponse(chunks, () => finish());
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      const text = chunks.join('');
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* not JSON */
      }
      resolve({ status: res.status, headers: res.head || {}, text, json, req });
    };
    void handler(req, res);
    if (keepOpen) {
      setTimeout(() => {
        req.emit('close');
        finish();
      }, keepOpen);
    }
  });
}

class FakeResponse extends EventEmitter {
  constructor(chunks, onEnd) {
    super();
    this.chunks = chunks;
    this.onEnd = onEnd;
    this.headersSent = false;
  }
  writeHead(status, head) {
    this.status = status;
    this.head = head;
    this.headersSent = true;
  }
  write(chunk) {
    this.chunks.push(String(chunk));
    return true;
  }
  end(chunk) {
    if (chunk) this.chunks.push(String(chunk));
    this.onEnd();
  }
}

async function setup(t) {
  const home = tempDir(t, 'troupe-home-');
  fs.mkdirSync(path.join(home, 'mock'));
  const repo = gitRepo(t);
  const env = { ...gitEnv(), TROUPE_HOME: home, MOCK_STATE: path.join(home, 'mock') };
  const engine = await new Engine({
    root: repo.dir,
    env,
    builtins: false,
    providers: mockProviders(),
    config: { providers: {}, defaults: { mode: 'workspace', isolation: 'worktree', maxPerProvider: 3, idleMinutes: 15, gateTimeoutSec: 60, maxIterations: 5 }, lang: null },
  }).open();
  t.after(() => engine.close());
  const handler = createGuiHandler({ client: localClient(engine), token: TOKEN, lang: 'zh', port: () => PORT });
  return { engine, handler, repo };
}

const auth = { authorization: `Bearer ${TOKEN}` };

test('gui: static files carry strict headers; the API needs the token', async (t) => {
  const { handler } = await setup(t);
  const page = await request(handler, { url: '/' });
  assert.equal(page.status, 200);
  assert.match(page.text, /<html lang="zh" data-lang="zh"/);
  assert.match(page.headers['Content-Security-Policy'], /default-src 'none'; script-src 'self'/);
  assert.equal(page.headers['X-Content-Type-Options'], 'nosniff');
  for (const file of ['/app.js', '/style.css', '/store.js', '/i18n.js', '/favicon.svg']) assert.equal((await request(handler, { url: file })).status, 200, file);
  assert.equal((await request(handler, { url: '/../package.json' })).status, 404);
  assert.equal((await request(handler, { url: '/api/call', method: 'POST', body: { method: 'snapshot' }, headers: { 'content-type': 'application/json' } })).status, 401);
  assert.equal((await request(handler, { url: '/api/call', method: 'POST', body: { method: 'snapshot' }, headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' } })).status, 401);
});

test('gui: DNS rebinding and cross-origin requests are refused', async (t) => {
  const { handler } = await setup(t);
  assert.equal((await request(handler, { url: '/', headers: { host: 'evil.example:4321' } })).status, 421);
  assert.equal((await request(handler, { url: '/', headers: { host: `localhost:${PORT}` } })).status, 200);
  const cross = await request(handler, { url: '/api/call', method: 'POST', body: { method: 'snapshot' }, headers: { ...auth, 'content-type': 'application/json', origin: 'https://evil.example' } });
  assert.equal(cross.status, 403);
  const same = await request(handler, { url: '/api/call', method: 'POST', body: { method: 'snapshot' }, headers: { ...auth, 'content-type': 'application/json', origin: `http://127.0.0.1:${PORT}` } });
  assert.equal(same.status, 200);
  assert.equal(same.json.ok, true);
  assert.equal(same.json.result.protocol, 'troupe/1');
});

test('gui: calls are whitelisted and errors keep their codes', async (t) => {
  const { handler } = await setup(t);
  const call = (body) => request(handler, { url: '/api/call', method: 'POST', body, headers: { ...auth, 'content-type': 'application/json' } });
  assert.equal((await call({ method: 'close' })).status, 400, 'engine methods outside the RPC list are refused');
  assert.equal((await call({ method: 'constructor' })).json.error.code, 'TROUPE_METHOD_UNKNOWN');
  const missing = await call({ method: 'stop', params: { agent: 'nobody' } });
  assert.equal(missing.json.ok, false);
  assert.equal(missing.json.error.code, 'TROUPE_AGENT_NOT_FOUND');
  assert.equal((await request(handler, { url: '/api/call', method: 'POST', body: 'not json', headers: { ...auth, 'content-type': 'application/json' } })).status, 400);
  assert.equal((await request(handler, { url: '/api/call', method: 'POST', body: '{}', headers: { ...auth, 'content-type': 'text/plain' } })).status, 415);
  const huge = await request(handler, { url: '/api/call', method: 'POST', body: 'x'.repeat(1024 * 1024 + 1), headers: { ...auth, 'content-type': 'application/json' } });
  assert.equal(huge.status, 413);
  // Only loopback addresses: the token travels in plain HTTP.
  await assert.rejects(startGui({ client: null, host: '0.0.0.0' }), (error) => error.code === 'TROUPE_ARGUMENT_INVALID');
});

test('gui: the event stream starts with a snapshot and follows the engine', async (t) => {
  const { engine, handler } = await setup(t);
  const stream = request(handler, { url: '/api/events', headers: auth, keepOpen: 2500 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await engine.call('send', { text: '@mock-acp hello gui' });
  const result = await stream;
  assert.equal(result.status, 200);
  assert.match(result.headers['Content-Type'], /text\/event-stream/);
  const blocks = result.text.split('\n\n').filter(Boolean);
  assert.match(blocks[0], /^event: snapshot\ndata: \{/);
  const events = blocks.slice(1).filter((b) => b.startsWith('id: ')).map((b) => JSON.parse(b.split('\ndata: ')[1]));
  assert.ok(events.some((e) => e.type === 'agent.updated'));
  assert.ok(events.some((e) => e.type === 'agent.message' && /answered: hello gui/.test(e.entry.text)));
});

// ── the real page in headless Chrome ─────────────────────────────────────

// Troupe does not depend on Playwright. To run this test, point TROUPE_PLAYWRIGHT at a
// Playwright package's index.js; TROUPE_CHROME picks the browser binary (default:
// Playwright's own Chromium) and TROUPE_SCREENSHOTS a directory for screenshots.
const PLAYWRIGHT = process.env.TROUPE_PLAYWRIGHT || null;
const CHROME = process.env.TROUPE_CHROME || null;
const SHOTS = process.env.TROUPE_SCREENSHOTS || null;

test('gui: the page works end to end in a browser', { skip: !PLAYWRIGHT || !fs.existsSync(PLAYWRIGHT) ? 'set TROUPE_PLAYWRIGHT to run it' : false, timeout: 120_000 }, async (t) => {
  const { engine, handler, repo } = await setup(t);
  const { chromium } = (await import(pathToFileURL(PLAYWRIGHT).href)).default;
  const browser = await chromium.launch({ ...(CHROME ? { executablePath: CHROME } : {}), headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader'] });
  t.after(() => browser.close());
  const log = [];
  engine.subscribe((event) => log.push(event));
  let delivered = 0;
  const origin = `http://127.0.0.1:${PORT}`;

  async function contextFor(options) {
    const context = await browser.newContext(options);
    await context.route(`${origin}/**`, async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (url.pathname === '/api/events') {
        // route.fulfill cannot stream: answer each long poll with what happened meanwhile.
        await new Promise((resolve) => setTimeout(resolve, 700));
        const snapshot = engine.snapshot();
        const gap = log.filter((e) => e.seq > delivered && e.seq <= snapshot.seq);
        delivered = Math.max(delivered, snapshot.seq);
        const body = gap.map((e) => `id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`).join('') + `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
        return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body });
      }
      const result = await request(handler, { method: req.method(), url: url.pathname + url.search, headers: { ...req.headers(), host: `127.0.0.1:${PORT}` }, body: req.postData() });
      return route.fulfill({ status: result.status, headers: result.headers, body: result.text });
    });
    return context;
  }

  const context = await contextFor({ viewport: { width: 1280, height: 820 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  await page.goto(`${origin}/#token=${TOKEN}`);
  await page.waitForSelector('.welcome');
  assert.equal(new URL(page.url()).hash, '', 'the token leaves the address bar');
  // Send a task that edits a file; the answer streams into the transcript.
  await page.fill('#input', '@mock-acp write it [edit:gui.txt=from the browser]');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#entries')?.textContent.includes('mock-acp answered: write it'), null, { timeout: 30_000 });
  assert.ok(await page.isVisible('text=@mock-acp'));
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'gui-desktop-light.png') });
  // An approval arrives as a card with buttons.
  await engine.call('setMode', { agent: 'mock-acp', mode: 'ask' });
  await engine.call('send', { text: '@mock-acp check it [approve]' });
  await page.waitForSelector('.card.attention', { timeout: 30_000 });
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'gui-approval.png') });
  await page.click('.card.attention button.primary');
  await page.waitForFunction(() => document.querySelector('#entries')?.textContent.includes('npm test allow-once'), null, { timeout: 30_000 });
  // Review and merge from the merge dialog.
  await page.click('#agent-head button:has-text("合并")');
  await page.waitForSelector('dialog[open] .patch');
  await page.click('dialog[open] button:has-text("直接合并，不审查")');
  await until(() => fs.existsSync(path.join(repo.dir, 'gui.txt')), { label: 'merged through the GUI', timeoutMs: 30_000 });
  // Goals dialog: create one from JSON.
  await page.click('.topbar button:has-text("目标")');
  await page.waitForSelector('dialog[open] .goal-list');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'gui-goals.png') });
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);

  // Narrow phone width, dark theme.
  const phone = await contextFor({ viewport: { width: 360, height: 740 }, colorScheme: 'dark', deviceScaleFactor: 2 });
  const small = await phone.newPage();
  await small.goto(`${origin}/#token=${TOKEN}`);
  await small.waitForFunction(() => document.querySelector('#entries')?.textContent.includes('answered'), null, { timeout: 30_000 });
  const overflow = await small.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, `no horizontal scroll at 360px (overflow ${overflow})`);
  if (SHOTS) await small.screenshot({ path: path.join(SHOTS, 'gui-phone-dark.png') });
});
