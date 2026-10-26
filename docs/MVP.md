# Companion MVP behavior and API

The interface is deliberately centered on an editable goal, one explanation and a bounded collection of selected context. It does not require a capture provider to be useful. Manual evidence is the standalone path; review-only Intent Capture JSON is the integration path.

## API

The browser calls the same local controller as Electron. JSON writes are capped at 1 MiB. Error responses use `400` for invalid user input and a fixed `500` message for unexpected internal failure. No browser CORS access is granted.

| Method and path | Input | Result |
| --- | --- | --- |
| GET `/api/status` | None | Current goal, card, bounded recent context, sources, cached sourceReadiness, session, pause state |
| POST `/api/goal` | `{"hypothesis":"…"}` or null | New goal; current card and follow cleared |
| POST `/api/observation` | `{"kind":"note","text":"…"}` | Attach and explain selected text |
| POST `/api/observation` | `{"kind":"terminal","command":"…","exitCode":1,"text":"…"}` | Explain a command result; never execute it |
| POST `/api/explain` | `{}` | Capture configured sources or explain retained current-goal evidence |
| POST `/api/follow` | `{}` | Begin bounded source polling after a goal is set |
| POST `/api/stop` | `{}` | End active session and fence delayed work |
| POST `/api/prepare` | `{}` | One explicit decision brief; session ends afterwards |
| POST `/api/pause` | `{"paused":true}` | Stop reads and fence pending responses |
| POST `/api/import-preview` | `{"bundle":{…}}` | Validate supported bundle projection without storing it |
| POST `/api/import` | `{"bundle":{…},"useGoal":false}` | Attach review proposals without execution authority |
| POST `/api/feedback` | `{"kind":"AlreadyKnow"}` | Adjust local preferences for the current card |
| POST `/api/dismiss` | `{}` | Clear card; preserve selected evidence |
| GET `/api/export` | None | Download local history |
| POST `/api/delete` | `{"confirm":"DELETE"}` | Delete this local Companion store's history |

State mutations and their revision tokens are committed together. A reasoning result commits only if its original persisted revision still matches, inside a SQLite transaction. Goal changes clear active context and close earlier open questions. Explicitly imported evidence can belong to more than one goal, while explanation/insight history remains distinct.

## Acceptance scenarios

- Starting with no model and no capture source presents an honest empty state; goal editing and manual evidence work.
- A selected failed command shows captured stderr, a specific next check and distinct unknowns. A refresh retains it.
- A successful routine command clears an obsolete failure card and remains quiet.
- Repeated evidence updates the same current-goal insight rather than raising an SQLite uniqueness error.
- An IC bundle is previewed before import. No goal replacement occurs unless its checkbox is selected. Strings such as `"false"` never pass authority validation.
- A new goal cannot explain itself using the previous task's selected context unless that context is explicitly attached again.
- Pausing, ending follow, changing the goal or deleting history invalidates delayed work. Deletion cannot be undone by a late model response.
- Configured JSONL input is read incrementally and boundedly. All events from a batch are retained even when only its newest 25 reach the reasoner.
- The desktop panel selects the largest nonprimary display and aligns to the right work-area boundary at up to 700 px width, without being always on top.

## Product references

Useful patterns were adapted to the local, explicit-context workflow: [Warp's selected-context changes](https://docs.warp.dev/changelog/2026), [Raycast's keyboard-first quickstart](https://manual.raycast.com/quickstart), and [Screenpipe's history search](https://docs.screenpi.pe/search-screen-history). Current scope uses explicit attachment, a focused action row and inspectable recent context. Screen recording, broad history search and automatic delivery remain outside this MVP.

## Cached source readiness

`GET /api/status` preserves the existing `sources: string[]` configuration summaries and adds `sourceReadiness`. Each item contains `id`, `configured`, `state`, `lastAttemptAt`, `lastSuccessAt`, `lastEvidenceAt`, `recordsRead`, `recordsSkipped`, `partialLine`, `hasMore`, and `error`. States are `not-configured`, `unsupported`, `not-checked`, `waiting`, `partial`, `invalid`, `ready`, and `unavailable`. Error categories are `missing`, `permission`, `not-file`, and `unreadable`; diagnostics never include the source path, file contents, or raw filesystem exception.

These snapshots describe the last actual read in this host. Last success means the file was read, not that a valid event or successful task outcome was observed. Last evidence is the time a valid record was received and is retained separately through later empty or failed reads. Status queries perform no source I/O. Only explicit Explain/Prepare/Follow reads and active bounded Follow ticks update readiness; Pause, Resume, expired sessions, manual evidence, and bundle imports do not probe JSONL sources. Legacy hosts without the additive field appear unchecked in the current surface.

The v1.2 shared terminal producer is preserved: `PANTHER_TERMINAL_LOG` overrides the default `~/.panther-companion/terminal.jsonl`, and an explicit `TerminalAdapter(null)` disables it. Default-file presence is discovered at adapter construction and on explicit read actions, never by status or Pause/Resume. A newly created default becomes available after **Explain again** (or an explicit Follow request). Once discovered it remains configured, so disappearance during Follow reports unavailable and can recover in the same bounded session. `observable` remains a compatible list of cached configured candidates, not a successful-read or outcome claim. Capture-script guidance uses the packaged resource location when applicable, and package.json remains the shared source of the reported version.
