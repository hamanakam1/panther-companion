# Contributing to Panther Companion

Thanks for your interest. Panther Companion is a local-first, goal-aware desktop companion.
Contributions that keep it quiet, evidence-transparent, and local-first are most welcome.

## Ground rules

- **Read the invariants first.** See the README and the product spec in the issue tracker.
  The hard invariants (goal first-class, fixed explanation schema, three modes, transient
  insights, pluggable providers, quiet by default, local-first) are not negotiable.
- **One writer.** The store has a single-writer lock. Do not bypass it; tests enforce it.
- **No general chat.** Do not add a general-purpose chat surface.
- **No noisy proactive agent.** Any new surface must pass the gating tests.

## Development

```sh
npm install
npm run build
npm test
npm run eval
```

Node >= 22.13 is required. `ELECTRON_SKIP_BINARY_DOWNLOAD=1` is set in CI; for desktop
work install Electron normally.

## Pull requests

- Keep changes focused and small.
- Add or update tests for behavior changes.
- Run `npm test` and `npm run eval` before submitting; both must pass.
- Update `README.md` if user-facing behavior changes.
- Do not commit `dist/`, `node_modules/`, or `release/` artifacts.

## Reporting bugs

Use the bug report template. Include reproduction steps, expected vs. actual, and the
output of `panther status` if relevant. Do not include private data or secrets.
