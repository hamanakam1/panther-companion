# Panther Companion

Local-first, goal-aware desktop companion. It watches structured observations
from your work surface (terminal, browser, agents) and delivers the *smallest
useful explanation* of what that evidence means **for the current goal** — only
when it is likely to save attention. It never becomes another noisy overlay or
general chat bot.

## Core promise

> Understand what matters in the work happening around you, with less
> investigation and fewer interruptions.

## Hard invariants

1. **Goal is first-class and user-editable.** An explicit, correctable hypothesis
   of the current goal. A wrong goal produces irrelevant help.
2. **Fixed, scannable output schema** for every explanation:
   - What it means / Why it matters here / Next check / Evidence
   - Observed / Inferred / Unknown
3. **Exactly three interaction modes:** Explain this · Follow this task ·
   Prepare the next decision
4. **Insights are temporary by default.** Only the user promotes to durable
   memory or a ticket.
5. **Observation providers are pluggable.** The reasoning core never hard-codes
   a capture tool.
6. **Stay quiet by default.** Gating on confidence × relevance × novelty ×
   timing × preference.
7. **Local-first.** History, preferences, models, and state stay on-device.
   Everything remembered is inspectable, filterable, pausable, deletable.

## Quick start

```bash
# install
npm install

# build
npm run build

# one-shot explain over captured evidence
npm run explain

# serve the floating card UI (http://localhost:8765)
npm run serve

# run the evaluation harness (5 situations)
npm run eval

# unit tests
npm test
```

## CLI

```
panther explain          # one-shot: capture, gate, render the schema
panther follow           # bounded "Follow this task" session
panther prepare          # quiet collect + decision brief at a pause
panther goal [set|show]  # manage the current goal hypothesis
panther feedback <kind>  # AlreadyKnow | WrongTask | UsefulMoreLikeThis | ExplainMechanism | UsefulButLater
panther status           # goal, live card, gate, insight counts
panther serve            # HTTP surface card + JSON API
```

Set `PANTHER_DB` to change the local SQLite store path (default
`~/.panther-companion/state.sqlite`).

## Adapters (pluggable)

- `TerminalAdapter` — structured terminal events (Warp-inspired). Reads JSONL
  from `PANTHER_TERMINAL_LOG` or stdin.
- `BrowserAdapter` — focused tab, URL, title, selection, accessibility text.
  Reads JSONL from `PANTHER_BROWSER_LOG`.
- `AgentEventAdapter` — CLI agent / HSF-style events from `PANTHER_AGENT_LOG`.
- `DesktopCaptureAdapter` — optional, unwired by design (no commercial
  capture dependency in core).
- `MemoryProvider` — optional long-term memory (interface only).

The reasoning core consumes `Observation` records; it does not own any adapter.

## Reasoning & gating

- Local deterministic reasoner (`src/core/reasoner.ts`) emits the fixed schema
  and separates Observed / Inferred / Unknown.
- Optional Ollama provider (`src/reasoning/ollama.ts`) with local fallback.
- Gate (`src/core/gating.ts`): `score = confidence × relevance × novelty × timing × preference`;
  below threshold → suppressed, nothing shown.

## State

SQLite (`node:sqlite`) at `~/.panther-companion/state.sqlite`: goals,
observations, insights (transient/expired/promoted), explanations, questions,
feedback, gate log, durable memory. Export and delete are user-controlled.

## MCP

`mcp/server.ts` is a stdio MCP server exposing `panther.get_goal`,
`panther.status`, `panther.explain`, `panther.feed_observation`,
`panther.feedback` so other tools can read the goal or feed observations.

## Evaluation

`eval/run.ts` replays the five required situations against an in-memory store
and reports pass/fail:

1. Unfamiliar command failure → `command-failure` topic
2. Documentation mismatch → `doc-mismatch`, decision needed
3. Multiple agents, same failure → `shared-agent-failure`
4. Return to interrupted task → `interrupted-task`
5. Routine successful work → zero surface (suppressed)

## Project structure

```
src/domain.ts        # shared types (Goal, Observation, Explanation, GateDecision, …)
src/config.ts        # gating thresholds + reasoning provider config
src/paths.ts         # store / prompt / card locations
src/core/            # gating, goal, insights, routine, text, reasoner
src/adapters/        # pluggable observation providers
src/state/store.ts   # SQLite state layer
src/ingest.ts        # capture → gate → explain orchestrator
src/cli.ts           # CLI + HTTP surface server
src/reasoning/       # Ollama provider
surface/card.html    # fixed-schema floating card UI
mcp/server.ts        # stdio MCP server
eval/                # 5-situation evaluation harness
test/                # unit tests (node --test)
```

## License

MIT
