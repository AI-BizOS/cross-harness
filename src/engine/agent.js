// One agent on a project: a harness session, its message queue and its transcript.
// The engine owns policy, approvals and collaboration; an Agent runs turns.
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSession } from '../adapters/index.js';
import { CODES, fail, serializeError, isCancelled } from '../protocol/errors.js';
import { appendJsonl, readJsonlTail } from '../util/fsx.js';
import { oneLine, sanitize } from '../util/text.js';

const MAX_TRANSCRIPT = 500;
const MAX_ACTIVITIES = 60;

/** Input kinds: what put a message in the queue. */
export const INPUT_KINDS = Object.freeze(['task', 'question', 'feedback', 'review', 'compare', 'draft']);

export class Agent {
  constructor(engine, record) {
    this.engine = engine;
    this.id = record.id || randomUUID();
    this.name = record.name;
    this.providerId = record.provider;
    this.mode = record.mode;
    this.model = record.model ?? null;
    this.isolation = record.isolation || 'shared';
    this.worktree = record.worktree || null;
    this.cwd = record.cwd || engine.root;
    this.sessionId = record.sessionId ?? null;
    this.rules = Array.isArray(record.rules) ? record.rules : [];
    this.goalId = record.goalId ?? null;
    this.createdAt = record.createdAt || new Date().toISOString();
    this.lastActive = record.lastActive || this.createdAt;
    this.usage = record.usage || {};
    this.progress = record.progress || '';
    this.archived = record.state === 'archived';
    this.state = this.archived ? 'archived' : record.state === 'failed' ? 'failed' : 'offline';
    this.error = record.error || null;
    this.queue = [];
    this.queuePaused = false;
    this.current = null;
    this.session = null;
    this.starting = null;
    this.idleTimer = null;
    this.waitingOn = null;
    this.waitingForSlot = false;
    this.checking = false;
    this.plan = [];
    this.transcriptFile = path.join(engine.stateDir, 'transcripts', `${this.id}.jsonl`);
    this.transcript = readJsonlTail(this.transcriptFile, MAX_TRANSCRIPT);
  }

  get provider() {
    return this.engine.registry[this.providerId] || { id: this.providerId, name: this.providerId, protocol: 'unknown', modes: [] };
  }

  get busy() {
    return Boolean(this.current || this.starting);
  }

  toRecord() {
    return {
      id: this.id,
      name: this.name,
      provider: this.providerId,
      mode: this.mode,
      model: this.model,
      isolation: this.isolation,
      worktree: this.worktree,
      cwd: this.cwd,
      sessionId: this.sessionId,
      rules: this.rules,
      goalId: this.goalId,
      createdAt: this.createdAt,
      lastActive: this.lastActive,
      usage: this.usage,
      progress: this.progress,
      state: this.archived ? 'archived' : this.busy ? 'running' : this.state,
      error: this.error,
    };
  }

  /** What user interfaces and other agents may see. */
  view() {
    const activities = this.current ? [...this.current.activities.values()] : [];
    const running = activities.filter((a) => a.status === 'running').at(-1) || null;
    return {
      id: this.id,
      id8: this.id.slice(0, 8),
      name: this.name,
      provider: this.providerId,
      providerName: this.provider.name,
      protocol: this.provider.protocol,
      verified: Boolean(this.provider.verified),
      mode: this.mode,
      model: this.model,
      isolation: this.isolation,
      branch: this.worktree?.branch || null,
      base: this.worktree?.base || null,
      cwd: this.cwd,
      state: this.archived ? 'archived' : this.starting ? 'starting' : this.current ? 'running' : this.state,
      checking: this.checking,
      needsYou: this.engine.pendingFor(this.id),
      waitingOn: this.waitingOn,
      waitingForSlot: this.waitingForSlot,
      queue: this.queue.length,
      queuePaused: this.queuePaused,
      progress: this.progress,
      activity: running ? { kind: running.kind, title: running.title, detail: running.detail || '' } : null,
      plan: this.plan,
      text: this.current?.text || '',
      turnStartedAt: this.current?.startedAt || null,
      currentInput: this.current ? { kind: this.current.input.kind, from: this.current.input.from?.name || null } : null,
      usage: this.usage,
      error: this.error,
      hasSession: Boolean(this.sessionId),
      live: Boolean(this.session?.alive),
      goalId: this.goalId,
      createdAt: this.createdAt,
      lastActive: this.lastActive,
    };
  }

  record(entry) {
    const full = { id: randomUUID(), at: new Date().toISOString(), ...entry };
    this.transcript.push(full);
    if (this.transcript.length > MAX_TRANSCRIPT) this.transcript.splice(0, this.transcript.length - MAX_TRANSCRIPT);
    try {
      appendJsonl(this.transcriptFile, full);
    } catch (error) {
      this.engine.notice('warn', `Could not save @${this.name}'s transcript: ${error.message}`, { agentId: this.id, code: 'transcript-save-failed', params: { name: this.name, error: error.message } });
    }
    this.engine.emit('agent.message', { agentId: this.id, entry: full });
    return full;
  }

