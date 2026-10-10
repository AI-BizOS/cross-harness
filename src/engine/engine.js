// The Troupe engine: one per project. It owns the agents, dispatches messages, routes
// approvals and questions, runs goal gates and merges. User interfaces (TUI, GUI,
// remote clients) talk to it only through call(method, params) and subscribe().
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CODES, fail, serializeError } from '../protocol/errors.js';
import { LIMITS, MODE_RANK, PERMISSION_MODES, PROTOCOL_VERSION } from '../protocol/index.js';
import { DEFAULTS, loadConfig, projectId, projectStateDir, troupeHome } from '../config.js';
import { buildRegistry } from '../providers/registry.js';
import { createDetector } from '../providers/detect.js';
import { MailboxHub } from '../collab/mailbox.js';
import { changes, commitAll, createWorktree, git, mergeBranch, repoInfo, safeBranchPart, workingTree } from '../git/worktree.js';
import { approveGoal, armProblems, DRAFT_INSTRUCTIONS, goalBrief, normalizeGoal, parseGoalDraft } from '../goals/goal.js';
import { evaluateGate, feedbackPrompt, parseVerdict, reviewPrompt } from '../goals/gate.js';
import { appendJsonl, ensureDir, readJson, removeQuietly, writeJsonAtomic } from '../util/fsx.js';
import { clip, oneLine } from '../util/text.js';
import { Agent } from './agent.js';
import { completions, looksLikeReview, parseDispatch, SPECIAL } from './dispatch.js';
import { capMode, decide, ruleFor } from './policy.js';

export const VERSION = '0.1.1';
const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'troupe.js');
const NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const QUESTION_KEEP = 64;
// Projects open in this process; the lock file covers other processes.
const OPEN_PROJECTS = new Set();

/** RPC surface: only these methods are reachable from user interfaces and remote clients. */
export const METHODS = Object.freeze([
  'snapshot',
  'providers',
  'completions',
  'send',
  'createAgent',
  'prompt',
  'stop',
  'resumeQueue',
  'retry',
  'archive',
  'rename',
  'setMode',
  'setModel',
  'transcript',
  'approve',
  'answerDecision',
  'boardWrite',
  'diff',
  'review',
  'merge',
  'goalSave',
  'goalApprove',
  'goalStart',
  'goalPause',
  'goalCheck',
  'goalConfirm',
  'goalDraft',
  'goalDelete',
]);

export class Engine {
  /**
   * @param {object} options
   * @param {string} options.root project directory
   * @param {NodeJS.ProcessEnv} [options.env]
   * @param {object} [options.config] loadConfig() result
   * @param {Record<string,object>} [options.providers] extra/overriding provider definitions
   * @param {{command:string,args:string[]}} [options.launcher] how agents start `troupe mcp`
   * @param {Function} [options.spawnProcess] child_process.spawn replacement (tests)
   * @param {boolean} [options.builtins=true] include the built-in harness definitions
   * @param {boolean} [options.collab=true] give agents the collaboration tools
   */
  constructor({ root, env = process.env, config = null, providers = {}, builtins = true, launcher = null, spawnProcess = undefined, collab = true, stateDir = null, worktreeRoot = null, detector = null }) {
    this.root = path.resolve(root);
    this.env = env;
    this.config = config || loadConfig(env);
    this.defaults = { ...DEFAULTS, ...this.config.defaults };
    this.registry = buildRegistry({ ...this.config.providers, ...providers }, { builtins });
    this.detector = detector || createDetector({ registry: this.registry, env });
    this.home = troupeHome(env);
    this.stateDir = stateDir || projectStateDir(this.root, env);
    this.worktreeRoot = worktreeRoot || path.join(this.home, 'worktrees', projectId(this.root));
    this.launcher = launcher || { command: process.execPath, args: [BIN, 'mcp'] };
    this.spawnProcess = spawnProcess;
    this.collabEnabled = collab;
    this.agents = new Map();
    this.approvals = new Map();
    this.decisions = new Map();
    this.decisionWaiters = new Map();
    this.questions = [];
    this.liveAsks = [];
    this.goals = new Map();
    this.board = { entries: {} };
    this.listeners = new Set();
    this.seq = 0;
    this.providersCache = [];
    this.project = { root: this.root, name: path.basename(this.root), isGit: false, branch: null, head: null };
    this.opened = false;
    this.closing = false;
    this.saveTimer = null;
  }

  // ── lifecycle ──────────────────────────────────────────────────────────

  async open({ force = false } = {}) {
    if (this.opened) return this;
    if (!fs.existsSync(this.root) || !fs.statSync(this.root).isDirectory()) throw fail(CODES.ARGUMENT_INVALID, `${this.root} is not a directory`);
    ensureDir(this.stateDir);
    ensureDir(path.join(this.stateDir, 'transcripts'));
    ensureDir(path.join(this.stateDir, 'goals'));
    this.takeLock(force);
    await this.refreshProject();
    writeJsonAtomic(path.join(this.stateDir, 'project.json'), { schema: 1, root: this.root, name: this.project.name, openedAt: new Date().toISOString() });
    this.board = readJson(path.join(this.stateDir, 'board.json'), null) || { entries: {} };
    for (const decision of readJson(path.join(this.stateDir, 'decisions.json'), {})?.decisions || []) {
      if (decision?.id && decision.status !== 'delivered') this.decisions.set(decision.id, decision);
    }
    for (const name of fs.readdirSync(path.join(this.stateDir, 'goals'))) {
      const goal = readJson(path.join(this.stateDir, 'goals', name));
      if (goal?.id) this.goals.set(goal.id, goal);
    }
    const records = readJson(path.join(this.stateDir, 'agents.json'), {})?.agents || [];
    for (const record of records) {
      if (!record?.id || !record.name) continue;
      const agent = new Agent(this, record);
      this.agents.set(agent.id, agent);
      if (record.state === 'running') {
        agent.state = 'stopped';
        agent.record({ role: 'system', code: 'interrupted', params: {}, text: 'Troupe exited while this agent was working. Check its changes before continuing.' });
      }
    }
    if (this.collabEnabled) {
      // Everything an agent writes, its worktree and its mailbox, is under one directory,
      // so a harness that sandboxes its tools (BizOS Code) needs a single write grant, and
      // Troupe's own state, including the mailbox tokens, stays outside it. 0.1.0 kept the
      // mailboxes in the project state; that copy is removed.
      fs.rmSync(path.join(this.stateDir, 'mailbox'), { recursive: true, force: true });
      this.hub = new MailboxHub({ dir: path.join(this.worktreeRoot, '.mailbox'), tokensFile: path.join(this.stateDir, 'mailbox-tokens.json'), handle: (agentId, op, params) => this.collab(agentId, op, params) });
      this.hub.retain([...this.agents.values()].filter((a) => !a.archived).map((a) => a.id));
    }
    this.opened = true;
    this.save();
    void this.refreshProviders();
    return this;
  }

  takeLock(force) {
    if (OPEN_PROJECTS.has(this.stateDir) && !force) throw fail(CODES.LOCKED, 'This project is already open in this Troupe');
    const file = path.join(this.stateDir, 'lock.json');
    const lock = readJson(file);
    if (lock?.pid && lock.pid !== process.pid && !force) {
      let alive = false;
      try {
        process.kill(lock.pid, 0);
        alive = true;
      } catch (error) {
        alive = error.code === 'EPERM';
      }
      if (alive) throw fail(CODES.LOCKED, `This project is already open in another Troupe (pid ${lock.pid}). Close that one first.`);
    }
    writeJsonAtomic(file, { pid: process.pid, startedAt: new Date().toISOString() });
    this.lockFile = file;
    OPEN_PROJECTS.add(this.stateDir);
  }

