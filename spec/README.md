# Troupe protocol, version `troupe/1`

Troupe is a cross-harness protocol: it lets several coding agents built by different
vendors — Claude Code, Codex, OpenCode, Gemini CLI, Kimi Code and any other harness —
work on one project at the same time, talk to each other, ask the user for decisions,
and hand their work back through checks a person can trust.

The protocol deliberately stops at the edge of each harness. It does not define how an
agent thinks, which model it calls or how it edits files. A harness joins by speaking
one of the session protocols below; everything Troupe adds sits around it.

## Layers

| Layer | Document | What it defines |
| --- | --- | --- |
| Agent session | [agent-session.md](agent-session.md) | One live conversation with one harness, normalised into seven events and five commands, with mappings for ACP, `codex app-server`, Claude Code stream-json and one-shot CLIs. |
| Collaboration | [collaboration.md](collaboration.md) | The tools every agent gets (`troupe_ask_agent`, `troupe_ask_user`, the shared board, progress and goal status) and the file mailbox that carries them without sockets. |
| Orchestration | [orchestration.md](orchestration.md) | Addressing agents with `@mentions`, agent lifecycle, approvals, worktree isolation, merging, error codes, and the client protocol user interfaces use (locally or over SSH). |
| Goals | [goals.md](goals.md) | A written definition of done, the gates that arm it, check it with independent evidence and hold merges until it passes. |

JSON Schemas for the wire formats are in [schemas/](schemas/).

## Design rules

1. **Harnesses stay untouched.** Troupe launches vendor CLIs the way their authors
   document, through their own session protocols. It never patches, wraps or
   re-implements an agent loop.
2. **The user decides.** Anything a harness asks permission for is answered by the
   user or by an explicit rule the user set; agents may ask each other questions but
   cannot grant each other permissions.
3. **Evidence over claims.** "Done" is decided by commands Troupe runs and reviews by a
   different agent, never by the working agent's own report.
4. **Works inside sandboxes.** Agent-side collaboration uses files in a private mailbox,
   not loopback or Unix sockets, because many harnesses sandbox their tool servers.
5. **Plain data.** Every message is JSON; state lives in ordinary files; any language
   can implement any layer.

## Versioning

The protocol version is the string `troupe/1`. Engines report it in snapshots and
in the `initialize` reply of the client protocol; clients refuse a different major
version. Within `troupe/1`:

- new optional fields, events, tools and error codes may be added;
- existing fields keep their meaning and type;
- receivers ignore fields and event types they do not know.

A change that breaks any of these rules becomes `troupe/2`.

## Conformance

An implementation may provide any subset of the layers. It conforms to a layer when
it follows that document's MUST rules. The reference implementation in this
repository implements all four layers and is tested against mock harnesses for every
session protocol (`test/fixtures/`).

## Closed runners

A proprietary agent runtime joins without publishing its code: it implements a session
protocol (ACP is the simplest) and the user registers it in `~/.troupe/config.json`.
Troupe then treats it like any other harness — it receives tasks, can ask and answer
other agents, and its work passes the same gates.
