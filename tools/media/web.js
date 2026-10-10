// Records cross-harness's real web UI. The page is served by the real request handler
// (createGuiHandler) inside this process: Playwright routes the page's requests to
// it and streams /api/events into the page, so no port is opened. A person's pointer
// and keys drive the page; after every step the page is captured in the light and
// the dark theme (web-capture.js).
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createGuiHandler } from '../../src/gui/server.js';
import { captureScene } from './web-capture.js';

const PORT = 7788;
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The page reads /api/events as a stream; route.fulfill cannot stream, so the page's
// fetch for it returns a stream this process writes into.
const STREAM_EVENTS = () => {
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.endsWith('/api/events')) return realFetch(input, init);
    const encoder = new TextEncoder();
    let controller;
    const body = new ReadableStream({ start: (c) => (controller = c) });
    window.__crossHarnessEvent = (text) => controller.enqueue(encoder.encode(text));
    const authorization = init?.headers?.Authorization || '';
    return window.__crossHarnessOpenEvents(authorization).then(() => new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
  };
};

// Message times are shown in the page; record them in a time zone where it is day.
function daytimeZone(lang) {
  const zones = lang === 'zh' ? ['Asia/Shanghai', 'Europe/Berlin', 'America/New_York'] : ['America/New_York', 'Europe/London', 'America/Los_Angeles', 'Asia/Shanghai'];
  const hour = (zone) => Number(new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
  return zones.find((zone) => hour(zone) >= 9 && hour(zone) <= 18) || zones[0];
}

function exchange(handler, { method, url, headers, body, onWrite }) {
  return new Promise((resolve) => {
    const req = Object.assign(new EventEmitter(), { method, url, headers });
    const chunks = [];
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200,
      headersSent: false,
      writeHead(status, head) {
        this.statusCode = status;
        this.head = head;
        this.headersSent = true;
        return this;
      },
      write(chunk) {
        if (onWrite) onWrite(String(chunk));
        else chunks.push(Buffer.from(chunk));
        return true;
      },
      end(chunk) {
        if (chunk) chunks.push(Buffer.from(chunk));
        resolve({ status: this.statusCode, headers: this.head || {}, body: Buffer.concat(chunks) });
      },
    });
    void handler(req, res);
    setImmediate(() => {
      if (body) req.emit('data', Buffer.from(body));
      req.emit('end');
    });
    if (onWrite) resolve(null);
  });
}

/**
 * Opens the web UI on `client` in Chrome and returns controls for a scripted session.
 * `playwright` is the path of a Playwright installation's index.js.
 */
export async function recordWeb({ client, lang = 'en', playwright, chrome = null, width = 1080, height = 660 }) {
  const { chromium } = (await import(pathToFileURL(playwright).href)).default;
  const browser = await chromium.launch(chrome ? { executablePath: chrome } : { channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, bypassCSP: true, colorScheme: 'light', locale: lang === 'zh' ? 'zh-CN' : 'en-US', timezoneId: daytimeZone(lang) });
  const page = await context.newPage();
  const token = randomBytes(16).toString('hex');
  const handler = createGuiHandler({ client, token, lang, port: () => PORT });
  const origin = `http://127.0.0.1:${PORT}`;

  await page.addInitScript(STREAM_EVENTS);
  let events = Promise.resolve();
  await page.exposeFunction('__crossHarnessOpenEvents', (authorization) => {
    void exchange(handler, {
      method: 'GET',
      url: '/api/events',
      headers: { host: `127.0.0.1:${PORT}`, authorization },
      onWrite: (text) => {
        events = events.then(() => page.evaluate((chunk) => window.__crossHarnessEvent(chunk), text)).catch(() => {});
      },
    });
  });
  await page.route(`${origin}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const reply = await exchange(handler, {
      method: request.method(),
      url: url.pathname + url.search,
      headers: { ...(await request.allHeaders()), host: `127.0.0.1:${PORT}` },
      body: request.postData(),
    });
    await route.fulfill({ status: reply.status, headers: reply.headers, body: reply.body });
  });

  const frames = [];
  const pointer = [{ t: 0, x: width * 0.62, y: height * 0.55 }];
  const clicks = [];
  const marks = [];
  let started = 0;
  const now = () => Date.now() - started;
  let at = { ...pointer[0] };

  // Both themes from the same moment: the page's own dark rules are switched on and
  // off around the second capture, inside one task, so nothing changes in between.
  const BOTH_THEMES = `(() => {
    const capture = ${captureScene.toString()};
    let dark = document.getElementById('cross-harness-media-dark');
    if (!dark) {
      let css = '';
      for (const sheet of document.styleSheets) {
        for (const rule of sheet.cssRules) {
          if (rule.media && /prefers-color-scheme:\\s*dark/.test(rule.media.mediaText)) for (const inner of rule.cssRules) css += inner.cssText;
        }
      }
      dark = document.createElement('style');
      dark.id = 'cross-harness-media-dark';
      dark.textContent = css;
      document.head.append(dark);
    }
    dark.disabled = true;
    const light = capture();
    dark.disabled = false;
    const night = capture();
    dark.disabled = true;
    return { light, dark: night };
  })()`;

  async function capture() {
    const t = now();
    frames.push({ t, ...(await page.evaluate(BOTH_THEMES)) });
  }

  // Captures keep running while the script waits, so streaming text is recorded too.
  let capturing = false;
  let loop = null;
  function startCapturing(intervalMs) {
    capturing = true;
    loop = (async () => {
      while (capturing) {
        await capture();
        await sleep(intervalMs);
      }
    })();
  }

  async function moveTo(selector, { ms = 650, dx = 0.5, dy = 0.5 } = {}) {
    const target = page.locator(selector).first();
    await target.waitFor({ state: 'visible' });
    const box = await target.boundingBox();
    const to = { x: box.x + box.width * dx, y: box.y + box.height * dy };
    const t = now();
    pointer.push({ t, x: at.x, y: at.y }, { t: t + ms, x: to.x, y: to.y });
    await page.mouse.move(to.x, to.y, { steps: Math.max(2, Math.round(ms / 40)) });
    await sleep(Math.max(0, t + ms - now()));
    at = to;
    return target;
  }

  async function click(selector, options) {
    await moveTo(selector, options);
    await sleep(180);
    clicks.push({ t: now(), x: at.x, y: at.y });
    await page.mouse.down();
    await sleep(70);
    await page.mouse.up();
  }

  return {
    page,
    frames,
    pointer,
    clicks,
    marks,
    mark: (name) => marks.push({ t: now(), name }),
    async open() {
      await page.goto(`${origin}/#token=${token}`);
      // The providers appear once the event stream has delivered the snapshot.
      await page.waitForSelector('.provider');
      started = Date.now();
      startCapturing(220);
    },
    moveTo,
    click,
    async type(text, { delay = 22 } = {}) {
      for (const [i, line] of text.split('\n').entries()) {
        if (i) await page.keyboard.press('Shift+Enter');
        await page.keyboard.type(line, { delay });
      }
    },
    async stop() {
      capturing = false;
      await loop;
      await capture();
      await browser.close();
      return now();
    },
  };
}
