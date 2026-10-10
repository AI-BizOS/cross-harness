// Client-side state: an engine snapshot kept current by engine events. Shared by
// the terminal UI and the web UI (which loads this file as-is), so no Node imports.

const MAX_TRANSCRIPT = 1000;
const MAX_NOTICES = 50;

export function createStore() {
  const state = {
    seq: 0,
    version: '',
    protocol: '',
    project: null,
    defaults: {},
    agents: new Map(),
    order: [],
    approvals: new Map(),
    decisions: new Map(),
    board: { entries: [] },
    goals: new Map(),
    providers: [],
    transcripts: new Map(),
    loaded: new Set(),
    live: new Map(),
    notices: [],
    lastMerge: null,
  };

  function live(agentId) {
    let entry = state.live.get(agentId);
    if (!entry) {
      entry = { text: '', activities: new Map(), plan: [], turnStartedAt: null };
      state.live.set(agentId, entry);
    }
    return entry;
  }

  function putAgent(view) {
    if (!state.agents.has(view.id)) state.order.push(view.id);
    state.agents.set(view.id, view);
    const running = view.state === 'running' || view.state === 'starting';
    if (!running) {
      state.live.delete(view.id);
    } else {
      const entry = live(view.id);
      if (view.turnStartedAt && entry.turnStartedAt !== view.turnStartedAt) {
        entry.turnStartedAt = view.turnStartedAt;
        entry.text = view.text || '';
        entry.activities = new Map();
      }
      if (view.text && !entry.text) entry.text = view.text;
      entry.plan = view.plan || entry.plan;
    }
  }

  function appendMessage(agentId, entry) {
    const list = state.transcripts.get(agentId) || [];
    if (!list.some((item) => item.id === entry.id)) list.push(entry);
    if (list.length > MAX_TRANSCRIPT) list.splice(0, list.length - MAX_TRANSCRIPT);
    state.transcripts.set(agentId, list);
  }

  function notice(level, text, extra = {}) {
    state.notices.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, level, text, at: Date.now(), ...extra });
    if (state.notices.length > MAX_NOTICES) state.notices.splice(0, state.notices.length - MAX_NOTICES);
  }

  return {
    state,

    applySnapshot(snapshot) {
      state.seq = snapshot.seq || 0;
      state.version = snapshot.version || '';
      state.protocol = snapshot.protocol || '';
      state.project = snapshot.project || null;
      state.defaults = snapshot.defaults || {};
      state.agents = new Map();
      state.order = [];
      for (const view of snapshot.agents || []) putAgent(view);
      state.approvals = new Map((snapshot.approvals || []).map((a) => [a.id, a]));
      state.decisions = new Map((snapshot.decisions || []).map((d) => [d.id, d]));
      state.board = snapshot.board || { entries: [] };
      state.goals = new Map((snapshot.goals || []).map((g) => [g.id, g]));
      state.providers = snapshot.providers || [];
    },

    /** Applies one engine event; returns false for events older than the snapshot. */
    applyEvent(event) {
      if (!event || typeof event !== 'object') return false;
      if (event.seq && event.seq <= state.seq) return false;
      if (event.seq) state.seq = event.seq;
      switch (event.type) {
        case 'agent.updated':
          putAgent(event.agent);
          break;
        case 'agent.removed':
          state.agents.delete(event.agentId);
          state.order = state.order.filter((id) => id !== event.agentId);
          break;
        case 'agent.message':
          appendMessage(event.agentId, event.entry);
          break;
        case 'agent.text':
          live(event.agentId).text = event.text;
          break;
        case 'agent.activity':
          live(event.agentId).activities.set(event.activity.id, event.activity);
          break;
        case 'agent.plan':
          live(event.agentId).plan = event.entries;
          break;
        case 'approval.requested':
          state.approvals.set(event.approval.id, event.approval);
          break;
        case 'approval.resolved':
          state.approvals.delete(event.id);
          break;
        case 'decision.requested':
          state.decisions.set(event.decision.id, event.decision);
          break;
        case 'decision.resolved':
          state.decisions.delete(event.id);
          break;
        case 'board.updated':
          state.board = event.board;
          break;
        case 'goal.updated':
          if (event.goal.deleted) state.goals.delete(event.goal.id);
          else state.goals.set(event.goal.id, event.goal);
          break;
        case 'gate.result':
          break;
        case 'merge.result':
          state.lastMerge = event;
          break;
        case 'review.started':
          break;
        case 'notice':
          notice(event.level, event.text, { agentId: event.agentId || null });
          break;
        case 'project.updated':
          if (event.project) state.project = event.project;
          if (event.providers) state.providers = event.providers;
          break;
        default:
          return false;
      }
      return true;
    },

    /** Merges a fetched transcript with entries that arrived as events meanwhile. */
    setTranscript(agentId, entries) {
      const byId = new Map((entries || []).map((e) => [e.id, e]));
      for (const e of state.transcripts.get(agentId) || []) byId.set(e.id, e);
      const list = [...byId.values()].sort((a, b) => String(a.at).localeCompare(String(b.at)));
      state.transcripts.set(agentId, list.slice(-MAX_TRANSCRIPT));
      state.loaded.add(agentId);
    },

    notice,

    agents({ archived = false } = {}) {
      return state.order.map((id) => state.agents.get(id)).filter((a) => a && (archived || a.state !== 'archived'));
    },

    agentByName(name) {
      const wanted = String(name || '').replace(/^@/, '').toLowerCase();
      for (const agent of state.agents.values()) if (agent.name === wanted) return agent;
      return null;
    },

    /** Approvals and questions from agents to the user, oldest first. */
    waiting() {
      const items = [
        ...[...state.approvals.values()].map((a) => ({ type: 'approval', at: a.at, item: a })),
        ...[...state.decisions.values()].map((d) => ({ type: 'decision', at: d.askedAt, item: d })),
      ];
      return items.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    },

    counts() {
      const agents = this.agents();
      return {
        agents: agents.length,
        working: agents.filter((a) => a.state === 'running' || a.state === 'starting' || a.checking).length,
        waiting: state.approvals.size + state.decisions.size,
      };
    },

    goals() {
      return [...state.goals.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    },

    activeGoal() {
      return this.goals().find((g) => g.status === 'running' || g.status === 'needs-you') || null;
    },
  };
}

/** The last gate result for one agent on a goal. */
export function lastGate(goal, agentName) {
  if (!goal?.gates) return null;
  for (let i = goal.gates.length - 1; i >= 0; i--) if (!agentName || goal.gates[i].agent === agentName) return goal.gates[i];
  return null;
}
