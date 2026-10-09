// Error codes are part of the protocol: UIs, remote clients and agents branch on
// `code`, never on the message text. spec/orchestration.md lists what each means.

export const CODES = Object.freeze({
  // Agent processes and sessions
  START_FAILED: 'TROUPE_START_FAILED',
  PROCESS_EXITED: 'TROUPE_PROCESS_EXITED',
  CLOSED: 'TROUPE_CLOSED',
  TIMEOUT: 'TROUPE_TIMEOUT',
  CANCELLED: 'TROUPE_CANCELLED',
  BUSY: 'TROUPE_BUSY',
  PROMPT_INVALID: 'TROUPE_PROMPT_INVALID',
  SESSION_INVALID: 'TROUPE_SESSION_INVALID',
  SESSION_UNKNOWN: 'TROUPE_SESSION_UNKNOWN',
  AUTH_REQUIRED: 'TROUPE_AUTH_REQUIRED',
  PROVIDER_FAILED: 'TROUPE_PROVIDER_FAILED',
  PROVIDER_UNAVAILABLE: 'TROUPE_PROVIDER_UNAVAILABLE',
  PROVIDER_UNKNOWN: 'TROUPE_PROVIDER_UNKNOWN',
  VERSION_UNSUPPORTED: 'TROUPE_VERSION_UNSUPPORTED',
  RPC_ERROR: 'TROUPE_RPC_ERROR',
  RPC_UNSUPPORTED: 'TROUPE_RPC_UNSUPPORTED',
  OUTPUT_INVALID: 'TROUPE_OUTPUT_INVALID',
  MCP_INVALID: 'TROUPE_MCP_INVALID',
  PERMISSION_INVALID: 'TROUPE_PERMISSION_INVALID',
  PLAN_DENIED: 'TROUPE_PLAN_DENIED',
  // Agents and dispatch
  AGENT_NOT_FOUND: 'TROUPE_AGENT_NOT_FOUND',
  AGENT_AMBIGUOUS: 'TROUPE_AGENT_AMBIGUOUS',
  AGENT_EXISTS: 'TROUPE_AGENT_EXISTS',
  NAME_INVALID: 'TROUPE_NAME_INVALID',
  NO_TARGET: 'TROUPE_NO_TARGET',
  SLOT_LIMIT: 'TROUPE_SLOT_LIMIT',
  // Collaboration
  COLLAB_INVALID: 'TROUPE_COLLAB_INVALID',
  COLLAB_UNAVAILABLE: 'TROUPE_COLLAB_UNAVAILABLE',
  COLLAB_SELF: 'TROUPE_COLLAB_SELF',
  COLLAB_TARGET_HELD: 'TROUPE_COLLAB_TARGET_HELD',
  BOARD_KEY_INVALID: 'TROUPE_BOARD_KEY_INVALID',
  BOARD_FULL: 'TROUPE_BOARD_FULL',
  DECISION_LIMIT: 'TROUPE_DECISION_LIMIT',
  DECISION_NOT_FOUND: 'TROUPE_DECISION_NOT_FOUND',
  APPROVAL_NOT_FOUND: 'TROUPE_APPROVAL_NOT_FOUND',
  APPROVAL_INVALID: 'TROUPE_APPROVAL_INVALID',
  // Git, merge and gates
  NOT_GIT: 'TROUPE_NOT_GIT',
  WORKTREE_FAILED: 'TROUPE_WORKTREE_FAILED',
  MERGE_DIRTY: 'TROUPE_MERGE_DIRTY',
  MERGE_CONFLICT: 'TROUPE_MERGE_CONFLICT',
  MERGE_NOTHING: 'TROUPE_MERGE_NOTHING',
  MERGE_FAILED: 'TROUPE_MERGE_FAILED',
  GATE_FAILED: 'TROUPE_GATE_FAILED',
  GATE_NOT_ARMED: 'TROUPE_GATE_NOT_ARMED',
  GOAL_INVALID: 'TROUPE_GOAL_INVALID',
  GOAL_NOT_FOUND: 'TROUPE_GOAL_NOT_FOUND',
  // Engine and transport
  LOCKED: 'TROUPE_LOCKED',
  METHOD_UNKNOWN: 'TROUPE_METHOD_UNKNOWN',
  ARGUMENT_INVALID: 'TROUPE_ARGUMENT_INVALID',
  UNAUTHORIZED: 'TROUPE_UNAUTHORIZED',
});

export class TroupeError extends Error {
  /**
   * @param {string} code one of CODES
   * @param {string} message human readable, may be shown to users or agents
   * @param {Record<string, unknown>} [details] structured extras (exitCode, files, ...)
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'TroupeError';
    this.code = code;
    if (details) for (const [key, value] of Object.entries(details)) if (value !== undefined) this[key] = value;
  }
}

/** @returns {TroupeError} */
export function fail(code, message, details) {
  return new TroupeError(code, message, details);
}

/** A plain, serialisable view of any error for events, RPC replies and logs. */
export function serializeError(error) {
  if (!error) return null;
  const out = { code: error.code || 'TROUPE_INTERNAL', message: String(error.message || error) };
  for (const key of ['files', 'exitCode', 'signal', 'rpcCode', 'method', 'stderr', 'reason']) {
    if (error[key] !== undefined) out[key] = key === 'stderr' ? String(error[key]).slice(-2000) : error[key];
  }
  return out;
}

export function isCancelled(error) {
  return error?.code === CODES.CANCELLED || error?.name === 'AbortError';
}