  changed() {
    this.engine.agentChanged(this);
  }

  /** Adds a message to the queue; it runs when the agent is free. */
  enqueue(input) {
    if (this.archived) throw fail(CODES.AGENT_NOT_FOUND, `@${this.name} is archived`);
    const item = { id: randomUUID(), at: new Date().toISOString(), kind: 'task', from: { type: 'user', name: 'you' }, ...input };
    this.queue.push(item);
    this.clearIdle();
    this.changed();
    queueMicrotask(() => void this.runNext());
    return item;
  }

  /** Adds text to the running turn when the harness supports it, else queues it. */
  async steerOrQueue(text) {
    if (this.current && this.session?.alive) {
      const steered = await this.session.steer(text).catch(() => false);
      if (steered) {
        this.record({ role: 'user', text, kind: 'steer', from: { type: 'user', name: 'you' } });
        return { steered: true };
      }
    }
    this.enqueue({ kind: 'task', text });
    return { steered: false, queued: this.queue.length };
  }

  clearIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  scheduleIdle() {
    this.clearIdle();
    const minutes = this.engine.defaults.idleMinutes;
    if (!this.session || !minutes) return;
    this.idleTimer = setTimeout(() => {
      if (this.busy || this.queue.length) return;
      void this.closeSession('idle');
    }, minutes * 60_000);
    this.idleTimer.unref?.();
  }

  async ensureSession() {
    if (this.session?.alive) return this.session;
    if (this.session) {
      await this.session.close().catch(() => {});
      this.session = null;
    }
    const provider = this.provider;
    const status = await this.engine.detector.detect(provider.id);
    if (!status) throw fail(CODES.PROVIDER_UNKNOWN, `Unknown harness "${provider.id}"`);
    if (!status.available) throw fail(CODES.PROVIDER_UNAVAILABLE, `${provider.name} is not available: ${status.fix || status.reason}`);
    if (!(provider.modes || []).includes(this.mode)) throw fail(CODES.PLAN_DENIED, `${provider.name} cannot run in ${this.mode} mode (allowed: ${(provider.modes || []).join(', ')})`);
    const session = createSession(provider, { binary: status.binary, cwd: this.cwd, env: this.engine.agentEnv(provider), spawnProcess: this.engine.spawnProcess });
    const mcpServers = this.engine.collabServers(this);
    // The adapter may report its session id while start() runs, so remember the old one first.
    const previous = this.sessionId;
    // Events can arrive while start() runs (the session id, a history replay).
    this.pendingSession = session;
    let started;
    try {
      started = await session.start({
        sessionId: this.sessionId,
        model: this.model,
        permissionMode: this.mode,
        mcpServers,
        onEvent: (event) => this.onSessionEvent(session, event),
      });
    } finally {
      this.pendingSession = null;
    }
    this.sessionId = started.sessionId || session.sessionId || this.sessionId;
    this.session = session;
    if (previous && started.resumed) this.record({ role: 'system', text: 'Resumed the previous session', code: 'session-resumed', params: {} });
    else if (previous && !started.resumed) this.record({ role: 'system', text: `${provider.name} no longer had the previous session; started a new one`, code: 'session-new', params: { harness: provider.name } });
    this.engine.saveSoon();
    return session;
  }

  onSessionEvent(session, event) {
    if (session !== this.session && session !== this.pendingSession) return;
    const turn = this.current;
    switch (event.type) {
      case 'session':
        if (event.sessionId && event.sessionId !== this.sessionId) {
          this.sessionId = event.sessionId;
          this.engine.saveSoon();
        }
        break;
      case 'text':
        if (!turn) return;
        turn.text = sanitize(event.text);
        this.engine.emit('agent.text', { agentId: this.id, text: turn.text });
        break;
      case 'activity': {
        if (!turn) return;
        const activity = { id: String(event.id), kind: event.kind, title: oneLine(event.title, 160), status: event.status, detail: event.detail ? oneLine(event.detail, 300) : '' };
        turn.activities.set(activity.id, activity);
        if (turn.activities.size > MAX_ACTIVITIES * 2) turn.activities.delete(turn.activities.keys().next().value);
        this.engine.emit('agent.activity', { agentId: this.id, activity });
        break;
      }
      case 'plan':
        this.plan = event.entries;
        this.engine.emit('agent.plan', { agentId: this.id, entries: this.plan });
        break;
      case 'usage':
        for (const [key, value] of Object.entries(event.usage || {})) {
          if (Number.isFinite(value)) this.usage[key] = (this.usage[key] || 0) + value;
        }
        if (turn) turn.usageEvents++;
        break;
      case 'approval':
        this.engine.handleApproval(this, event);
        break;
      default:
        break;
    }
  }

