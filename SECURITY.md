# Security policy

## Supported versions

cross-harness is before 1.0. Security fixes are made on the latest 0.x release.

## Reporting a vulnerability

Please report privately, through GitHub's private vulnerability reporting on the
`AI-BizOS/cross-harness` repository (**Security → Report a vulnerability**). Do not open a public
issue for a security problem.

Include the cross-harness version, your operating system, the harnesses involved and their
versions, the steps to reproduce and what an attacker gains. We will confirm that we
received the report, work on a fix with you and agree on when to publish. We are glad to
credit reporters who want it.

## What cross-harness protects, and what it does not

cross-harness coordinates coding agents that run as you, with your credentials. It is not a
sandbox: what an agent can do is limited by the permission modes, your answers to its
requests and the harness's own sandbox.

**In scope** — please report:

- Agent output, a repository, a mailbox file, a board entry or a goal draft that makes
  cross-harness run a command, approve a request or merge without your decision or a rule you
  set.
- Ways around the approval policy, for example an edit outside the agent's worktree
  approved automatically in `workspace` mode, or an "always allow" command rule that
  matches a chained command.
- Mailbox escapes: a request handled for another agent or twice, a symbolic link followed,
  a request accepted without its token.
- Web UI: reaching the API without the token, from another origin or another machine;
  script injection through agent text; leaking the token.
- Terminal escape sequences from agent output reaching your terminal.
- Goal or merge gates that can be passed without the evidence they require.

**Out of scope:**

- What an agent does with permissions you gave it (`full` mode, "always allow", a request
  you approved).
- Weaknesses in a harness's own sandbox or protocol; please report those to its vendor
  (we are happy to help coordinate).
- Attacks that need control of your user account or of `~/.cross-harness/config.json`, which are
  trusted.
- An agent you started using up resources, such as filling its own worktree.

## Protections in place

- **Commands.** Only the user-level `~/.cross-harness/config.json` names programs to run. A goal's
  check commands run only after you approve that exact revision of the goal.
- **Approvals.** cross-harness's own tools are recognised by tool name only. Edits are automatic
  only inside the agent's worktree, after following symbolic links, and never inside
  `.git`. Command rules look through shell wrappers and never cover chained, piped,
  redirected or substituted commands. A question from another agent runs with the lower of
  the two agents' permission modes.
- **Mailboxes.** Directories `0700`, files `0600`, a random 256-bit token per agent,
  requests claimed by rename so each runs once, symbolic links removed instead of followed,
  and a 256 KiB size limit.
- **Web UI.** Listens on a loopback address only. A random 192-bit token arrives in the URL
  fragment (never sent to the server), moves to session storage and is sent as a bearer
  header. `Host` and `Origin` are checked against DNS rebinding and cross-site requests.
  The Content-Security-Policy starts from `default-src 'none'` and allows no inline code;
  responses are not cached.
- **Untrusted text.** Escape sequences and control characters are removed from agent text
  before it is shown in a terminal; the web UI only ever inserts text nodes.
- **Processes.** Each harness runs in its own process group, and stopping an agent stops
  the whole group.
