// The cross-harness cross-harness protocol, version cross-harness/1. The normative description
// lives in spec/; this module holds the constants and shapes the reference
// implementation and its clients share.

export { CODES, CrossHarnessError, fail, serializeError, isCancelled } from './errors.js';

export const PROTOCOL_VERSION = 'cross-harness/1';

/**
 * Permission modes, from most to least restricted. An agent never runs above the
 * mode it was given, and an agent asked a question by another agent answers with
 * the lower of the two modes.
 */
export const PERMISSION_MODES = Object.freeze(['plan', 'ask', 'workspace', 'full']);
export const MODE_RANK = Object.freeze({ plan: 0, ask: 1, workspace: 2, full: 3 });

/** What an agent is doing in one step of a turn. */
export const ACTIVITY_KINDS = Object.freeze(['command', 'edit', 'read', 'search', 'thinking', 'tool']);
export const ACTIVITY_STATUS = Object.freeze(['running', 'done', 'failed']);

/** Answers to an approval request. `cancel` is internal: the turn is being stopped. */
export const APPROVAL_OPTIONS = Object.freeze(['allow_once', 'allow_always', 'deny']);

/** Agent lifecycle as shown to users. `needsYou` and `waitingOn` are separate flags. */
export const AGENT_STATES = Object.freeze(['idle', 'starting', 'running', 'stopped', 'failed', 'offline', 'archived']);

/** Live adapter protocols a harness can speak. */
export const SESSION_PROTOCOLS = Object.freeze(['acp', 'codex-app', 'claude-stream', 'exec']);

/**
 * Events an adapter session emits while it runs (spec/agent-session.md).
 * @typedef {{type:'session', sessionId:string}} SessionEvent
 * @typedef {{type:'text', text:string}} TextEvent  Snapshot of the answer so far.
 * @typedef {{type:'activity', id:string, kind:string, title:string, status:string, detail?:string}} ActivityEvent
 * @typedef {{type:'plan', entries:{content:string,status:string}[]}} PlanEvent
 * @typedef {{type:'usage', usage:Record<string, number>}} UsageEvent
 * @typedef {{type:'approval', id:string, kind:'command'|'edit'|'tool'|'read'|'search', title:string, detail?:string,
 *   command?:string, options:string[], respond:(choice:string)=>boolean}} ApprovalEvent
 * @typedef {SessionEvent|TextEvent|ActivityEvent|PlanEvent|UsageEvent|ApprovalEvent} AgentSessionEvent
 */

/**
 * Engine events delivered to user interfaces and remote clients. Each carries a
 * monotonically increasing `seq` so a client can tell whether it missed any.
 */
export const ENGINE_EVENTS = Object.freeze([
  'agent.updated', // full public view of one agent
  'agent.removed',
  'agent.message', // one transcript entry appended
  'agent.text', // streaming answer snapshot for the running turn
  'agent.activity',
  'agent.plan',
  'approval.requested',
  'approval.resolved',
  'decision.requested',
  'decision.resolved',
  'board.updated',
  'goal.updated',
  'gate.result',
  'merge.result',
  'notice', // a one-line message for the status area
  'project.updated',
]);

export const LIMITS = Object.freeze({
  prompt: 200_000,
  question: 20_000,
  answer: 40_000,
  boardValue: 16_000,
  boardKeys: 128,
  status: 200,
  options: 6,
  waitSeconds: 1800,
  openDecisionsPerAgent: 8,
  openQuestionsPerAgent: 32,
  mailboxRequestBytes: 256 * 1024,
  transcriptEntries: 2000,
});
