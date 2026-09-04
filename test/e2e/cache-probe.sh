#!/usr/bin/env bash
# Live prompt-cache probe: run One Code once against a real model on a throwaway
# project, dump every request, and check the prefix stayed stable
# (test/e2e/cache-probe.mjs; CACHE-REVIEW-2026-09-04 L3).
#
#   test/e2e/cache-probe.sh [model] [extra cache-probe.mjs flags…]
#   e.g. test/e2e/cache-probe.sh anthropic/claude-sonnet-5
#        test/e2e/cache-probe.sh openrouter/deepseek/deepseek-v4-flash --eager-load-ok
#
# From a sandboxed assistant shell, run it inside tmux (findings §10). Costs one
# short three-request session (~25k tokens on a Claude model, mostly cache write).
# The prompt exercises the deferred-tool path (tool_search → task_list), the one
# that regressed in H2.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
MODEL="${1:-anthropic/claude-sonnet-5}"
shift || true
NODE_BIN=/Users/isuruWij/.nvm/versions/node/v26.3.1/bin
[ -d "$NODE_BIN" ] && export PATH="$NODE_BIN:$PATH"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/cache-probe.XXXXXX")"
PROJECT="$WORK/project"
mkdir -p "$PROJECT"
git -C "$PROJECT" init -q
printf '# Probe\n\nThrowaway project for the prompt-cache probe.\n' > "$PROJECT/CLAUDE.md"

PROMPT='First call tool_search with query select:task_list. Then call task_list once. Then reply with exactly the word done.'
echo "model:   $MODEL"
echo "workdir: $WORK"
(
	cd "$PROJECT"
	WIRE_DUMP="$WORK/wire.jsonl" pi -e "$REPO/test/e2e/dump-requests.ts" --model "$MODEL" --mode json -p "$PROMPT" > "$WORK/events.jsonl" 2> "$WORK/stderr.log"
) || echo "pi exited non-zero (see $WORK/stderr.log)"

node "$REPO/test/e2e/cache-probe.mjs" "$WORK/wire.jsonl" "$WORK/events.jsonl" "$@"
