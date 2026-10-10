# README media

The animations in the README are recorded from Troupe's real interfaces, not drawn by
hand. This directory holds the tools that make them; the results are in
[docs/media](../../docs/media).

| File | Shows | Made by |
| --- | --- | --- |
| `hero.svg`, `hero.zh.svg` | Terminal UI: one message to the BizOS CLI, Codex and Claude Code, a command allowed for good, a question from Codex to BizOS, three finished branches | `record.js` |
| `review-merge.svg`, `review-merge.zh.svg` | Terminal UI: the BizOS CLI's diff, a review by Codex, the merge | `record.js` |
| `web.svg`, `web.zh.svg` | Web UI, in the viewer's light or dark theme: the same message, an approval card, review and merge | `record.js` with Playwright |
| `how-it-works.svg`, `how-it-works.zh.svg` | Diagram of interfaces, engine, agent protocols and the mailbox | `diagram.js` |

## What is real and what is scripted

- **Real:** Troupe's engine, terminal UI and web UI, run unchanged in this process. The
  demo project ([story.js](story.js)) is a small git repository with a real bug. Troupe
  creates the worktrees and branches, decides and queues the approvals, carries the
  question between agents through its MCP server and file mailbox, asks for the review
  and performs the merge. The web UI is served by `createGuiHandler`, the same request
  handler `troupe gui` uses; Playwright routes the page's requests to it in-process.
- **Scripted:** the agents. [standins/](standins) are small programs that speak the real
  protocols — the BizOS CLI's `bizos acp` (with BizOS Code's own tool names and approval
  rules), Claude Code stream-json (asking before every edit, command and MCP tool, as
  Claude Code does in its default mode), `codex app-server`, and ACP — and act out
  [story.js](story.js). What they say is written in advance; the files they edit are
  written to their worktrees, and their `npm test` runs for real. They keep the real
  harnesses' names and "verified" labels, so the interface shows what it would show for
  the real ones, including "untested" for the BizOS CLI and Claude Code.

## How a recording becomes an SVG

- **Terminal UI** ([tui.js](tui.js), [svg-terminal.js](svg-terminal.js)): `runTui` draws
  into a 112 × 30 terminal and every frame it draws is kept with its time. Keys go through
  the real key decoder. Each distinct content of each row is drawn once and shown while it
  was on screen; braille spinners turn by themselves; box-drawing characters become lines.
- **Web UI** ([web.js](web.js), [web-capture.js](web-capture.js), [svg-web.js](svg-web.js)):
  after each step the page's layout is read — boxes, borders and text runs with their exact
  positions and computed colours — in both themes at once. Each shape is drawn once and
  shown while the page showed it, scrolling areas move as one group, and colours switch
  with `prefers-color-scheme`.
- **No script, no external resources, no embedded images.** GitHub serves SVG files with a
  Content-Security-Policy that allows inline styles only, so everything is plain SVG with
  CSS animations. The files are checked as `<img>` in Chrome and in WebKit (Safari's
  engine).

## Re-recording

Re-record after changing anything people see in the terminal or web UI:

```sh
TROUPE_PLAYWRIGHT=/path/to/node_modules/playwright/index.js npm run media
```

This needs git, npm (the stand-ins run `npm test`) and Google Chrome (or `TROUPE_CHROME`
pointing at another Chromium). Without `TROUPE_PLAYWRIGHT` the web UI is skipped. Each
recording takes about a minute and runs in real time; the demo project lives in
`$TMPDIR/troupe-demo` and is replaced every time.

One part at a time:

```sh
node tools/media/record.js --lang zh --only terminal --out /tmp/media
node tools/media/diagram.js --out /tmp/media
```
