// The engine side of the collaboration mailbox (spec/collaboration.md §Transport).
// Layout: <dir>/<token>/requests/<uuid>.json in, <dir>/<token>/responses/<uuid>.json out.
// An agent can write inside its own mailbox, so nothing there is trusted: links are
// removed instead of followed, requests are claimed by rename (each runs once even
// if two hubs share a directory) and must carry the mailbox's own token.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { CODES, fail } from '../protocol/errors.js';
import { LIMITS } from '../protocol/index.js';
import { ensureDir, readJson, writeJsonAtomic } from '../util/fsx.js';

const TOKEN = /^[0-9a-f]{64}$/;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const POLL_MS = 250;
const SWEEP_EVERY = 240;
const STALE_RESPONSE_MS = 600_000;

const sameToken = (value, token) => {
  if (typeof value !== 'string') return false;
  const a = Buffer.from(value);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
};

export class MailboxHub {
  /**
   * @param {{dir:string, tokensFile?:string, handle:(agentId:string, op:string, params:object)=>Promise<any>, pollMs?:number}} options
   *   `tokensFile` keeps the token registry out of `dir`, which agents can write.
   */
  constructor({ dir, tokensFile = path.join(dir, 'tokens.json'), handle, pollMs = POLL_MS }) {
    this.dir = ensureDir(dir);
    this.realDir = fs.realpathSync(this.dir);
    this.tokensPath = tokensFile;
    this.handle = handle;
    this.watchers = new Map();
    this.disposed = false;
    this.ticks = 0;
    const saved = readJson(this.tokensFile())?.tokens;
    this.tokens = new Map(Object.entries(saved && typeof saved === 'object' ? saved : {}).filter(([token, id]) => TOKEN.test(token) && typeof id === 'string'));
    for (const token of this.tokens.keys()) this.open(token);
    this.timer = setInterval(() => this.poll(), pollMs);
    this.timer.unref?.();
  }

  tokensFile() {
    return this.tokensPath;
  }

  save() {
    writeJsonAtomic(this.tokensFile(), { schema: 1, tokens: Object.fromEntries(this.tokens) });
  }

  /** Mailbox and token for an agent; stable across restarts. */
  register(agentId) {
    if (this.disposed) throw fail(CODES.CLOSED, 'The mailbox hub is closed');
    let token = [...this.tokens].find(([, id]) => id === agentId)?.[0];
    if (!token) {
      token = randomBytes(32).toString('hex');
      this.tokens.set(token, agentId);
      this.save();
    }
    return { dir: this.open(token), token };
  }

  /** Removes an agent's mailbox; tokens of agents that no longer exist are dropped too. */
  unregister(agentId) {
    let changed = false;
    for (const [token, id] of [...this.tokens]) {
      if (id !== agentId) continue;
      this.watchers.get(token)?.close();
      this.watchers.delete(token);
      this.tokens.delete(token);
      fs.rmSync(path.join(this.dir, token), { recursive: true, force: true });
      changed = true;
    }
    if (changed) this.save();
  }

  /** Drops mailboxes whose agents are gone. */
  retain(agentIds) {
    const keep = new Set(agentIds);
    for (const id of new Set(this.tokens.values())) if (!keep.has(id)) this.unregister(id);
    for (const name of fs.readdirSync(this.dir)) if (TOKEN.test(name) && !this.tokens.has(name)) fs.rmSync(path.join(this.dir, name), { recursive: true, force: true });
  }

  open(token) {
    const box = path.join(this.dir, token);
    for (const sub of ['requests', 'responses']) ensureDir(path.join(box, sub));
    fs.chmodSync(box, 0o700);
    if (!this.watchers.has(token)) {
      try {
        const watcher = fs.watch(path.join(box, 'requests'), { persistent: false }, () => this.scan(token));
        watcher.on('error', () => {
          watcher.close();
          if (this.watchers.get(token) === watcher) this.watchers.delete(token);
        });
        this.watchers.set(token, watcher);
      } catch {
        /* Some sandboxes refuse file events; the poll still serves this mailbox. */
      }
    }
    return box;
  }

  // requests/ and responses/ are used only while they are real directories at their path.
  inbox(token, sub) {
    const dir = path.join(this.dir, token, sub);
    try {
      const stat = fs.lstatSync(dir);
      if (stat.isDirectory() && fs.realpathSync(dir) === path.join(this.realDir, token, sub)) return dir;
      if (!stat.isDirectory()) fs.unlinkSync(dir);
    } catch {
      /* Missing: recreate below. */
    }
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
    } catch {
      /* Raced. */
    }
    return null;
  }

  poll() {
    for (const token of this.tokens.keys()) this.scan(token);
    if (++this.ticks % SWEEP_EVERY) return;
    // Responses nobody collected (the tool server exited) are swept after ten minutes.
    for (const token of this.tokens.keys()) {
      const dir = this.inbox(token, 'responses');
      if (!dir) continue;
      let names = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        try {
          const file = path.join(dir, name);
          if (Date.now() - fs.lstatSync(file).mtimeMs > STALE_RESPONSE_MS) fs.rmSync(file, { force: true });
        } catch {
          /* Collected meanwhile. */
        }
      }
    }
  }

  scan(token) {
    if (this.disposed || !this.tokens.has(token)) return;
    const requests = this.inbox(token, 'requests');
    if (!requests) return;
    let names;
    try {
      names = fs.readdirSync(requests);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith('.json') || !REQUEST_ID.test(name.slice(0, -5))) continue;
      const claimed = path.join(this.dir, token, `claimed-${randomUUID()}`);
      try {
        fs.renameSync(path.join(requests, name), claimed);
      } catch {
        continue;
      }
      let request = null;
      try {
        const stat = fs.lstatSync(claimed);
        if (stat.isFile() && stat.size <= LIMITS.mailboxRequestBytes) request = JSON.parse(fs.readFileSync(claimed, 'utf8'));
      } catch {
        /* Unreadable: dropped. */
      }
      fs.rmSync(claimed, { recursive: true, force: true });
      if (!request || typeof request !== 'object' || !sameToken(request.token, token) || typeof request.id !== 'string' || !REQUEST_ID.test(request.id)) continue;
      void this.serve(token, request);
    }
  }

  async serve(token, { id, op, params }) {
    let reply;
    try {
      const agentId = this.tokens.get(token);
      if (!agentId) throw fail(CODES.COLLAB_UNAVAILABLE, 'This mailbox was closed');
      const result = await this.handle(agentId, String(op), params && typeof params === 'object' && !Array.isArray(params) ? params : {});
      reply = { id, ok: true, result };
    } catch (cause) {
      reply = { id, ok: false, error: { code: cause.code || 'CROSS_HARNESS_COLLAB_FAILED', message: cause.message || 'Collaboration request failed' } };
    }
    const responses = this.tokens.has(token) ? this.inbox(token, 'responses') : null;
    if (!responses) return;
    try {
      writeJsonAtomic(path.join(responses, `${id}.json`), reply);
    } catch {
      /* The agent was removed meanwhile. */
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.timer);
    for (const watcher of this.watchers.values()) {
      try {
        watcher.close();
      } catch {
        /* Already closed. */
      }
    }
    this.watchers.clear();
  }
}
