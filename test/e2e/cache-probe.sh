#!/usr/bin/env bash
# Live prompt-cache probe: run One Code once against a real model on a throwaway
# project, dump every request, and check the prefix stayed stable
# (test/e2e/cache-probe.mjs; CACHE-REVIEW-2026-09-04 L3).
#
#   test/e2e/cache-probe.sh [model] [--no-load] [extra cache-probe.mjs flags…]
#   e.g. test/e2e/cache-probe.sh anthropic/claude-sonnet-5
#        test/e2e/cache-probe.sh openai/gpt-6.1-sol
#        test/e2e/cache-probe.sh openrouter/deepseek/deepseek-v4.1-flash --no-load
#
# From a sandboxed assistant shell, run it inside tmux (findings §10). Costs one
# short three-request session (~25k tokens on a Claude model, mostly cache write).
# The default prompt exercises the deferred-tool path (tool_search → cron_list),
# the one that regressed in H2. `--no-load` runs two read-only bash calls
# instead, for a provider with no native tool loading (OpenRouter), where a
# load re-caches the conversation by design (findings §7).
#
# A second, classifier phase runs four gated network commands in auto mode and
# checks that the auto-mode classifier's transcript is a cache read from call
# to call and from stage 1 to stage 2 (test/e2e/cache-probe-classifier.mjs over
# the classifier's own CC_AUTO_MODE_LOG). `--no-classifier` skips it.
# A third phase repeats a web_fetch reader call against a deterministic page
# fixture (cache-probe-reader.sh). `--no-reader` skips it.
#
# openai-codex models talk over WebSocket by default, which dump-requests.ts
# cannot see; the probe project sets `transport: "sse"` and is trusted with
# --approve so the session's requests go through fetch.
#
# It runs the repo's own pi (node_modules), the version One Code ships against,
# not whatever `pi` is first on PATH; PI_BIN overrides that. CACHE_PROBE_WORK_DIR
# optionally names a new output directory without changing TMPDIR for test fixtures.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
MODEL="${1:-anthropic/claude-sonnet-5}"
shift || true
# NODE_BIN puts a specific Node first on PATH (the probe needs Node >= 22.19).
[ -n "${NODE_BIN:-}" ] && export PATH="$NODE_BIN:$PATH"
PI_BIN="${PI_BIN:-$REPO/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js}"

PROMPT='First call tool_search with query select:cron_list. Then call cron_list once. Then reply with exactly the word done.'
CHECK_ARGS=()
CLASSIFIER=1
READER=1
for arg in "$@"; do
	if [ "$arg" = "--no-classifier" ]; then
		CLASSIFIER=0
	elif [ "$arg" = "--no-reader" ]; then
		READER=0
	elif [ "$arg" = "--no-load" ]; then
		PROMPT='Run echo probe-one with the bash tool. Then run echo probe-two with the bash tool. Then reply with exactly the word done.'
	else
		CHECK_ARGS+=("$arg")
	fi
done

if [ -n "${CACHE_PROBE_WORK_DIR:-}" ]; then
	WORK="$CACHE_PROBE_WORK_DIR"
	mkdir "$WORK" # Must be new: never overwrite an earlier probe's evidence.
else
	WORK="$(mktemp -d "${TMPDIR:-/tmp}/cache-probe.XXXXXX")"
fi
PROJECT="$WORK/project"
mkdir -p "$PROJECT"
git -C "$PROJECT" init -q
printf '# Probe\n\nThrowaway project for the prompt-cache probe.\n' > "$PROJECT/CLAUDE.md"
APPROVE=()
case "$MODEL" in
openai-codex/*)
	mkdir -p "$PROJECT/.pi"
	printf '{"transport":"sse"}\n' > "$PROJECT/.pi/settings.json"
	APPROVE=(--approve)
	;;
esac

echo "model:   $MODEL"
echo "pi:      $(node "$PI_BIN" --version 2>/dev/null | tail -1)"
echo "workdir: $WORK"
(
	cd "$PROJECT"
	WIRE_DUMP="$WORK/wire.jsonl" node "$PI_BIN" -e "$REPO/test/e2e/dump-requests.ts" ${APPROVE[@]+"${APPROVE[@]}"} --model "$MODEL" --mode json -p "$PROMPT" > "$WORK/events.jsonl" 2> "$WORK/stderr.log"
) || echo "pi exited non-zero (see $WORK/stderr.log)"

status=0
node "$REPO/test/e2e/cache-probe.mjs" "$WORK/wire.jsonl" "$WORK/events.jsonl" ${CHECK_ARGS[@]+"${CHECK_ARGS[@]}"} || status=1

if [ "$CLASSIFIER" = 1 ]; then
	echo "--- classifier phase"
	CPROJECT="$WORK/classifier-project"
	mkdir -p "$CPROJECT"
	git -C "$CPROJECT" init -q
	CPROMPT='Run each of these four commands in its own separate bash call, one after another (never combine them, never in parallel), then reply with exactly the word done: curl -sI https://example.com ; curl -sI https://example.org ; curl -sI https://www.iana.org ; curl -sI https://httpbin.org/get'
	(
		cd "$CPROJECT"
		CC_AUTO_MODE_LOG="$WORK/classifier.jsonl" node "$PI_BIN" --model "$MODEL" --mode json --permission-mode auto -p "$CPROMPT" > "$WORK/classifier-events.jsonl" 2> "$WORK/classifier-stderr.log"
	) || echo "pi exited non-zero in the classifier phase (see $WORK/classifier-stderr.log)"
	touch "$WORK/classifier.jsonl"
	node "$REPO/test/e2e/cache-probe-classifier.mjs" "$WORK/classifier.jsonl" || status=1
fi
if [ "$READER" = 1 ]; then
	echo "--- reader phase"
	CACHE_PROBE_WORK_DIR="$WORK/reader" bash "$REPO/test/e2e/cache-probe-reader.sh" "$MODEL" || status=1
fi
exit $status
