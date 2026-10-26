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

For the native desktop panel without packaging:

```sh
npm start
```

The desktop window respects the chosen display's work area, including negative coordinates and the menu bar. It is resizable and does not stay above other apps. `Cmd/Ctrl+Shift+E` brings it forward. `Cmd/Ctrl+K` edits the goal while the panel has focus. `node scripts/launch-panther.js` launches the same maintained entry point after a build.

### One surface writes at a time

The panel, `npm run serve` and the MCP server all share one store, so exactly one of them writes it. The panel claims the store and serves `http://127.0.0.1:8765` from its own process, which means the desktop panel and the browser page are the same controller and cannot disagree about the goal, the card or the follow session. If `serve` already owns the store, the panel opens as a client of that server instead of opening the store a second time.

Whoever comes second reads instead of writing, and says so in plain words rather than failing as a lock timeout:

```
Panther Companion: the store ~/.panther-companion/state.sqlite is already in use by
Panther Companion panel (PID 1234, since 2026-10-26T09:22:10.844Z).
Only one surface writes at a time. Use the surface that already owns it, or quit it and start this one again.
```

The claim is a lease file next to the store (`state.sqlite.writer`) with a heartbeat. Quitting releases it, a dead process is reclaimed immediately, and one that stops beating is reclaimed after 30 seconds. The panel also appends start-up and shutdown events to `~/.panther-companion/panel.log`, because a double-clicked app has no terminal to print to.

### Install as an app

```sh
npm run package
cp -R "release/mac-arm64/Panther Companion.app" /Applications/
```

The result is a single double-clickable `Panther Companion.app` that bundles its own Electron runtime, so the machine that runs it needs no Node install and no checkout. It places itself on the right edge of the largest secondary display and reads the same `~/.panther-companion` state as the browser surface.

The local build is unsigned and un-notarised: it is made for this machine, and `mac.identity` is pinned to `null` so no certificate is ever picked up by accident. Hand it to someone else only after adding a Developer ID identity and notarising it.

`npm run package:dmg` builds a disk image instead of a bare app. `npm run icon` regenerates `build/icon.png` from `scripts/make-icon.py`.

## A useful first session

1. **Set your goal** — follow the highlighted Goal → Evidence → Next check guide and state the outcome you want. A goal change clears the current card and ends follow. Earlier context stays in exported history, rather than becoming evidence for the new task.
2. **Attach evidence** — paste selected text or a command result that already happened. Terminal results have an explicit command and exit code. Companion never runs that command.
3. **Read the next check** — attaching evidence or importing a bundle already requests an explanation. Use **Explain again** for a fresh view of the selected context. Expand the card to inspect observed facts, unverified inferences, unknowns, and source references. Explanation state survives a refresh and expires after its configured lifetime.
4. **Give feedback** — Useful, Already know, Wrong task, More detail, and Later adjust local preferences. Wrong task clears the card and asks you to edit the goal.
5. **Pause** when you want quiet. No source is read and no new evidence is accepted while paused. Resume enables explicit actions; start Follow again if you want continuous updates.

The interface distinguishes a missing goal, missing evidence, selected evidence ready to explain, a next check ready to read, paused work, and a lost connection with a Retry action. Follow stays unavailable until a source is configured; manual evidence and imports still work independently. To give Follow something to read, wrap the command you already run:

```sh
scripts/capture-command.sh npm test
```

It appends the command, exit code, directory, branch and captured output to `~/.panther-companion/terminal.jsonl` and passes the command's own output and exit code straight through. The environment is never recorded; remove secrets from arguments before wrapping them. A packaged app carries its own copy at `Panther Companion.app/Contents/Resources/capture-command.sh` and names that path in the interface. Terminal results require an explicit observed exit code, with no assumed failure.

Routine successful commands remain quiet. Empty captures state that evidence is missing. The default reasoner uses deterministic local rules, so the basic workflow responds immediately without waiting for a model.

When explaining retained evidence, the local reasoner uses the latest completed terminal result only within the same command, directory, branch and source location. Event timestamps take precedence over arrival order; equal timestamps use the host's stable input order. A result with missing context cannot replace one with known, different context. Earlier results remain in local history and exports. Current failures and source disagreements take precedence over imported proposals; **Prepare a decision** still presents the explicitly stored open questions.

For a selected note, a standalone `Next useful check:` or `Next step:` label brings your proposed action onto the card with explicit user-supplied attribution. The extracted check is bounded, remains unverified, and never overrides an observed command failure or source disagreement.

## Work with Panther Intent Capture

In Intent Capture, review the draft proposals and choose **Copy intent bundle**. In Companion, choose **Import from Intent Capture → Paste bundle JSON**, paste the copied bundle, then choose **Preview bundle**. Alternatively, use **Download intent bundle** in Intent Capture and **Choose JSON file** in Companion. If copying is unavailable, you can also open the downloaded .json file as text, copy its full contents, and paste them manually. Companion never reads the clipboard automatically. The preview shows the source, captured goal, proposal count, and producer-reported evidence summaries. Preview adds nothing to local history. Choose **Import N proposals** to confirm. Adopting the captured goal is a separate checkbox, off by default. Editing the JSON, changing the input method, choosing a different file, or closing the dialog invalidates its preview and clears that choice. Invalid, oversized, or empty bundles provide a recovery step and cannot be confirmed.

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

Follow ends at its deadline or when you click **End follow**. Closing a browser tab does not stop the local HTTP service or its active Follow session; use **End follow** or **Pause** first when you want observation to stop. Quitting the desktop app stops its process. A process restart never silently resumes Follow. Pausing also ends active polling; resuming does not restart follow. **Prepare a decision** is a one-shot brief at your explicit pause, not another background mode.

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

Both reasoners use the same current-evidence selection, so a successful rerun supersedes an earlier result only for the same captured command context. Imported capture facts keep their producer attribution and unresolved outcomes; model interpretations and proposed checks remain explicitly labeled. Current failures and stored decision questions retain priority over imported proposals. Invalid response types or citations are rejected, and local fallback is visibly disclosed in the explanation only when `fallbackToLocal` is enabled; disabling it makes an unsuccessful model call fail instead.

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

Tests use in-memory or temporary SQLite stores and synthetic evidence. Surface behavior tests run the shipped event handlers against a minimal DOM and the real controller, including file/paste preview, stale async results, goal consent, invalid input, and recovery; browser rendering remains a separate check. They cover card persistence, repeated imports, goal isolation, authority validation, pause/delete races, multi-host revision fences, JSONL bursts, local HTTP protections and display geometry. The five-situation evaluation covers command failures, source disagreement, shared agent failures, interrupted tasks and quiet routine success. Browser/native deployment verification is separate from these automated tests.

GitHub Actions runs the locked install, build, tests and evaluation on the latest Node 22.x and 24.x releases for each pull request and changes to `main`. The workflow skips the Electron binary download because these checks use Node APIs and pure layout calculations. Native Electron interaction, desktop placement and browser capture still need their separate runtime checks.

MIT licensed.
