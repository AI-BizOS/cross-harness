// Who answers an agent's permission request (spec/orchestration.md §Approvals).
//   reads and searches          always allowed
//   Troupe's own tools          always allowed (matched by tool name, never by arguments)
//   full                        everything allowed
//   plan                        everything else denied
//   edits outside the agent's   asked, whatever the rules say
//   directory or inside .git
//   workspace                   other edits allowed, commands asked
//   ask                         edits and commands asked
// "Always allow" from the user adds a rule for that agent only.
import fs from 'node:fs';
import path from 'node:path';
import { MODE_RANK } from '../protocol/index.js';

// The tool name starts the title; harnesses prefix MCP tools with the server name.
const OWN_TOOL = /^(?:mcp__troupe__|troupe(?:__|[_.:/]))?troupe_(?:list_agents|ask_agent|check_answers|ask_user|board_read|board_write|report_progress|goal_status)(?![\w-])/;
// Some harnesses report commands wrapped in a shell (`bash -lc '…'`); rules apply to the script.
const SHELL_WRAPPER = /^(?:\S*\/)?(?:ba|z|da|k)?sh\s+-l?c\s+/;
// A command rule never covers chained, piped, redirected or substituted commands.
const COMPOUND = /[;&|`$<>()\n\r]/;

/** The lower of two permission modes. */
export function capMode(mode, cap) {
  if (!cap) return mode;
  return MODE_RANK[cap] < MODE_RANK[mode] ? cap : mode;
}

export function innerCommand(command) {
  let text = String(command || '').trim();
  const wrapper = SHELL_WRAPPER.exec(text);
  if (wrapper) {
    text = text.slice(wrapper[0].length).trim();
    const quoted = /^'([^']*)'$/.exec(text) || /^"([^"\\$`]*)"$/.exec(text);
    if (quoted) text = quoted[1].trim();
  }
  return text;
}

// The real path of the deepest existing ancestor, followed by the parts not created yet.
function realPath(file) {
  const rest = [];
  let current = file;
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...rest);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return file;
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** True when every path is inside `root`, after following symbolic links, and outside any .git directory. */
export function insideRoot(paths, root) {
  if (!root || !Array.isArray(paths) || !paths.length) return false;
  const base = realPath(path.resolve(root));
  return paths.every((file) => {
    if (typeof file !== 'string' || !file || file.includes('\0')) return false;
    const relative = path.relative(base, realPath(path.resolve(root, file)));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
    // Case-insensitive file systems (macOS, Windows) also open .git as .GIT.
    return !relative.split(path.sep).some((part) => part.toLowerCase() === '.git');
  });
}

/** The rule key "always allow" stores: edits as a kind, commands by their first two words. */
export function ruleFor(request) {
  if (request.kind === 'edit') return { kind: 'edit' };
  if (request.kind === 'command' && request.command) {
    const head = innerCommand(request.command).split(/\s+/).slice(0, 2).join(' ');
    return { kind: 'command', prefix: head };
  }
  return { kind: request.kind, title: request.title };
}

export function matchesRule(rule, request) {
  if (rule.kind !== request.kind) return false;
  if (rule.kind === 'edit') return true;
  if (rule.kind === 'command') {
    const command = innerCommand(request.command);
    if (!rule.prefix || COMPOUND.test(command)) return false;
    return command === rule.prefix || command.startsWith(`${rule.prefix} `);
  }
  return rule.title === request.title;
}

/**
 * @param {{mode:string, request:{kind:string, title?:string, command?:string, detail?:string, paths?:string[]}, rules?:object[], root?:string|null}} input
 *   `root` is the directory the agent may edit without asking (its worktree).
 * @returns {'allow'|'deny'|'ask'}
 */
export function decide({ mode, request, rules = [], root = null }) {
  if (request.kind === 'read' || request.kind === 'search') return 'allow';
  if (request.kind === 'tool' && OWN_TOOL.test(request.title || '')) return 'allow';
  if (mode === 'full') return 'allow';
  if (mode === 'plan') return 'deny';
  if (request.kind === 'edit' && !insideRoot(request.paths, root)) return 'ask';
  if (rules.some((rule) => matchesRule(rule, request))) return 'allow';
  if (mode === 'workspace' && request.kind === 'edit') return 'allow';
  return 'ask';
}
