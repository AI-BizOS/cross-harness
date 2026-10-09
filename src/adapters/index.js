// Picks the session adapter for a provider's protocol. Every adapter exposes the
// same shape (spec/agent-session.md):
//   start({sessionId, model, permissionMode, mcpServers, onEvent}) -> {sessionId, resumed}
//   prompt(text, {signal}) -> {text, stopReason, usage}
//   steer(text) -> boolean, cancel() -> boolean, close()
//   alive, pid, sessionId, stderr
import { CODES, fail } from '../protocol/errors.js';
import { createAcpSession } from './acp.js';
import { createCodexSession } from './codex.js';
import { createClaudeSession } from './claude.js';
import { createExecSession } from './exec.js';

export const ADAPTERS = Object.freeze({
  acp: createAcpSession,
  'codex-app': createCodexSession,
  'claude-stream': createClaudeSession,
  exec: createExecSession,
});

/**
 * @param {object} provider a registry entry (see src/providers/registry.js)
 * @param {{binary:string, cwd:string, env?:NodeJS.ProcessEnv, spawnProcess?:Function}} options
 */
export function createSession(provider, { binary, cwd, env, spawnProcess }) {
  const factory = ADAPTERS[provider.protocol];
  if (!factory) throw fail(CODES.PROVIDER_UNKNOWN, `Unknown session protocol "${provider.protocol}" for ${provider.name}`);
  return factory({
    binary,
    args: provider.args || [],
    env,
    cwd,
    label: provider.name,
    exec: provider.exec,
    strictMcp: provider.strictMcp,
    spawnProcess,
  });
}

export { createAcpSession, createCodexSession, createClaudeSession, createExecSession };
