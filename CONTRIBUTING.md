# Contributing to Troupe

Thank you for helping. Troupe is small on purpose, and these notes are how it stays that
way.

## Getting started

```sh
git clone https://github.com/AI-BizOS/troupe.git
cd troupe
npm test                  # there is no install step: Troupe has no dependencies
node bin/troupe.js --help
```

You need Node.js 20.11 or newer and git. The tests drive mock agents
(`test/fixtures/`), so no vendor CLI or account is needed.

The browser part of `test/gui.test.js` runs only when you point it at a Playwright
installation of your own:

```sh
TROUPE_PLAYWRIGHT=/path/to/node_modules/playwright/index.js \
TROUPE_CHROME=/path/to/chrome \
TROUPE_SCREENSHOTS=/tmp/troupe-shots \
node --test test/gui.test.js
```

`TROUPE_CHROME` (default: Playwright's own Chromium) and `TROUPE_SCREENSHOTS` are optional.

## Ground rules

- **No runtime dependencies.** If something seems to need a package, open an issue first.
- **Plain modern JavaScript.** ES modules, `node:` built-ins, Node.js 20.11 or newer, on
  macOS, Linux and Windows.
- **Write for the next reader.** Clear names and small functions; comments only where they
  explain *why*.
- **English** for code, comments and documentation. Every string a user sees goes through
  `src/i18n/strings.js`, in English and Chinese.
- **Agent output is untrusted.** Sanitise it before it reaches a terminal, never insert it
  into the web page as HTML, never follow links found in a mailbox, and never let a
  repository decide what Troupe runs.

[docs/architecture.md](docs/architecture.md) explains where things live.

## Adding a harness

1. **It speaks ACP, `codex app-server` or Claude Code stream-json.** Add a definition to
   `src/providers/registry.js` with `verified: false`, and a row to the tables in both
   READMEs and [docs/providers.md](docs/providers.md).
2. **It speaks another protocol.** Add an adapter in `src/adapters/` that implements the
   agent-session interface ([spec/agent-session.md](spec/agent-session.md)), a mock agent
   in `test/fixtures/` that understands the directives in `mock-common.js`, tests in
   `test/adapters.test.js`, and a mapping table in the spec.
3. Set `verified: true` only after running it against a real install, and say in the pull
   request which version you ran and what you checked.

## Changing the protocol

The protocol is `troupe/1` ([spec/README.md §Versioning](spec/README.md#versioning)).
Optional fields, new events, new tools and new error codes may be added within
`troupe/1`; anything else needs `troupe/2`. A protocol change updates, in one pull
request, the spec text, the JSON Schema in `spec/schemas/`, the implementation and the
tests. `test/schemas.test.js` checks the schemas against real traffic, including that the
documented method list equals `METHODS`.

## Changing the interfaces

- The terminal UI and the web UI offer the same features and share `src/tui/store.js`.
- Add strings in both languages.
- Terminal UI: test frames at exact widths in `test/tui.test.js`, with Chinese text and a
  narrow terminal.
- Web UI: keep the Content-Security-Policy strict (no inline scripts or styles; build the
  DOM with text nodes) and check a 360-pixel-wide window in dark mode.
- The animations in the READMEs are recorded from the real interfaces. When a change
  alters what they show, re-record them with `npm run media`
  ([tools/media](tools/media/README.md)) in the same pull request.

## Pull requests

- One topic per pull request. `npm test` passes, and new behaviour comes with a test.
- Describe what you verified and how, especially for harness integrations.
- By contributing you agree that your contribution is licensed under the
  [Apache License 2.0](LICENSE), like the rest of the project.

## Reporting bugs

Please include `troupe --version`, `troupe detect --json` (remove anything private), your
operating system and Node.js version, the harness and its version, what you did and what
you expected. For security problems, follow [SECURITY.md](SECURITY.md) instead of opening
a public issue.
