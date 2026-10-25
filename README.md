# Panther Companion

A quiet local workspace for understanding evidence in the context of your current goal. Attach selected text, a terminal result, or a review bundle from Panther Intent Capture. Companion keeps one useful explanation in view: **what it means, why it matters, your next check, and the evidence**.

The desktop app opens as a resizable 700 px panel on the right of the largest secondary display. The same interface works in a normal browser. Both work without Intent Capture, a model, a cloud account, or an always-on recorder.

## Start

Requires Node.js 22.13 or newer. The desktop interface uses Electron; Node's built-in SQLite stores local state.

```sh
npm install
npm run build
npm run serve
# Open http://127.0.0.1:8765
```

For the native desktop panel:

```sh
npm start
```

The desktop window respects the chosen display's work area, including negative coordinates and the menu bar. It is resizable and does not stay above other apps. `Cmd/Ctrl+Shift+E` brings it forward. `Cmd/Ctrl+K` edits the goal while the panel has focus. `node scripts/launch-panther.js` launches the same maintained entry point after a build.

## A useful first session

1. **Edit goal** — state the outcome you want. A goal change clears the current card and ends follow. Earlier context stays in exported history, rather than becoming evidence for the new task.
2. **Attach evidence** — paste selected text or a command result that already happened. Terminal results have an explicit command and exit code. Companion never runs that command.
3. **Explain this** — read one next check. Expand the card to inspect observed facts, unverified inferences, unknowns, and source references. Explanation state survives a refresh and expires after its configured lifetime.
4. **Give feedback** — Useful, Already know, Wrong task, More detail, and Later adjust local preferences. Wrong task clears the card and asks you to edit the goal.
5. **Pause** when you want quiet. No source is read and no new evidence is accepted while paused. Resume enables explicit actions; start Follow again if you want continuous updates.

Routine successful commands remain quiet. Empty captures state that evidence is missing. The default reasoner uses deterministic local rules, so the basic workflow responds immediately without waiting for a model.

For a selected note, a standalone `Next useful check:` or `Next step:` label brings your proposed action onto the card with explicit user-supplied attribution. The extracted check is bounded, remains unverified, and never overrides an observed command failure or source disagreement.

## Work with Panther Intent Capture

In Intent Capture, review a captured workflow and **export its intent bundle JSON**. In Companion, choose **Import from Intent Capture**, select the file, inspect its source, goal and proposal count, then import it. Adopting the captured goal is a separate checkbox, off by default.

The importer supports the current `1.2` portable bundle and a bounded projection of its fields. It checks producer/schema identity, identifiers, URLs, text/list limits and strict authority booleans. It accepts at most 25 proposals in a 1 MiB request. It deliberately discards raw events, media and unrecognized fields; this is not a full general-purpose JSON Schema validator.

Producer-reported steps and evidence summaries are labeled **not independently verified**. Hypotheses remain separate from observed context, and suggested checks are not treated as checks already performed. Imports preserve stable proposal identity across retries; revised content creates a new evidence revision. An explicitly reused bundle under a different goal gets a separate explanation history.

Importing does not create tickets, execute work, or grant delivery authority. Intent Capture can capture and review independently; Companion can use manually selected evidence independently.

## Follow a task

**Follow this task** reads configured JSONL sources every four seconds for 25 minutes by default. It starts only after you set a goal. Each complete line is consumed once per running host; partial lines wait for a newline. File truncation or replacement resets the reader. A poll reads at most 1 MiB, retains all valid events in that batch, and reasons over the newest 25.

Configure only sources you intend to share with Companion:

```sh
PANTHER_TERMINAL_LOG=/path/to/terminal.jsonl npm run serve
```

Example terminal event, one JSON object per newline:

```json
{"command":"npm test","exitCode":1,"stderr":"Cannot find module","stdout":"","timestamp":"2026-10-24T12:00:00Z"}
```

Other optional sources are `PANTHER_BROWSER_LOG` and `PANTHER_AGENT_LOG`. They read explicitly configured files; they do not observe the desktop automatically. Source status says configured or not configured. A configured file is not proof that a fresh event is available.

Follow ends at its deadline or when you click **End follow**. A process restart never silently resumes it. Pausing also ends active polling; resuming does not restart follow. **Prepare next decision** is a one-shot brief at your explicit pause, not another background mode.

Run one host per database for predictable source ownership. Persisted state revisions and atomic SQLite writes prevent delayed reasoning in another host from restoring a card after a goal change, pause or deletion. JSONL read cursors belong to each running host and reset after restart; repeated source lines can be recorded again across restarts.

## Local state and privacy

State defaults to `~/.panther-companion/state.sqlite`; set `PANTHER_DB` for an isolated workspace or `PANTHER_HOME` for a different state directory. HTTP binds only to `127.0.0.1`. The API checks Host and Origin, rejects cross-site data access, requires JSON writes and caps request size. The static HTML shell permits ordinary top-level navigation from the Intent Capture link. Electron uses a sandboxed, isolated preload with navigation restricted to its local surface.

Selected evidence is retained locally and is **not automatically secret-redacted**. Remove secrets before attaching or exporting. Temporary cards expire, but evidence history remains until you choose **Delete local history** and type `DELETE`. **Export local history** lets you inspect or keep it first. Existing databases gain goal-context mappings without deleting earlier history; older unscoped evidence remains exportable but is not silently assigned to the current goal.

No screenshots, keyboard recording, terminal execution, external ticket delivery or cloud fallback are included in this MVP.

## Optional local model

Set `PANTHER_CONFIG` to a JSON configuration file to opt into Ollama:

```json
{
  "threshold": 0.25,
  "followMinutes": 25,
  "insightTtlMinutes": 45,
  "reasoning": {
    "provider": "ollama",
    "ollamaUrl": "http://127.0.0.1:11434/api/generate",
    "model": "qwen3.8:latest",
    "fallbackToLocal": true
  }
}
```

Only HTTP(S) loopback model URLs without credentials are accepted. Redirects are rejected. Model calls have a 60-second timeout and require a completed response; with `fallbackToLocal: true`, failures use deterministic local rules. Model-generated claims remain proposals, not verified facts. Automated tests do not establish live model quality or latency.

## CLI and integration

```text
panther explain          one explicit explanation from configured sources/current-goal evidence
panther follow           begin a bounded follow session in the CLI host
panther prepare          one decision brief
panther goal set <text>  set a new goal and clear the current card
panther goal show        inspect the goal
panther feedback <kind>  record local feedback
panther status           inspect local state
panther serve            serve the interface and local API
```

`PANTHER_PORT` changes the HTTP port. The browser and Electron use the same validated controller. API routes are documented in [docs/MVP.md](docs/MVP.md). The existing stdio MCP adapter remains available under `mcp/server.ts`; it is a developer integration, separate from the browser HTTP boundary.

## Verify

```sh
npm test
npm run eval
```

Tests use in-memory or temporary SQLite stores and synthetic evidence. They cover card persistence, repeated imports, goal isolation, authority validation, pause/delete races, multi-host revision fences, JSONL bursts, local HTTP protections and display geometry. The five-situation evaluation covers command failures, source disagreement, shared agent failures, interrupted tasks and quiet routine success. Browser/native deployment verification is separate from these automated tests.

MIT licensed.