  async close() {
    if (this.closing) return;
    this.closing = true;
    clearTimeout(this.saveTimer);
    await Promise.all(
      [...this.agents.values()].map(async (agent) => {
        agent.clearIdle();
        if (agent.busy) await agent.stop('Stopped: Troupe was closed').catch(() => {});
        await agent.closeSession('quit').catch(() => {});
      }),
    );
    for (const [id, resolve] of this.decisionWaiters) resolve({ status: 'pending', decisionId: id });
    this.decisionWaiters.clear();
    this.hub?.dispose();
    this.save();
    if (this.lockFile) {
      OPEN_PROJECTS.delete(this.stateDir);
      if (readJson(this.lockFile)?.pid === process.pid) removeQuietly(this.lockFile);
    }
    this.listeners.clear();
  }

  // ── events and persistence ─────────────────────────────────────────────

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(type, payload = {}) {
    const event = { seq: ++this.seq, type, at: Date.now(), ...payload };
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        /* A broken listener must not stop the engine. */
      }
    }
    return event;
  }

  notice(level, text, extra = {}) {
    this.emit('notice', { level, text, ...extra });
  }

  audit(type, data = {}) {
    try {
      appendJsonl(path.join(this.stateDir, 'events.jsonl'), { at: new Date().toISOString(), type, ...data });
    } catch {
      /* The audit log is best effort. */
    }
  }

  saveSoon() {
    if (this.saveTimer || this.closing) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 200);
    this.saveTimer.unref?.();
  }

  save() {
    try {
      writeJsonAtomic(path.join(this.stateDir, 'agents.json'), { schema: 1, agents: [...this.agents.values()].map((agent) => agent.toRecord()) });
      writeJsonAtomic(path.join(this.stateDir, 'decisions.json'), { schema: 1, decisions: [...this.decisions.values()] });
    } catch (error) {
      this.notice('error', `Could not save Troupe state: ${error.message}`, { code: 'state-save-failed', params: { error: error.message } });
    }
  }

  agentChanged(agent) {
    this.emit('agent.updated', { agent: agent.view() });
    this.saveSoon();
  }

  async refreshProject() {
    const info = await repoInfo(this.root, this.env).catch(() => ({ isGit: false, branch: null, head: null }));
    this.project = { root: this.root, name: path.basename(this.root), isGit: info.isGit, branch: info.branch, head: info.head, gitRoot: info.root || null };
    this.emit('project.updated', { project: this.project });
    return this.project;
  }

  async refreshProviders({ refresh = false } = {}) {
    try {
      this.providersCache = await this.detector.detectAll({ refresh });
      this.emit('project.updated', { project: this.project, providers: this.providersCache });
    } catch (error) {
      this.notice('warn', `Could not check installed agents: ${error.message}`, { code: 'detect-failed', params: { error: error.message } });
    }
    return this.providersCache;
  }

  // ── RPC ────────────────────────────────────────────────────────────────

  async call(method, params = {}) {
    if (!METHODS.includes(method) || typeof this[method] !== 'function') throw fail(CODES.METHOD_UNKNOWN, `Unknown method: ${method}`);
    if (params !== undefined && (params === null || typeof params !== 'object' || Array.isArray(params))) throw fail(CODES.ARGUMENT_INVALID, 'Parameters must be an object');
    return this[method](params || {});
  }

  snapshot() {
    return {
      protocol: PROTOCOL_VERSION,
      version: VERSION,
      seq: this.seq,
      project: this.project,
      defaults: this.defaults,
      agents: [...this.agents.values()].map((agent) => agent.view()),
      approvals: [...this.approvals.values()].map(publicApproval),
      decisions: [...this.decisions.values()].filter((d) => d.status === 'pending').map(publicDecision),
      board: this.boardView(),
      goals: [...this.goals.values()],
      providers: this.providersCache,
    };
  }

  async providers({ refresh = false } = {}) {
    return this.refreshProviders({ refresh });
  }

  completions({ prefix = '' } = {}) {
    return completions(prefix, { agents: [...this.agents.values()].map((a) => a.view()), providers: this.providersCache });
  }

  // ── agents ─────────────────────────────────────────────────────────────

  agentRef(ref) {
    if (ref instanceof Agent) return ref;
    const wanted = String(ref || '')
      .trim()
      .replace(/^@/, '')
      .toLowerCase();
    if (!wanted) throw fail(CODES.AGENT_NOT_FOUND, 'Name an agent');
    const all = [...this.agents.values()];
    const exact = all.find((a) => a.id === wanted || a.name === wanted);
    if (exact) return exact;
    const prefixed = wanted.length >= 4 ? all.filter((a) => a.id.startsWith(wanted)) : [];
    if (prefixed.length === 1) return prefixed[0];
    throw fail(CODES.AGENT_NOT_FOUND, `No agent called @${wanted}`);
  }

  agentByName(name) {
    const wanted = String(name || '').replace(/^@/, '').toLowerCase();
    return [...this.agents.values()].find((a) => a.name === wanted) || null;
  }

  nextName(providerId) {
    const used = new Set([...this.agents.values()].map((a) => a.name));
    if (!used.has(providerId)) return providerId;
    for (let n = 2; ; n++) if (!used.has(`${providerId}-${n}`)) return `${providerId}-${n}`;
  }

  validateName(name, { except = null } = {}) {
    const value = String(name || '').replace(/^@/, '').toLowerCase();
    if (!NAME.test(value)) throw fail(CODES.NAME_INVALID, 'Names start with a letter and use lowercase letters, digits, - or _ (max 32)');
    if (SPECIAL.includes(value)) throw fail(CODES.NAME_INVALID, `@${value} is reserved`);
    const owner = this.agentByName(value);
    if (owner && owner !== except) throw fail(CODES.AGENT_EXISTS, `@${value} already exists`);
    if (this.registry[value] && (!except || except.providerId !== value)) throw fail(CODES.NAME_INVALID, `@${value} names a harness; pick another name`);
    return value;
  }

  async createAgent({ provider, name = null, mode = null, isolation = null, model = null } = {}) {
    const definition = this.registry[provider];
    if (!definition) throw fail(CODES.PROVIDER_UNKNOWN, `Unknown harness "${provider}"`);
    const chosenMode = mode || this.defaults.mode;
    if (!PERMISSION_MODES.includes(chosenMode)) throw fail(CODES.PERMISSION_INVALID, `Unknown mode "${chosenMode}"`);
    const modes = [...(definition.modes || PERMISSION_MODES)].sort((a, b) => MODE_RANK[a] - MODE_RANK[b]);
    let finalMode = modes.includes(chosenMode) ? chosenMode : null;
    // Without an explicit mode, prefer the closest mode below the default; going above
    // it is allowed only when the harness has nothing lower, and is announced.
    if (!finalMode && !mode) finalMode = modes.filter((m) => MODE_RANK[m] <= MODE_RANK[chosenMode]).at(-1) || modes[0];
    if (!finalMode) throw fail(CODES.PLAN_DENIED, `${definition.name} only runs in ${modes.join(' or ')} mode`);
    const agentName = name ? this.validateName(name) : this.nextName(definition.id);
    const id = randomUUID();
    let wantIsolation = isolation || this.defaults.isolation;
    if (definition.writes === false) wantIsolation = 'shared';
    let worktree = null;
    let cwd = this.project.gitRoot || this.root;
    if (wantIsolation === 'worktree' && this.project.isGit && this.project.head) {
      const part = safeBranchPart(agentName);
      let branch = `troupe/${part}`;
      const exists = (await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: this.project.gitRoot, env: this.env, allowFail: true })).code === 0;
      if (exists) branch = `troupe/${part}-${id.slice(0, 6)}`;
      const dir = path.join(this.worktreeRoot, `${part}-${id.slice(0, 6)}`);
      const base = this.project.branch || this.project.head;
      worktree = await createWorktree({ root: this.project.gitRoot, dir, branch, base, env: this.env });
      // A sub-directory project keeps its relative position inside the worktree. Git
      // reports its root with symbolic links resolved, so the project path is resolved too.
      cwd = path.join(worktree.path, path.relative(this.project.gitRoot, fs.realpathSync(this.root)));
    } else {
      wantIsolation = 'shared';
    }
    const agent = new Agent(this, { id, name: agentName, provider: definition.id, mode: finalMode, model, isolation: wantIsolation, worktree, cwd, state: 'idle' });
    agent.state = 'idle';
    this.agents.set(agent.id, agent);
    agent.record(
      worktree
        ? { role: 'system', code: 'created', params: { branch: worktree.branch }, text: `Working on branch ${worktree.branch} in its own worktree` }
        : this.project.isGit
          ? { role: 'system', code: 'created', key: 'created.shared', params: {}, text: 'Working directly in the project directory' }
          : { role: 'system', code: 'created', key: 'created.plain', params: {}, text: 'Working directly in the project directory (not a git repository, so no isolation)' },
    );
    if (MODE_RANK[finalMode] > MODE_RANK[chosenMode]) {
      const key = finalMode === 'full' ? 'mode-raised.full' : 'mode-raised';
      const params = { harness: definition.name, mode: chosenMode, final: finalMode };
      const text = `${definition.name} cannot run in ${chosenMode} mode, so this agent runs in ${finalMode} mode${finalMode === 'full' ? ' and acts without asking' : ''}`;
      agent.record({ role: 'system', code: 'mode-raised', key, params, text });
      this.notice('warn', `@${agent.name}: ${text}`, { agentId: agent.id, code: 'mode-raised', key: `${key}.agent`, params: { ...params, name: agent.name } });
    }
    this.audit('agent.created', { agent: agent.name, provider: definition.id, mode: finalMode, isolation: wantIsolation, branch: worktree?.branch || null });
    this.agentChanged(agent);
    this.save();
    return agent.view();
  }

  /** Every non-archived agent's environment: the user's plus the harness's own entries. */
  agentEnv(provider) {
    const env = { ...this.env, ...(provider.env || {}) };
    delete env.TROUPE_MAILBOX;
    delete env.TROUPE_TOKEN;
    return env;
  }

  collabServers(agent) {
    if (!this.collabEnabled || !this.hub || agent.provider.protocol === 'exec') return [];
    const { dir, token } = this.hub.register(agent.id);
    return [{ name: 'troupe', command: this.launcher.command, args: this.launcher.args, env: { TROUPE_MAILBOX: dir, TROUPE_TOKEN: token } }];
  }

  acquireSlot(agent) {
    const running = [...this.agents.values()].filter((a) => a !== agent && a.providerId === agent.providerId && a.busy).length;
    return running < this.defaults.maxPerProvider;
  }

  releaseSlot(agent) {
    for (const other of this.agents.values()) {
      if (other !== agent && other.providerId === agent.providerId && other.waitingForSlot) void other.runNext();
    }
  }

  pendingFor(agentId) {
    let count = 0;
    for (const approval of this.approvals.values()) if (approval.agentId === agentId) count++;
    for (const decision of this.decisions.values()) if (decision.agentId === agentId && decision.status === 'pending') count++;
    return count;
  }

  async prompt({ agent: ref, text }) {
    const agent = this.agentRef(ref);
    if (typeof text !== 'string' || !text.trim()) throw fail(CODES.PROMPT_INVALID, 'The message is empty');
    if (text.length > LIMITS.prompt) throw fail(CODES.PROMPT_INVALID, 'The message is too long');
    if (agent.archived) throw fail(CODES.AGENT_NOT_FOUND, `@${agent.name} is archived`);
    return agent.steerOrQueue(text);
  }

  async stop({ agent: ref }) {
    return this.agentRef(ref).stop();
  }

  resumeQueue({ agent: ref }) {
    this.agentRef(ref).resumeQueue();
    return { ok: true };
  }

  retry({ agent: ref }) {
    const agent = this.agentRef(ref);
    const last = [...agent.transcript].reverse().find((entry) => entry.role === 'user' && entry.kind !== 'steer');
    if (!last) throw fail(CODES.ARGUMENT_INVALID, `@${agent.name} has no earlier message to send again`);
    agent.queuePaused = false;
    agent.enqueue({ kind: 'task', text: last.text });
    return { queued: true };
  }

  async archive({ agent: ref }) {
    const agent = this.agentRef(ref);
    await agent.archive();
    this.hub?.unregister(agent.id);
    this.audit('agent.archived', { agent: agent.name });
    this.save();
    return agent.view();
  }

  rename({ agent: ref, name }) {
    const agent = this.agentRef(ref);
    const next = this.validateName(name, { except: agent });
    const before = agent.name;
    agent.name = next;
    agent.record({ role: 'system', code: 'renamed', params: { before, next }, text: `Renamed from @${before} to @${next}` });
    for (const goal of this.goals.values()) {
      if (goal.assignees.includes(before)) {
        goal.assignees = goal.assignees.map((n) => (n === before ? next : n));
        this.writeGoal(goal);
      }
    }
    agent.changed();
    return agent.view();
  }

  async setMode({ agent: ref, mode }) {
    const agent = this.agentRef(ref);
    if (!PERMISSION_MODES.includes(mode)) throw fail(CODES.PERMISSION_INVALID, `Unknown mode "${mode}"`);
    if (!(agent.provider.modes || PERMISSION_MODES).includes(mode)) throw fail(CODES.PLAN_DENIED, `${agent.provider.name} cannot run in ${mode} mode`);
    agent.mode = mode;
    agent.record({ role: 'system', code: 'mode', params: { mode }, text: `Permission mode: ${mode}` });
    // The harness applies its mode when a session starts; restart an idle one now.
    if (!agent.busy) await agent.closeSession('mode');
    agent.changed();
    return agent.view();
  }

  async setModel({ agent: ref, model }) {
    const agent = this.agentRef(ref);
    agent.model = model ? String(model).trim().slice(0, 128) : null;
    if (!agent.busy) await agent.closeSession('model');
    agent.changed();
    return agent.view();
  }

  transcript({ agent: ref, limit = 200 }) {
    const agent = this.agentRef(ref);
    return { agentId: agent.id, entries: agent.transcript.slice(-Math.max(1, Math.min(limit, 500))) };
  }

  // ── dispatch ───────────────────────────────────────────────────────────

  isKnownName(name) {
    return Boolean(this.agentByName(name) || this.registry[name]);
  }

  /**
   * Sends a message: "@a @b task", one assignment per mention line, @all, @auto, @compare.
   * Text without mentions goes to `to` (the agent selected in the UI).
   */
  async send({ text, to = null }) {
    if (typeof text !== 'string' || !text.trim()) throw fail(CODES.PROMPT_INVALID, 'The message is empty');
    if (text.length > LIMITS.prompt) throw fail(CODES.PROMPT_INVALID, 'The message is too long');
    const parsed = parseDispatch(text, (name) => this.isKnownName(name));
    const assignments = parsed.assignments.map((a) => ({ ...a }));
    if (parsed.unaddressed) {
      if (!assignments.length) {
        if (!to) throw fail(CODES.NO_TARGET, 'Start the message with @agent (for example @codex or @claude), or select an agent first');
        assignments.push({ targets: [{ name: this.agentRef(to).name, fresh: false }], text: parsed.unaddressed });
      } else {
        // Text before the first mention is shared context for every assignment.
        for (const a of assignments) a.text = `${parsed.unaddressed}\n\n${a.text}`.trim();
      }
    }
    const dispatched = [];
    const skipped = [];
    const waits = [];
    for (const assignment of assignments) {
      if (!assignment.text) {
        skipped.push({ target: assignment.targets.map((t) => `@${t.name}`).join(' '), reason: 'nothing to send' });
        continue;
      }
      const resolved = await this.expandTargets(assignment.targets, assignment.text, skipped);
      for (const { agent, created } of resolved) {
        if (dispatched.some((d) => d.agentId === agent.id)) continue;
        const answer = parsed.compare ? new Promise((resolve) => agent.enqueue({ kind: 'task', text: assignment.text, resolve })) : null;
        if (!answer) await agent.steerOrQueue(assignment.text);
        if (answer) waits.push(answer.then((result) => ({ agent: agent.name, provider: agent.provider.name, ...result })));
        dispatched.push({ agentId: agent.id, agent: agent.name, provider: agent.providerId, created, isolation: agent.isolation, branch: agent.worktree?.branch || null });
      }
    }
    if (parsed.compare && waits.length) {
      const judge = await this.pickJudge(parsed.compare.judge, dispatched).catch((error) => {
        skipped.push({ target: '@compare', reason: error.message });
        return null;
      });
      if (judge) {
        const request = assignments.map((a) => a.text).join('\n\n');
        void Promise.all(waits)
          .then((answers) => judge.enqueue({ kind: 'compare', text: comparePrompt(request, answers), display: `Compare ${answers.length} answers`, displayKey: 'compare', displayParams: { n: answers.length }, from: { type: 'troupe', name: 'troupe' } }))
          .catch((error) => this.notice('error', `Compare failed: ${error.message}`, { code: 'compare-failed', params: { error: error.message } }));
        dispatched.push({ agentId: judge.id, agent: judge.name, provider: judge.providerId, created: false, role: 'compare' });
      }
    }
    if (!dispatched.length && skipped.length) throw fail(CODES.PROVIDER_UNAVAILABLE, skipped.map((s) => `${s.target}: ${s.reason}`).join('; '), { skipped });
    this.audit('dispatch', { text: clip(text, 500), dispatched: dispatched.map((d) => d.agent), skipped });
    return { dispatched, skipped };
  }

  async expandTargets(targets, text, skipped) {
    const out = [];
    const add = (agent, created = false) => {
      if (!out.some((o) => o.agent === agent)) out.push({ agent, created });
    };
    const statusOf = async (providerId) => this.detector.detect(providerId).catch(() => null);
    const createFor = async (providerId, label) => {
      const status = await statusOf(providerId);
      if (!status?.available) {
        skipped.push({ target: label, reason: status ? status.fix || status.reason : 'unknown harness' });
        return null;
      }
      try {
        const view = await this.createAgent({ provider: providerId });
        return this.agents.get(view.id);
      } catch (error) {
        skipped.push({ target: label, reason: error.message });
        return null;
      }
    };
    const live = () => [...this.agents.values()].filter((a) => !a.archived);
    for (const target of targets) {
      const label = `@${target.name}${target.fresh ? '+' : ''}`;
      if (target.name === 'all') {
        const existing = live();
        if (existing.length) existing.forEach((a) => add(a));
        else {
          const available = (await this.refreshProviders()).filter((p) => p.available).slice(0, 4);
          if (!available.length) skipped.push({ target: label, reason: 'no harness is installed' });
          for (const p of available) {
            const agent = await createFor(p.id, `@${p.id}`);
            if (agent) add(agent, true);
          }
        }
        continue;
      }
      if (target.name === 'auto') {
        const want = looksLikeReview(text) ? 2 : 1;
        const available = (this.providersCache.length ? this.providersCache : await this.refreshProviders()).filter((p) => p.available);
        const picked = [];
        for (const p of available) {
          if (picked.length >= want) break;
          const idle = live().find((a) => a.providerId === p.id && !a.busy && !out.some((o) => o.agent === a));
          if (idle) picked.push({ agent: idle, created: false });
          else {
            const agent = await createFor(p.id, `@auto (${p.id})`);
            if (agent) picked.push({ agent, created: true });
          }
        }
        if (!picked.length) skipped.push({ target: label, reason: 'no harness is available' });
        picked.forEach((p) => add(p.agent, p.created));
        continue;
      }
      const named = this.agentByName(target.name);
      if (named && !target.fresh) {
        if (named.archived) skipped.push({ target: label, reason: `@${named.name} is archived` });
        else add(named);
        continue;
      }
      const providerId = named ? named.providerId : this.registry[target.name] ? target.name : null;
      if (!providerId) {
        skipped.push({ target: label, reason: 'unknown agent or harness' });
        continue;
      }
      if (!target.fresh) {
        const existing = live()
          .filter((a) => a.providerId === providerId)
          .sort((a, b) => Number(a.busy) - Number(b.busy) || String(b.lastActive).localeCompare(String(a.lastActive)));
        if (existing.length) {
          add(existing[0]);
          continue;
        }
      }
      const agent = await createFor(providerId, label);
      if (agent) add(agent, true);
    }
    return out;
  }

  async pickJudge(name, dispatched) {
    if (name) {
      const named = this.agentByName(name);
      if (named && !named.archived) return named;
      if (this.registry[name]) {
        const view = await this.createAgent({ provider: name, mode: 'plan', isolation: 'shared' });
        return this.agents.get(view.id);
      }
      throw fail(CODES.AGENT_NOT_FOUND, `No agent or harness called @${name}`);
    }
    const used = new Set(dispatched.map((d) => d.provider));
    const other = this.providersCache.find((p) => p.available && !used.has(p.id));
    if (other) {
      const idle = [...this.agents.values()].find((a) => !a.archived && a.providerId === other.id);
      if (idle) return idle;
      const view = await this.createAgent({ provider: other.id, mode: 'plan', isolation: 'shared' });
      return this.agents.get(view.id);
    }
    return this.agents.get(dispatched[0].agentId);
  }

  // ── approvals ──────────────────────────────────────────────────────────

  handleApproval(agent, event) {
    const request = { kind: event.kind, title: event.title, command: event.command, detail: event.detail, paths: event.paths };
    const mode = capMode(agent.mode, agent.current?.input?.modeCap);
    const verdict = decide({ mode, request, rules: agent.rules, root: agent.worktree?.path || agent.cwd });
    if (verdict !== 'ask') {
      event.respond(verdict === 'allow' ? 'allow_once' : 'deny');
      if (verdict === 'deny') this.notice('info', `Denied for @${agent.name} (${mode} mode): ${oneLine(event.title, 80)}`, { agentId: agent.id, code: 'denied', params: { name: agent.name, mode, title: oneLine(event.title, 80) } });
      this.audit('approval.auto', { agent: agent.name, kind: event.kind, title: oneLine(event.title, 200), verdict, mode });
      return;
    }
    const approval = {
      id: randomUUID(),
      agentId: agent.id,
      agentName: agent.name,
      provider: agent.providerId,
      kind: event.kind,
      title: oneLine(event.title, 200),
      detail: clip(String(event.detail || ''), 4000),
      command: event.command ? clip(String(event.command), 4000) : null,
      options: event.options || ['allow_once', 'allow_always', 'deny'],
      at: new Date().toISOString(),
      respond: event.respond,
    };
    this.approvals.set(approval.id, approval);
    this.emit('approval.requested', { approval: publicApproval(approval) });
    agent.changed();
  }

  approve({ id, choice }) {
    const approval = this.approvals.get(id);
    if (!approval) throw fail(CODES.APPROVAL_NOT_FOUND, 'This request was already answered or expired');
    if (!['allow_once', 'allow_always', 'deny'].includes(choice)) throw fail(CODES.APPROVAL_INVALID, `Unknown choice: ${choice}`);
    this.approvals.delete(id);
    const agent = this.agents.get(approval.agentId);
    if (choice === 'allow_always' && agent) {
      const rule = ruleFor(approval);
      if (!agent.rules.some((r) => JSON.stringify(r) === JSON.stringify(rule))) agent.rules.push(rule);
    }
    let delivered = false;
    try {
      delivered = approval.respond(choice) !== false;
    } catch {
      delivered = false;
    }
    this.audit('approval', { agent: approval.agentName, kind: approval.kind, title: approval.title, choice });
    this.emit('approval.resolved', { id, choice, delivered });
    if (agent) agent.changed();
    return { delivered };
  }

  expireApprovals(agentId) {
    for (const [id, approval] of [...this.approvals]) {
      if (approval.agentId !== agentId) continue;
      this.approvals.delete(id);
      try {
        approval.respond('cancel');
      } catch {
        /* Already answered by the harness. */
      }
      this.emit('approval.resolved', { id, choice: 'expired', delivered: false });
    }
  }

  // ── collaboration (requests from agents' troupe mcp servers) ───────────

  async collab(agentId, op, params) {
    const self = this.agents.get(agentId);
    if (!self || self.archived) throw fail(CODES.COLLAB_UNAVAILABLE, 'This agent is no longer active');
    switch (op) {
      case 'list_agents':
        return {
          agents: this.peers(self).map((a) => ({
            name: a.name,
            id8: a.id.slice(0, 8),
            provider: a.provider.name,
            state: a.busy ? 'working' : a.state,
            branch: a.worktree?.branch || null,
            doing: a.progress || a.view().activity?.title || '',
          })),
        };
      case 'ask_agent':
        return this.askAgent(self, params);
      case 'check_answers':
        return this.checkAnswers(self);
      case 'ask_user':
        return this.askUser(self, params);
      case 'board_read':
        return this.boardRead(params);
      case 'board_write':
        return this.boardWriteAs(self.name, params);
      case 'report_progress': {
        const status = requireText(params.status, LIMITS.status, 'status');
        self.progress = status;
        self.changed();
        return { ok: true };
      }
      case 'goal_status': {
        const goal = self.goalId ? this.goals.get(self.goalId) : null;
        const lastGate = goal ? [...goal.gates].reverse().find((g) => g.agent === self.name) || null : null;
        return { goal, lastGate };
      }
      default:
        throw fail(CODES.COLLAB_INVALID, `Unknown collaboration operation: ${op}`);
    }
  }

  peers(self) {
    return [...this.agents.values()].filter((a) => a !== self && !a.archived);
  }

  resolvePeer(self, name) {
    const wanted = String(name || '')
      .trim()
      .replace(/^@/, '')
      .toLowerCase();
    const peers = this.peers(self);
    const listing = peers.map((p) => `@${p.name} (${p.provider.name})`).join(', ') || 'none';
    if (!wanted) throw fail(CODES.COLLAB_INVALID, `Name the agent to ask. Available: ${listing}`);
    if (self.name === wanted || (wanted.length >= 4 && self.id.startsWith(wanted))) throw fail(CODES.COLLAB_SELF, `You cannot ask yourself. Available: ${listing}`);
    const rules = [(p) => p.name === wanted, (p) => wanted.length >= 4 && p.id.startsWith(wanted), (p) => p.providerId === wanted];
    for (const rule of rules) {
      const hits = peers.filter(rule);
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) throw fail(CODES.AGENT_AMBIGUOUS, `"${wanted}" matches several agents; use a name. Available: ${listing}`);
    }
    throw fail(CODES.AGENT_NOT_FOUND, `No agent "${wanted}". Available: ${listing}`);
  }

  reaches(from, to) {
    const seen = new Set([from]);
    const queue = [from];
    while (queue.length) {
      const at = queue.shift();
      if (at === to) return true;
      for (const edge of this.liveAsks) {
        if (edge.askerId === at && !seen.has(edge.targetId)) {
          seen.add(edge.targetId);
          queue.push(edge.targetId);
        }
      }
    }
    return false;
  }

  async askAgent(self, params) {
    const question = requireText(params.question, LIMITS.question, 'question');
    const wait = seconds(params.wait_seconds, 600);
    const target = this.resolvePeer(self, params.agent);
    if (target.queuePaused && target.queue.length) throw fail(CODES.COLLAB_TARGET_HELD, `@${target.name}'s queued messages are paused by the user; ask again later`);
    const q = { id: randomUUID(), askerId: self.id, targetId: target.id, from: target.name, question, askedAt: new Date().toISOString(), resolved: false, delivered: false };
    let settle;
    q.done = new Promise((resolve) => (settle = resolve));
    this.questions.push(q);
    if (this.questions.length > QUESTION_KEEP) this.questions = this.questions.filter((item) => !item.delivered).slice(-QUESTION_KEEP);
    target.enqueue({
      kind: 'question',
      text: `Question from @${self.name} (another agent on this project). Answer it directly; your reply is sent back to them.\n\n${question}`,
      display: question,
      from: { type: 'agent', id: self.id, name: self.name },
      modeCap: MODE_RANK[target.mode] <= MODE_RANK[self.mode] ? target.mode : self.mode,
      resolve: (result) => {
        q.resolved = true;
        q.status = result.status;
        q.answer = result.answer ? clip(result.answer, LIMITS.answer, '\n…(answer truncated; the full text is in their transcript)') : null;
        q.error = result.error || null;
        settle();
      },
    });
    this.audit('ask_agent', { from: self.name, to: target.name, question: clip(question, 300) });
    // Two agents waiting on each other would both sit out the whole wait.
    if (this.reaches(target.id, self.id)) return { status: 'pending', questionId: q.id, from: target.name, reason: 'mutual-wait' };
    const edge = { askerId: self.id, targetId: target.id };
    this.liveAsks.push(edge);
    self.waitingOn = target.name;
    self.changed();
    try {
      const timer = new Promise((resolve) => {
        const handle = setTimeout(resolve, wait * 1000);
        handle.unref?.();
        q.done.then(() => clearTimeout(handle));
      });
      await Promise.race([q.done, timer]);
    } finally {
      this.liveAsks = this.liveAsks.filter((e) => e !== edge);
      self.waitingOn = this.liveAsks.find((e) => e.askerId === self.id) ? self.waitingOn : null;
      self.changed();
    }
    if (q.resolved) {
      q.delivered = true;
      return q.status === 'answered' ? { status: 'answered', answer: q.answer, from: q.from } : { status: 'failed', error: q.error, from: q.from };
    }
    return { status: 'pending', questionId: q.id, from: q.from };
  }

  checkAnswers(self) {
    const answers = [];
    for (const q of this.questions) {
      if (q.askerId !== self.id || q.delivered || !q.resolved) continue;
      q.delivered = true;
      answers.push(q.status === 'answered' ? { type: 'agent', questionId: q.id, from: q.from, question: q.question, status: 'answered', answer: q.answer } : { type: 'agent', questionId: q.id, from: q.from, question: q.question, status: 'failed', error: q.error });
    }
    for (const decision of [...this.decisions.values()]) {
      if (decision.agentId !== self.id || decision.status !== 'answered') continue;
      answers.push({ type: 'user', decisionId: decision.id, question: decision.question, status: 'answered', answer: decision.answer });
      this.decisions.delete(decision.id);
    }
    if (answers.length) this.save();
    return {
      answers,
      waiting: {
        agents: this.questions.filter((q) => q.askerId === self.id && !q.resolved).length,
        user: [...this.decisions.values()].filter((d) => d.agentId === self.id && d.status === 'pending').length,
      },
    };
  }

  askUser(self, params) {
    const question = requireText(params.question, LIMITS.question, 'question');
    const wait = seconds(params.wait_seconds, 1800);
    if (params.options != null && (!Array.isArray(params.options) || params.options.length > LIMITS.options)) throw fail(CODES.COLLAB_INVALID, `options must be a list of at most ${LIMITS.options}`);
    const options = (params.options || []).map((option) => requireText(option, 200, 'option'));
    const open = [...this.decisions.values()].filter((d) => d.agentId === self.id && d.status === 'pending').length;
    if (open >= LIMITS.openDecisionsPerAgent) throw fail(CODES.DECISION_LIMIT, 'Too many questions are waiting for the user; collect answers with troupe_check_answers first');
    const decision = { id: randomUUID(), agentId: self.id, agentName: self.name, question, options, askedAt: new Date().toISOString(), status: 'pending' };
    this.decisions.set(decision.id, decision);
    this.save();
    this.emit('decision.requested', { decision: publicDecision(decision) });
    self.changed();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.decisionWaiters.delete(decision.id);
        resolve({ status: 'pending', decisionId: decision.id });
      }, wait * 1000);
      timer.unref?.();
      this.decisionWaiters.set(decision.id, (value) => {
        clearTimeout(timer);
        this.decisionWaiters.delete(decision.id);
        resolve(value);
      });
    });
  }

  answerDecision({ id, answer }) {
    const decision = this.decisions.get(id);
    if (!decision || decision.status !== 'pending') throw fail(CODES.DECISION_NOT_FOUND, 'This question was already answered or withdrawn');
    const value = requireText(answer, LIMITS.boardValue, 'answer');
    const waiter = this.decisionWaiters.get(id);
    if (waiter) {
      this.decisions.delete(id);
      waiter({ status: 'answered', answer: value });
    } else {
      this.decisions.set(id, { ...decision, status: 'answered', answer: value, answeredAt: new Date().toISOString() });
    }
    this.save();
    this.audit('decision', { agent: decision.agentName, question: clip(decision.question, 300), answer: clip(value, 300) });
    this.emit('decision.resolved', { id, answer: value, delivered: Boolean(waiter) });
    const agent = this.agents.get(decision.agentId);
    if (agent) agent.changed();
    return { delivered: Boolean(waiter) };
  }

  // ── board ──────────────────────────────────────────────────────────────

  boardView() {
    const entries = this.board.entries || {};
    return { entries: Object.keys(entries).sort().map((key) => ({ key, ...entries[key] })) };
  }

  boardRead(params) {
    const entries = this.board.entries || {};
    const keys = Object.keys(entries).sort();
    if (params.key == null || params.key === '') {
      return { entries: keys.map((key) => ({ key, author: entries[key].author, at: entries[key].at, preview: oneLine(String(entries[key].value), 120), length: String(entries[key].value).length })) };
    }
    if (typeof params.key !== 'string' || !KEY.test(params.key)) throw fail(CODES.BOARD_KEY_INVALID, 'Board keys are 1-64 letters, digits or _.:- and start with a letter or digit');
    return Object.hasOwn(entries, params.key) ? { entry: { key: params.key, ...entries[params.key] } } : { entry: null, key: params.key, keys };
  }

  boardWriteAs(author, { key, value }) {
    if (typeof key !== 'string' || !KEY.test(key)) throw fail(CODES.BOARD_KEY_INVALID, 'Board keys are 1-64 letters, digits or _.:- and start with a letter or digit');
    if (typeof value !== 'string') throw fail(CODES.COLLAB_INVALID, 'The board value must be text');
    if (value.length > LIMITS.boardValue) throw fail(CODES.COLLAB_INVALID, `Board entries are limited to ${LIMITS.boardValue} characters`);
    const entries = (this.board.entries ||= {});
    const existed = Object.hasOwn(entries, key);
    if (!value.trim()) {
      if (existed) delete entries[key];
    } else {
      if (!existed && Object.keys(entries).length >= LIMITS.boardKeys) throw fail(CODES.BOARD_FULL, `The board holds at most ${LIMITS.boardKeys} entries; remove or merge old ones`);
      entries[key] = { value, author, at: new Date().toISOString() };
    }
    writeJsonAtomic(path.join(this.stateDir, 'board.json'), { schema: 1, entries });
    this.emit('board.updated', { board: this.boardView() });
    return value.trim() ? { key, saved: true, count: Object.keys(entries).length } : { key, deleted: existed, count: Object.keys(entries).length };
  }

  boardWrite({ key, value }) {
    return this.boardWriteAs('you', { key, value });
  }

  // ── diff, review, merge ────────────────────────────────────────────────

  async diff({ agent: ref }) {
    const agent = this.agentRef(ref);
    if (agent.worktree) return { agent: agent.name, isolated: true, ...(await changes({ dir: agent.worktree.path, base: agent.worktree.base, env: this.env })) };
    if (!this.project.isGit) return { agent: agent.name, isolated: false, files: [], patch: '', note: 'not a git repository' };
    const patch = await git(['diff', '--no-color', 'HEAD'], { cwd: this.project.gitRoot, env: this.env });
    return { agent: agent.name, isolated: false, files: [], patch, note: 'changes in the shared project directory (all agents and you)' };
  }

  async diffText(agent) {
    try {
      const d = await this.diff({ agent });
      return d.truncated ? `${d.patch}\n… (diff truncated)` : d.patch;
    } catch {
      return '';
    }
  }

  async askAndWait(agent, input) {
    return new Promise((resolve) => agent.enqueue({ ...input, resolve }));
  }

  async resolveReviewer(name, author) {
    const wanted = String(name || '').replace(/^@/, '').toLowerCase();
    const named = this.agentByName(wanted);
    if (named && !named.archived) {
      if (named === author) throw fail(CODES.COLLAB_SELF, `@${author.name} cannot review its own work`);
      return named;
    }
    if (!this.registry[wanted]) throw fail(CODES.AGENT_NOT_FOUND, `No agent or harness called @${wanted}`);
    const existing = [...this.agents.values()].find((a) => !a.archived && a !== author && a.providerId === wanted);
    if (existing) return existing;
    const view = await this.createAgent({ provider: wanted, mode: 'plan', isolation: 'shared' });
    return this.agents.get(view.id);
  }

  /** Asks another agent to review an agent's changes before merging. */
  async review({ agent: ref, reviewer }) {
    const author = this.agentRef(ref);
    const chosen = await this.resolveReviewer(reviewer || this.suggestReviewer(author), author);
    const diff = await this.diffText(author);
    if (!diff.trim()) return { passed: true, summary: 'no changes to review', reviewer: chosen.name, answer: '' };
    this.emit('review.started', { agentId: author.id, reviewer: chosen.name, reviewerId: chosen.id });
    const base = author.worktree?.base || this.project.branch || 'the main branch';
    const prompt = [
      `Review the changes @${author.name} (${author.provider.name}) made before they are merged into ${base}.`,
      author.worktree ? `Their worktree is ${author.worktree.path} if you need surrounding code.` : '',
      'Look for bugs, regressions, missing tests, security problems and anything that does not match the request. Do not change files.',
      'End your reply with exactly one line: "VERDICT: PASS" or "VERDICT: FAIL — <the main reason>".',
      '',
      `\`\`\`diff\n${diff}\n\`\`\``,
    ]
      .filter((line) => line !== '')
      .join('\n');
    const answer = await this.askAndWait(chosen, { kind: 'review', text: prompt, display: `Review @${author.name}'s changes before merging`, displayKey: 'review', displayParams: { name: author.name }, modeCap: 'plan', from: { type: 'user', name: 'you' } });
    if (answer.status !== 'answered') return { passed: false, summary: `review failed: ${answer.error}`, reviewer: chosen.name, answer: '' };
    const verdict = parseVerdict(answer.answer);
    this.audit('review', { author: author.name, reviewer: chosen.name, passed: verdict.passed });
    return { ...verdict, reviewer: chosen.name, answer: answer.answer };
  }

  suggestReviewer(author) {
    const other = [...this.agents.values()].find((a) => !a.archived && a !== author && a.providerId !== author.providerId);
    if (other) return other.name;
    const available = this.providersCache.find((p) => p.available && p.id !== author.providerId);
    if (available) return available.id;
    throw fail(CODES.AGENT_NOT_FOUND, 'No other agent or harness is available to review');
  }

  async merge({ agent: ref, force = false }) {
    const agent = this.agentRef(ref);
    if (!agent.worktree) throw fail(CODES.MERGE_NOTHING, `@${agent.name} works directly in the project, so its changes are already there`);
    if (agent.busy) throw fail(CODES.BUSY, `@${agent.name} is still working; wait or stop it before merging`);
    const goal = agent.goalId ? this.goals.get(agent.goalId) : null;
    const gated = Boolean(goal && !force);
    const changed = () => fail(CODES.GATE_FAILED, `@${agent.name}'s work is not the version that passed the goal checks. Run the checks again, or merge anyway with force.`);
    let passedTree = null;
    if (gated) {
      const last = [...goal.gates].reverse().find((g) => g.agent === agent.name);
      if (!last?.passed) throw fail(CODES.GATE_FAILED, `@${agent.name}'s work has not passed the goal "${goal.title}" yet. Run the checks, or merge anyway with force.`);
      passedTree = last.tree || null;
      // Fails closed: without both tree ids there is no proof the checked work is what merges.
      const now = await workingTree(agent.worktree.path, this.env).catch(() => null);
      if (!passedTree || now !== passedTree) throw changed();
    }
    try {
      await commitAll({ dir: agent.worktree.path, message: `troupe: work by @${agent.name} (${agent.provider.name})`, env: this.env });
      // A turn may have started since the check above; the branch tip must still be what passed.
      if (gated && (await git(['rev-parse', 'HEAD^{tree}'], { cwd: agent.worktree.path, env: this.env })).trim() !== passedTree) throw changed();
      const result = await mergeBranch({ root: this.project.gitRoot, branch: agent.worktree.branch, message: `Merge ${agent.worktree.branch} (@${agent.name}, ${agent.provider.name})`, env: this.env });
      agent.record({ role: 'system', code: 'merged', key: result.commits === 1 ? 'merged.one' : 'merged', params: { branch: agent.worktree.branch, target: result.target, commits: result.commits }, text: `Merged ${agent.worktree.branch} into ${result.target} (${result.commits} commit${result.commits === 1 ? '' : 's'})` });
      this.audit('merge', { agent: agent.name, branch: agent.worktree.branch, target: result.target, commit: result.commit, forced: Boolean(force && goal) });
      this.emit('merge.result', { agentId: agent.id, ok: true, result });
      await this.refreshProject();
      return result;
    } catch (error) {
      this.emit('merge.result', { agentId: agent.id, ok: false, error: serializeError(error) });
      throw error;
    }
  }

  // ── goals ──────────────────────────────────────────────────────────────

  goalById(id) {
    const goal = this.goals.get(id);
    if (!goal) throw fail(CODES.GOAL_NOT_FOUND, `No goal ${id}`);
    return goal;
  }

  writeGoal(goal) {
    this.goals.set(goal.id, goal);
    writeJsonAtomic(path.join(this.stateDir, 'goals', `${goal.id}.json`), goal, { pretty: true });
    this.emit('goal.updated', { goal });
    return goal;
  }

  goalSave({ goal }) {
    const previous = goal?.id ? this.goals.get(goal.id) || null : null;
    return this.writeGoal(normalizeGoal(goal, previous));
  }

  goalApprove({ id }) {
    const goal = approveGoal(this.goalById(id));
    this.audit('goal.approved', { goal: goal.id, revision: goal.revision });
    return this.writeGoal(goal);
  }

  goalDelete({ id }) {
    const goal = this.goalById(id);
    this.goals.delete(id);
    removeQuietly(path.join(this.stateDir, 'goals', `${id}.json`));
    for (const agent of this.agents.values()) if (agent.goalId === id) agent.goalId = null;
    this.emit('goal.updated', { goal: { ...goal, deleted: true } });
    return { deleted: true };
  }

  async goalStart({ id }) {
    const goal = this.goalById(id);
    const problems = armProblems(goal);
    if (problems.length) throw fail(CODES.GATE_NOT_ARMED, problems.map((p) => p.message).join('; '), { problems });
    const agents = [];
    for (const name of goal.assignees) {
      let agent = this.agentByName(name);
      if (agent?.archived) agent = null;
      if (!agent) {
        if (!this.registry[name]) throw fail(CODES.AGENT_NOT_FOUND, `No agent or harness called @${name}`);
        const view = await this.createAgent({ provider: name });
        agent = this.agents.get(view.id);
        if (agent.name !== name) {
          const index = goal.assignees.indexOf(name);
          goal.assignees[index] = agent.name;
        }
      }
      agents.push(agent);
    }
    const running = { ...goal, status: 'running', updatedAt: new Date().toISOString() };
    this.writeGoal(running);
    for (const agent of agents) {
      agent.goalId = goal.id;
      agent.enqueue({ kind: 'task', text: goalBrief(running), display: `Goal: ${running.title}`, displayKey: 'goal', displayParams: { title: running.title }, from: { type: 'user', name: 'you' } });
    }
    this.audit('goal.started', { goal: goal.id, agents: agents.map((a) => a.name) });
    return running;
  }

  goalPause({ id }) {
    const goal = this.goalById(id);
    return this.writeGoal({ ...goal, status: goal.approvedRevision === goal.revision ? 'approved' : 'draft', updatedAt: new Date().toISOString() });
  }

  goalConfirm({ id, criterion, confirmed = true }) {
    const goal = this.goalById(id);
    const target = goal.criteria.find((c) => c.id === criterion);
    if (!target || target.check || target.review) throw fail(CODES.GOAL_INVALID, `Criterion ${criterion} is not one the user confirms`);
    const confirmations = { ...(goal.confirmations || {}) };
    if (confirmed) confirmations[criterion] = true;
    else delete confirmations[criterion];
    return this.writeGoal({ ...goal, confirmations, updatedAt: new Date().toISOString() });
  }

  async goalCheck({ id, agent: ref = null }) {
    const goal = this.goalById(id);
    // Check commands may come from an agent's draft, so they run only once the user approved them.
    if (goal.approvedRevision !== goal.revision) throw fail(CODES.GATE_NOT_ARMED, 'Approve this revision of the goal before Troupe runs its checks');
    const agents = ref ? [this.agentRef(ref)] : goal.assignees.map((name) => this.agentByName(name)).filter(Boolean);
    if (!agents.length) throw fail(CODES.AGENT_NOT_FOUND, 'This goal has no agent to check yet');
    const gates = [];
    for (const agent of agents) gates.push(await this.runGate(agent, goal.id, { manual: true }));
    return gates;
  }

  /** Asks an agent to draft a goal for a description; the user reviews and approves it. */
  async goalDraft({ agent: ref, description }) {
    const text = requireText(description, LIMITS.question, 'description');
    let agent;
    try {
      agent = this.agentRef(ref);
    } catch {
      const view = await this.createAgent({ provider: String(ref || '').replace(/^@/, ''), mode: 'plan', isolation: 'shared' });
      agent = this.agents.get(view.id);
    }
    const others = [...this.agents.values()].filter((a) => a !== agent && !a.archived).map((a) => a.name);
    const prompt = [
      'Draft an acceptance goal for the work described below. Read the project as needed but do not change any files.',
      `Work to plan: ${text}`,
      DRAFT_INSTRUCTIONS.replace('AGENT', others[0] || 'codex'),
    ].join('\n\n');
    const answer = await this.askAndWait(agent, { kind: 'draft', text: prompt, display: `Draft a goal: ${clip(text, 120)}`, displayKey: 'draft', displayParams: { text: clip(text, 120) }, modeCap: 'plan', from: { type: 'user', name: 'you' } });
    if (answer.status !== 'answered') throw fail(CODES.PROVIDER_FAILED, `@${agent.name} could not draft the goal: ${answer.error}`);
    const draft = parseGoalDraft(answer.answer);
    // A draft is always a new goal: an id from the agent could overwrite an approved one.
    const goal = normalizeGoal({ ...draft, id: undefined, assignees: draft.assignees?.length ? draft.assignees : [agent.name] });
    return this.writeGoal(goal);
  }

  async afterTurn(agent, input) {
    if (!agent.goalId || !['task', 'feedback'].includes(input.kind)) return;
    const goal = this.goals.get(agent.goalId);
    if (!goal || goal.status !== 'running' || !goal.assignees.includes(agent.name)) return;
    await this.runGate(agent, goal.id);
  }

  async runGate(agent, goalId, { manual = false } = {}) {
    if (agent.checking) throw fail(CODES.BUSY, `@${agent.name}'s work is already being checked`);
    agent.checking = true;
    agent.changed();
    try {
      const goal = this.goalById(goalId);
      const iteration = goal.gates.filter((g) => g.agent === agent.name).length + 1;
      const tree = agent.worktree ? await workingTree(agent.worktree.path, this.env).catch(() => null) : null;
      const gate = await evaluateGate({
        goal,
        agentName: agent.name,
        cwd: agent.cwd,
        projectRoot: this.root,
        env: this.env,
        iteration,
        tree,
        review: (criterion) => this.reviewForGate(agent, goal, criterion),
        defaultTimeoutSec: this.defaults.gateTimeoutSec,
        spawnProcess: this.spawnProcess,
      });
      const latest = this.goals.get(goalId) || goal;
      const next = { ...latest, gates: [...latest.gates, gate].slice(-30), updatedAt: new Date().toISOString() };
      const failing = gate.criteria.filter((c) => !c.passed);
      agent.record({ role: 'gate', text: gate.passed ? `All ${gate.criteria.length} criteria passed` : `${failing.length} of ${gate.criteria.length} criteria not met: ${failing.map((c) => c.id).join(', ')}`, gate });
      if (gate.passed) {
        const allPassed = next.assignees.every((name) => [...next.gates].reverse().find((g) => g.agent === name)?.passed);
        if (allPassed && next.status === 'running') {
          next.status = 'met';
          this.notice('success', `Goal met: ${next.title}`, { code: 'goal-met', params: { title: next.title } });
        }
      } else if (next.status === 'running' && !manual) {
        if (iteration >= next.maxIterations) {
          next.status = 'needs-you';
          this.notice('warn', `Goal "${next.title}" still fails after ${iteration} checks; it needs you`, { code: 'goal-stuck', params: { title: next.title, n: iteration } });
        } else {
          agent.enqueue({ kind: 'feedback', text: feedbackPrompt(next, gate), display: `Check ${iteration}/${next.maxIterations}: ${failing.length} criteria not met`, displayKey: 'feedback', displayParams: { i: iteration, max: next.maxIterations, n: failing.length }, from: { type: 'troupe', name: 'troupe' } });
        }
      }
      this.writeGoal(next);
      this.emit('gate.result', { goalId, gate });
      this.audit('gate', { goal: goalId, agent: agent.name, iteration, passed: gate.passed, failing: failing.map((c) => c.id) });
      return gate;
    } finally {
      agent.checking = false;
      agent.changed();
    }
  }

  async reviewForGate(author, goal, criterion) {
    const reviewer = await this.resolveReviewer(criterion.review.by, author);
    const diff = await this.diffText(author);
    const answer = await this.askAndWait(reviewer, {
      kind: 'review',
      text: reviewPrompt({ goal, criterion, author: author.name, diff }),
      display: `Review @${author.name}'s work: ${criterion.text}`,
      displayKey: 'gate-review',
      displayParams: { name: author.name, criterion: criterion.text },
      modeCap: 'plan',
      from: { type: 'troupe', name: 'troupe' },
    });
    if (answer.status !== 'answered') return { passed: false, summary: `review failed: ${answer.error}` };
    return { ...parseVerdict(answer.answer), evidence: { reviewer: reviewer.name, answerTail: answer.answer.slice(-1500) } };
  }
}

function publicApproval({ respond, ...rest }) {
  return rest;
}

function publicDecision(decision) {
  return { id: decision.id, agentId: decision.agentId, agentName: decision.agentName, question: decision.question, options: decision.options, askedAt: decision.askedAt, status: decision.status };
}

function requireText(value, max, label) {
  if (typeof value !== 'string' || !value.trim()) throw fail(CODES.COLLAB_INVALID, `The ${label} is missing`);
  if (value.trim().length > max) throw fail(CODES.COLLAB_INVALID, `The ${label} is longer than ${max} characters`);
  return value.trim();
}

function seconds(value, fallback) {
  const n = value == null || value === '' ? fallback : Number(value);
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), LIMITS.waitSeconds) : fallback;
}

function comparePrompt(request, answers) {
  return [
    'Several coding agents answered the same request. Compare their answers for the user:',
    'where they agree, where they disagree and who is right, what each one missed, and what you recommend doing.',
    'Do not change any files.',
    '',
    `Request:\n${request}`,
    '',
    ...answers.map((a) => `--- @${a.agent} (${a.provider}) ${a.status === 'answered' ? 'answered' : `failed: ${a.error}`}\n${a.answer || ''}`),
  ].join('\n');
}
