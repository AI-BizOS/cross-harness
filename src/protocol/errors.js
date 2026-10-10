// Error codes are part of the protocol: UIs, remote clients and agents branch on
// `code`, never on the message text. spec/orchestration.md lists what each means.

export const CODES = Object.freeze({
  // Agent processes and sessions
  START_FAILED: 'CROSS_HARNESS_START_FAILED',
  PROCESS_EXITED: 'CROSS_HARNESS_PROCESS_EXITED',
  CLOSED: 'CROSS_HARNESS_CLOSED',
  TIMEOUT: 'CROSS_HARNESS_TIMEOUT',
  CANCELLED: 'CROSS_HARNESS_CANCELLED',
  BUSY: 'CROSS_HARNESS_BUSY',
  PROMPT_INVALID: 'CROSS_HARNESS_PROMPT_INVALID',
  SESSION_INVALID: 'CROSS_HARNESS_SESSION_INVALID',
  SESSION_UNKNOWN: 'CROSS_HARNESS_SESSION_UNKNOWN',
  AUTH_REQUIRED: 'CROSS_HARNESS_AUTH_REQUIRED',
  PROVIDER_FAILED: 'CROSS_HARNESS_PROVIDER_FAILED',
  PROVIDER_UNAVAILABLE: 'CROSS_HARNESS_PROVIDER_UNAVAILABLE',
  PROVIDER_UNKNOWN: 'CROSS_HARNESS_PROVIDER_UNKNOWN',
  VERSION_UNSUPPORTED: 'CROSS_HARNESS_VERSION_UNSUPPORTED',
  RPC_ERROR: 'CROSS_HARNESS_RPC_ERROR',
  RPC_UNSUPPORTED: 'CROSS_HARNESS_RPC_UNSUPPORTED',
  OUTPUT_INVALID: 'CROSS_HARNESS_OUTPUT_INVALID',
  MCP_INVALID: 'CROSS_HARNESS_MCP_INVALID',
  PERMISSION_INVALID: 'CROSS_HARNESS_PERMISSION_INVALID',
  PLAN_DENIED: 'CROSS_HARNESS_PLAN_DENIED',
  // Agents and dispatch
  AGENT_NOT_FOUND: 'CROSS_HARNESS_AGENT_NOT_FOUND',
  AGENT_AMBIGUOUS: 'CROSS_HARNESS_AGENT_AMBIGUOUS',
  AGENT_EXISTS: 'CROSS_HARNESS_AGENT_EXISTS',
  NAME_INVALID: 'CROSS_HARNESS_NAME_INVALID',
  NO_TARGET: 'CROSS_HARNESS_NO_TARGET',
  SLOT_LIMIT: 'CROSS_HARNESS_SLOT_LIMIT',
  // Collaboration
  COLLAB_INVALID: 'CROSS_HARNESS_COLLAB_INVALID',
  COLLAB_UNAVAILABLE: 'CROSS_HARNESS_COLLAB_UNAVAILABLE',
  COLLAB_SELF: 'CROSS_HARNESS_COLLAB_SELF',
  COLLAB_TARGET_HELD: 'CROSS_HARNESS_COLLAB_TARGET_HELD',
  BOARD_KEY_INVALID: 'CROSS_HARNESS_BOARD_KEY_INVALID',
  BOARD_FULL: 'CROSS_HARNESS_BOARD_FULL',
  DECISION_LIMIT: 'CROSS_HARNESS_DECISION_LIMIT',
  DECISION_NOT_FOUND: 'CROSS_HARNESS_DECISION_NOT_FOUND',
  APPROVAL_NOT_FOUND: 'CROSS_HARNESS_APPROVAL_NOT_FOUND',
  APPROVAL_INVALID: 'CROSS_HARNESS_APPROVAL_INVALID',
  // Git, merge and gates
  NOT_GIT: 'CROSS_HARNESS_NOT_GIT',
  WORKTREE_FAILED: 'CROSS_HARNESS_WORKTREE_FAILED',
  MERGE_DIRTY: 'CROSS_HARNESS_MERGE_DIRTY',
  MERGE_CONFLICT: 'CROSS_HARNESS_MERGE_CONFLICT',
  MERGE_NOTHING: 'CROSS_HARNESS_MERGE_NOTHING',
  MERGE_FAILED: 'CROSS_HARNESS_MERGE_FAILED',
  GATE_FAILED: 'CROSS_HARNESS_GATE_FAILED',
  GATE_NOT_ARMED: 'CROSS_HARNESS_GATE_NOT_ARMED',
  GOAL_INVALID: 'CROSS_HARNESS_GOAL_INVALID',
  GOAL_NOT_FOUND: 'CROSS_HARNESS_GOAL_NOT_FOUND',
  // Engine and transport
  LOCKED: 'CROSS_HARNESS_LOCKED',
  METHOD_UNKNOWN: 'CROSS_HARNESS_METHOD_UNKNOWN',
  ARGUMENT_INVALID: 'CROSS_HARNESS_ARGUMENT_INVALID',
  UNAUTHORIZED: 'CROSS_HARNESS_UNAUTHORIZED',
});

export class CrossHarnessError extends Error {
  /**
   * @param {string} code one of CODES
   * @param {string} message human readable, may be shown to users or agents
   * @param {Record<string, unknown>} [details] structured extras (exitCode, files, ...)
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'CrossHarnessError';
    this.code = code;
    if (details) for (const [key, value] of Object.entries(details)) if (value !== undefined) this[key] = value;
  }
}

/** @returns {CrossHarnessError} */
export function fail(code, message, details) {
  return new CrossHarnessError(code, message, details);
}

/** A plain, serialisable view of any error for events, RPC replies and logs. */
export function serializeError(error) {
  if (!error) return null;
  const out = { code: error.code || 'CROSS_HARNESS_INTERNAL', message: String(error.message || error) };
  for (const key of ['files', 'exitCode', 'signal', 'rpcCode', 'method', 'stderr', 'reason']) {
    if (error[key] !== undefined) out[key] = key === 'stderr' ? String(error[key]).slice(-2000) : error[key];
  }
  return out;
}

export function isCancelled(error) {
  return error?.code === CODES.CANCELLED || error?.name === 'AbortError';
}
