#!/usr/bin/env bash
# capture-command.sh — run a command and append its outcome to Panther's JSONL capture.
#
#   scripts/capture-command.sh npm test
#   scripts/capture-command.sh migrate --prod
#
# The event is appended to PANTHER_TERMINAL_LOG, or to
# ~/.panther-companion/terminal.jsonl by default — the same file Companion reads.
# Every outcome is recorded; Companion itself stays quiet on routine success, so
# the quiet decision is made by the gate, not by this recorder.
#
# Only the command string, exit code, working directory, branch and output are
# stored. The environment is never captured. Remove secrets from command
# arguments before wrapping them.
set -uo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: scripts/capture-command.sh <command> [args...]" >&2
  exit 2
fi

LOG="${PANTHER_TERMINAL_LOG:-${PANTHER_HOME:-$HOME/.panther-companion}/terminal.jsonl}"
mkdir -p "$(dirname "$LOG")"
chmod 700 "$(dirname "$LOG")" 2>/dev/null || true

OUT="$(mktemp)"
ERR="$(mktemp)"
trap 'rm -f "$OUT" "$ERR"' EXIT

CWD="$PWD"
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"

"$@" >"$OUT" 2>"$ERR"
CODE=$?

python3 - "$LOG" "$CODE" "$CWD" "$BRANCH" "$OUT" "$ERR" "$@" <<'PY'
import datetime, json, os, sys

log_path, code, cwd, branch, out_path, err_path = sys.argv[1:7]
argv = sys.argv[7:]
limit = 8000


def read(path):
    try:
        with open(path, "rb") as handle:
            return handle.read(limit + 1)[:limit].decode("utf-8", "replace")
    except OSError:
        return ""


def size(path):
    try:
        return os.path.getsize(path)
    except OSError:
        return 0


truncated = size(out_path) > limit or size(err_path) > limit
event = {
    "command": " ".join(argv),
    "cwd": cwd,
    "gitBranch": branch,
    "exitCode": int(code),
    "stderr": read(err_path),
    "stdout": read(out_path),
    "truncated": truncated,
    "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
}

os.makedirs(os.path.dirname(log_path) or ".", mode=0o700, exist_ok=True)
with open(log_path, "a", encoding="utf-8") as handle:
    handle.write(json.dumps(event, ensure_ascii=False) + "\n")
PY

cat "$OUT"
cat "$ERR" >&2
exit "$CODE"