  async runNext() {
    if (this.busy || this.archived || this.queuePaused || !this.queue.length) {
      if (!this.busy && !this.queue.length) this.scheduleIdle();
      return;
    }
    if (!this.engine.acquireSlot(this)) {
      if (!this.waitingForSlot) {
        this.waitingForSlot = true;
        this.changed();
      }
      return;
    }
    this.waitingForSlot = false;
    const input = this.queue.shift();
    const controller = new AbortController();
    this.current = { input, startedAt: Date.now(), text: '', activities: new Map(), controller, usageEvents: 0 };
    this.error = null;
    this.lastActive = new Date().toISOString();
    this.record({
      role: input.kind === 'task' ? 'user' : input.kind,
      text: input.display ?? input.text,
      ...(input.displayKey ? { key: input.displayKey, params: input.displayParams || {} } : {}),
      kind: input.kind,
      from: input.from,
    });
    this.changed();
    let result = null;
    let error = null;
    try {
      this.starting = this.ensureSession();
      this.changed();
      try {
        await this.starting;
      } finally {
        this.starting = null;
      }
      if (controller.signal.aborted) {
        await this.closeSession('stopped');
        throw fail(CODES.CANCELLED, 'Stopped');
      }
      this.changed();
      result = await this.session.prompt(input.text, { signal: controller.signal });
    } catch (cause) {
      error = cause;
    }
    const turn = this.current;
    this.current = null;
    this.lastActive = new Date().toISOString();
    this.engine.expireApprovals(this.id);
    // A step the harness never reported as finished is over with the turn.
    const final = (status) => (status === 'running' ? (error ? 'failed' : 'done') : status);
    const activities = [...turn.activities.values()].slice(-MAX_ACTIVITIES).map(({ kind, title, status, detail }) => ({ kind, title, status: final(status), ...(detail ? { detail } : {}) }));
    const durationMs = Date.now() - turn.startedAt;
    if (!error) {
      const text = sanitize(result?.text || turn.text || '');
      this.state = 'idle';
      this.record({ role: 'assistant', text: text || '(no answer text)', kind: input.kind, activities, durationMs });
      input.resolve?.({ status: 'answered', answer: text });
    } else if (isCancelled(error)) {
      this.state = 'stopped';
      this.record({ role: 'system', text: turn.stopReason || 'Stopped', code: 'stopped', ...(turn.stopReason ? {} : { params: {} }), activities, durationMs, ...(turn.text ? { partial: turn.text } : {}) });
      input.resolve?.({ status: 'failed', error: 'the turn was stopped before it answered' });
    } else {
      this.state = 'failed';
      this.error = serializeError(error);
      const signIn = error.code === CODES.AUTH_REQUIRED ? this.provider.signIn : null;
      const text = signIn && !error.message.includes(signIn) ? `${error.message} ${signIn}.` : error.message;
      this.record({ role: 'error', text, code: error.code, activities, durationMs, ...(turn.text ? { partial: turn.text } : {}) });
      input.resolve?.({ status: 'failed', error: error.message });
      if (error.code === CODES.PROCESS_EXITED || error.code === CODES.CLOSED || error.code === CODES.START_FAILED || error.code === CODES.AUTH_REQUIRED) {
        await this.closeSession('error');
      }
    }
    this.plan = [];
    this.changed();
    this.engine.releaseSlot(this);
    if (!error && !this.archived) await this.engine.afterTurn(this, input).catch((cause) => this.engine.notice('error', `After @${this.name}'s turn: ${cause.message}`, { agentId: this.id, code: 'after-turn-failed', params: { name: this.name, error: cause.message } }));
    void this.runNext();
  }

  /** Stops the running turn and the process, so nothing keeps writing after "stop". */
  async stop(reason = 'Stopped by you') {
    const turn = this.current;
    if (this.queue.length) this.queuePaused = true;
    if (!turn && !this.starting) {
      this.changed();
      return { stopped: false };
    }
    if (turn) {
      turn.stopReason = reason;
      turn.controller.abort();
    }
    await this.closeSession('stopped');
    this.changed();
    return { stopped: true };
  }

  resumeQueue() {
    this.queuePaused = false;
    this.changed();
    void this.runNext();
  }

  async closeSession(reason) {
    this.clearIdle();
    const session = this.session;
    this.session = null;
    if (session) await session.close().catch(() => {});
    if (!this.busy && !this.archived && reason !== 'stopped' && this.state !== 'failed') this.state = 'offline';
    this.changed();
  }

  async archive() {
    await this.stop('Archived');
    for (const item of this.queue) item.resolve?.({ status: 'failed', error: `@${this.name} was archived` });
    this.queue = [];
    this.archived = true;
    this.state = 'archived';
    this.changed();
  }
}
