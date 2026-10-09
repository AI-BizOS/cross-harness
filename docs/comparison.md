# How Troupe compares

Several tools run more than one coding agent at a time. This page compares Troupe with two
of them, Orca and Mirasim, by features and approach, to help you pick the right one. It
reflects their public material and their desktop apps as available in October 2026 (Orca
1.4.212). Both change quickly: check their own documentation, and please tell us where
this page is out of date or wrong.

## In a paragraph

**Orca** is a desktop workspace (Electron) built around terminals. Each agent runs in its
own terminal session, kept alive by a background service, and Orca follows its status
through the agent CLI's hooks; an experimental chat view talks to Claude Code and Codex
through their SDK and app server. Around the terminals it offers an editor, a browser,
task boards, pull-request and CI views, scheduled automations, usage statistics, session
search, plugins and a mobile companion. Agents coordinate through an `orca` command with
coordinator and worker roles and a mailbox, and work comes back through commits and pull
requests.

**Mirasim** is a desktop app (Electron with a local host process) that starts agent CLIs
through their structured protocols — Claude Code's stream-json, Codex's app server, Kimi
over ACP, Pi over RPC — or in a terminal with hooks. Each agent gets an MCP endpoint for
artifacts, questions to the user and messages to other sessions. Its goal room takes a
goal through alignment, review and arming before it runs, with gates for a testable
criterion, no open decisions, approval of the current revision and independent evidence;
progress is judged by a hosted model. It also offers remote and cloud hosts, phone and
chat-app channels, and usage tracking.

**Troupe** is a protocol with a small reference implementation: a terminal UI, a local web
UI and a command for scripts. Every agent runs through its vendor's session protocol.
Troupe answers permission requests for all of them in one queue, gives each agent its own
git worktree, lets agents question each other through MCP tools carried by files, and
gathers its own evidence for a goal — commands it runs in the agent's worktree and reviews
by a different agent — before it merges locally.

## Side by side

"—" means we did not find the feature; "not compared" means we did not look.

| | Troupe | Orca | Mirasim |
| --- | --- | --- | --- |
| Form | Command line with a terminal UI and a local web UI; no dependencies | Desktop app; mobile companion | Desktop app with a local host; phone and chat-app channels |
| How agents run | Vendor session protocols (ACP, Codex app server, Claude Code stream-json); one-shot for the rest | Terminals with hook-based status; experimental structured chat for Claude Code and Codex | Vendor protocols (stream-json, app server, ACP, Pi RPC) or a terminal with hooks |
| Harnesses | 12 built in; any ACP agent by configuration | About 38 detected | Several, including Claude Code, Codex, Kimi and Pi |
| Permission requests | One queue for every agent; rules per agent; four modes | In each agent's terminal | not compared |
| Agent to agent | MCP tools: ask an agent, ask the user, shared board, progress; deadlock detection | Command and skills with coordinator and worker roles; mailbox with acknowledgement and replay; workers woken through their terminal | MCP endpoint per agent with messages between sessions and questions to the user |
| Isolation | A worktree and branch per agent, created automatically | A worktree per workspace | Optional worktrees |
| Bringing work back | Diff, review by another agent, local `--no-ff` merge that refuses dirty trees and conflicts | Commit, push and pull request, with hosting integrations | By hand, or a pull request |
| Definition of done | Goals with arm, completion and merge gates; Troupe runs the commands and asks a different agent to review | — | Goal room with arming gates; progress judged by a hosted model |
| Other machines | The engine over SSH | SSH with a deployed relay, or pairing with a server | SSH and cloud hosts |
| Editor, terminal, browser | — | Built in | not compared |
| Pull requests and CI | — | Built in | Pull requests |
| Automation | `troupe run` for scripts and CI | Scheduled automations | not compared |
| Usage and history | Token counts per agent | Usage statistics, session search | Usage tracking |
| Telemetry | None | not compared | On by default |
| Written protocol | `spec/` with JSON Schemas | — | — |

## Where Troupe is different

- **A written protocol.** The session, collaboration, orchestration and goal layers are
  specified in `spec/`, versioned (`troupe/1`) and backed by JSON Schemas, so other tools
  can implement any layer.
- **Structured sessions for every agent.** Troupe never reads a terminal screen. It sees
  commands, edits, plans and permission requests as data, from every harness alike.
- **One place to approve.** Requests from all agents arrive in one queue with the same
  modes and rules, instead of in each agent's own window.
- **Evidence Troupe gathers itself.** Goal checks are commands Troupe runs in the agent's
  worktree and reviews by a different agent; the working agent's own report never counts.
- **Merges tied to the evidence.** A merge waits until the checks passed on exactly the
  tree being merged.
- **Works inside sandboxes.** Agent-side tools use files, not sockets.
- **Small and inspectable.** No dependencies; it runs in a terminal, over SSH and in CI.

## What Troupe does not have

- An embedded terminal, editor or browser.
- Pull-request, CI or issue-tracker integration, and task boards.
- Notifications to a phone or a chat app.
- Usage analytics and search across past conversations.
- A terminal mode for harnesses without a session protocol: they run one message at a
  time.
- Scheduled runs (use cron with `troupe run`).
- Checkpoints to rewind an agent's changes (use git).

## Choosing

- An all-in-one desktop workspace with terminals, an editor and pull requests: **Orca**.
- Goal-driven runs you follow from your phone or a chat app: **Mirasim**.
- An open protocol, one approval queue across vendors, checks Troupe runs itself and merges
  tied to them, in a terminal, over SSH or in CI: **Troupe**.

They do not exclude each other: Troupe only needs the harness CLIs, not any other app.
