// Known coding-agent harnesses and how Troupe talks to each. `verified` means the
// invocation and protocol handshake were checked against a real install (2026-10-09:
// codex 0.159.1 app-server, opencode, kimi and dsh over ACP); the others follow the
// vendor's documentation and are labelled "untested" until someone confirms them.
// Users add or override entries in ~/.troupe/config.json (see docs/providers.md).
import { CODES, fail } from '../protocol/errors.js';
import { PERMISSION_MODES, SESSION_PROTOCOLS } from '../protocol/index.js';

const ALL_MODES = PERMISSION_MODES;

export const BUILTIN_PROVIDERS = Object.freeze({
  claude: {
    id: 'claude',
    name: 'Claude Code',
    vendor: 'Anthropic',
    command: 'claude',
    protocol: 'claude-stream',
    rank: 1,
    // stream-json is Claude Code's documented SDK transport; not yet exercised by Troupe against a real install.
    verified: false,
    writes: true,
    modes: ALL_MODES,
    install: 'npm install -g @anthropic-ai/claude-code',
    signIn: 'Run `claude` once and sign in',
  },
  codex: {
    id: 'codex',
    name: 'Codex',
    vendor: 'OpenAI',
    command: 'codex',
    protocol: 'codex-app',
    rank: 2,
    verified: true,
    writes: true,
    modes: ALL_MODES,
    install: 'npm install -g @openai/codex',
    signIn: 'Run `codex login`',
  },
  opencode: {
    id: 'opencode',
    name: 'OpenCode',
    vendor: 'OpenCode',
    command: 'opencode',
    protocol: 'acp',
    args: ['acp'],
    rank: 3,
    verified: true,
    writes: true,
    modes: ALL_MODES,
    install: 'npm install -g opencode-ai',
    signIn: 'Run `opencode auth login`',
  },
  kimi: {
    id: 'kimi',
    name: 'Kimi Code',
    vendor: 'Moonshot AI',
    command: 'kimi',
    protocol: 'acp',
    args: ['acp'],
    rank: 4,
    verified: true,
    writes: true,
    modes: ALL_MODES,
    signIn: 'Run `kimi` once and sign in',
  },
  dsh: {
    id: 'dsh',
    name: 'DeepSeek Harness',
    vendor: 'DeepSeek',
    command: 'dsh',
    protocol: 'acp',
    args: ['--profile', 'acp'],
    rank: 5,
    verified: true,
    writes: true,
    modes: ALL_MODES,
    signIn: 'Run `dsh` once and sign in',
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini CLI',
    vendor: 'Google',
    command: 'gemini',
    protocol: 'acp',
    args: ['--experimental-acp'],
    rank: 6,
    verified: false,
    writes: true,
    modes: ALL_MODES,
    install: 'npm install -g @google/gemini-cli',
    signIn: 'Run `gemini` once and sign in',
  },
  qwen: {
    id: 'qwen',
    name: 'Qwen Code',
    vendor: 'Alibaba',
    command: 'qwen',
    protocol: 'acp',
    args: ['--experimental-acp'],
    rank: 7,
    verified: false,
    writes: true,
    modes: ALL_MODES,
    install: 'npm install -g @qwen-code/qwen-code',
  },
  copilot: {
    id: 'copilot',
    name: 'Copilot CLI',
    vendor: 'GitHub',
    command: 'copilot',
    protocol: 'acp',
    args: ['--acp'],
    rank: 8,
    verified: false,
    writes: true,
    modes: ALL_MODES,
    install: 'npm install -g @github/copilot',
  },
  goose: {
    id: 'goose',
    name: 'Goose',
    vendor: 'Block',
    command: 'goose',
    protocol: 'acp',
    args: ['acp'],
    rank: 9,
    verified: false,
    writes: true,
    modes: ALL_MODES,
  },
  cursor: {
    id: 'cursor',
    name: 'Cursor Agent',
    vendor: 'Cursor',
    command: 'cursor-agent',
    protocol: 'acp',
    args: ['acp'],
    rank: 10,
    verified: false,
    writes: true,
    modes: ALL_MODES,
  },
  amp: {
    id: 'amp',
    name: 'Amp',
    vendor: 'Sourcegraph',
    command: 'amp',
    protocol: 'exec',
    exec: { args: ['-x', '{prompt}'] },
    rank: 11,
    verified: false,
    writes: true,
    modes: ['full'],
  },
  aider: {
    id: 'aider',
    name: 'Aider',
    vendor: 'Aider',
    command: 'aider',
    protocol: 'exec',
    exec: { args: ['--yes-always', '--no-pretty', '--message', '{prompt}'], modelArgs: ['--model', '{model}'] },
    rank: 12,
    verified: false,
    writes: true,
    modes: ['full'],
  },
});

