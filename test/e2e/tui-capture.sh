#!/usr/bin/env bash
# Render pi's TUI in a real pty and dump the screen as text.
#
# Needed because a sandboxed/CI shell has no controlling terminal: `pi` falls back
# to non-TUI behaviour, and `script` fails with "tcgetattr/ioctl: Operation not
# supported on socket". tmux allocates its own pty, so the TUI renders exactly as a
# user sees it, and `capture-pane` gives us the rendered screen.
#
# Usage:
#   test/e2e/tui-capture.sh [workdir] [seconds] [extra pi args...]
#
# Examples:
#   test/e2e/tui-capture.sh .                       # startup screen of this repo
#   test/e2e/tui-capture.sh /tmp/proj 8 --theme ./themes/claude-code.json
#
# Prints the visible pane. Add -e to capture escape sequences instead of plain
# text by setting CAPTURE_ANSI=1 (useful for checking colours).

set -euo pipefail

WORKDIR="${1:-$PWD}"
WAIT="${2:-8}"
shift 2 2>/dev/null || shift $# || true

SESSION="pi-tui-capture-$$"
COLS="${COLS:-160}"
ROWS="${ROWS:-45}"

cleanup() { tmux kill-session -t "$SESSION" 2>/dev/null || true; }
trap cleanup EXIT

tmux new-session -d -s "$SESSION" -x "$COLS" -y "$ROWS" -c "$WORKDIR" "pi $*"
sleep "$WAIT"

if [ "${CAPTURE_ANSI:-0}" = "1" ]; then
  tmux capture-pane -p -e -t "$SESSION"
else
  tmux capture-pane -p -t "$SESSION"
fi