const ID = /^[a-z][a-z0-9-]{0,31}$/;

// One-shot CLIs act without asking, so by default they get only the modes their
// definition maps to flags.
function defaultModes(entry) {
  if (entry.protocol !== 'exec') return ALL_MODES;
  return ALL_MODES.filter((mode) => mode === 'full' || Array.isArray(entry.exec?.modeArgs?.[mode]));
}
const FIELDS = ['name', 'vendor', 'command', 'protocol', 'args', 'rank', 'verified', 'writes', 'modes', 'install', 'signIn', 'exec', 'env', 'strictMcp', 'versionArgs'];

/** Validates one provider definition (built-in, user config, or merged override). */
export function validateProvider(provider) {
  const problems = [];
  if (!ID.test(provider.id || '')) problems.push('id must be lowercase letters, digits or dashes');
  if (typeof provider.name !== 'string' || !provider.name.trim()) problems.push('name is required');
  if (typeof provider.command !== 'string' || !provider.command.trim()) problems.push('command is required');
  if (!SESSION_PROTOCOLS.includes(provider.protocol)) problems.push(`protocol must be one of ${SESSION_PROTOCOLS.join(', ')}`);
  if (provider.args !== undefined && !(Array.isArray(provider.args) && provider.args.every((arg) => typeof arg === 'string'))) problems.push('args must be a list of strings');
  if (provider.modes !== undefined && !(Array.isArray(provider.modes) && provider.modes.every((mode) => ALL_MODES.includes(mode)))) problems.push('modes must list permission modes');
  if (provider.protocol === 'exec' && !(Array.isArray(provider.exec?.args) && provider.exec.args.includes('{prompt}'))) problems.push('exec.args must contain "{prompt}"');
  if (provider.env !== undefined && !(provider.env && typeof provider.env === 'object' && Object.values(provider.env).every((value) => typeof value === 'string'))) problems.push('env must map names to strings');
  if (problems.length) throw fail(CODES.ARGUMENT_INVALID, `Provider "${provider.id}": ${problems.join('; ')}`);
  return provider;
}

/**
 * Built-ins merged with user definitions. A user entry with a built-in id overrides
 * only the fields it names; a new id must be a complete definition.
 * @param {Record<string, object>} [custom]
 * @returns {Record<string, object>}
 */
export function buildRegistry(custom = {}, { builtins = true } = {}) {
  const registry = {};
  if (builtins) for (const [id, provider] of Object.entries(BUILTIN_PROVIDERS)) registry[id] = { ...provider, builtin: true };
  for (const [id, entry] of Object.entries(custom || {})) {
    if (!entry || typeof entry !== 'object') continue;
    const picked = Object.fromEntries(FIELDS.filter((key) => entry[key] !== undefined).map((key) => [key, entry[key]]));
    const merged = registry[id] ? { ...registry[id], ...picked, id, custom: true } : { rank: 50, verified: false, writes: true, modes: defaultModes(picked), ...picked, id, custom: true, builtin: false };
    registry[id] = validateProvider(merged);
  }
  return registry;
}

export function providerList(registry) {
  return Object.values(registry).sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || a.id.localeCompare(b.id));
}
