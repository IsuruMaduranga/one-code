#!/usr/bin/env bash
# Live reader-cache probe. It makes the actual deferred web_fetch tool call the
# same loopback page twice in one -p session, then checks the reader's own
# CC_SIDE_CALL_LOG evidence. The test-only fixture intercepts only the fixed
# loopback URLs, so it needs no HTTP server and never lets Anthropic's native
# server-side fetch path bypass the reader.
#
#   test/e2e/cache-probe-reader.sh [model] [--short]
#
# The default long editorial guide exceeds provider cache minima. --short uses
# a deliberately tiny page and reports SKIP only when both reader prompts are
# below the selected reader model's known cache minimum (2,048 for Haiku,
# 1,024 for Sonnet and Opus). Run a live probe in tmux from a
# sandboxed shell. The driver creates no settings and requests --no-session;
# its evidence files are beneath its temporary directory. The runtime may still
# read the user's existing provider configuration.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
MODEL="anthropic/claude-sonnet-5"
MODEL_SET=0
SHORT=0
for argument in "$@"; do
	case "$argument" in
	--short) SHORT=1 ;;
	-*) echo "usage: cache-probe-reader.sh [model] [--short]" >&2; exit 2 ;;
	*)
		if [ "$MODEL_SET" = 1 ]; then
			echo "usage: cache-probe-reader.sh [model] [--short]" >&2
			exit 2
		fi
		MODEL="$argument"
		MODEL_SET=1
		;;
	esac
done

# NODE_BIN puts a specific Node first on PATH (the probe needs Node >= 22.19).
[ -n "${NODE_BIN:-}" ] && export PATH="$NODE_BIN:$PATH"
PI_BIN="${PI_BIN:-$REPO/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js}"
if [ -n "${CACHE_PROBE_WORK_DIR:-}" ]; then
	WORK="$CACHE_PROBE_WORK_DIR"
	mkdir "$WORK" # Evidence must go in a new directory, never overwrite a prior run.
else
	WORK="$(mktemp -d "${TMPDIR:-/tmp}/cache-probe-reader.XXXXXX")"
fi
PROJECT="$WORK/project"
mkdir -p "$PROJECT"

URL="https://handbook.example.com/editorial-guide"
if [ "$SHORT" = 1 ]; then
	URL="https://handbook.example.com/editorial-guide-short"
fi
QUESTION="What does section 12 require before publication?"
PROMPT="I maintain an editorial handbook at $URL and want to confirm its answer to one question is stable. Use tool_search to load web_fetch if it is deferred. Then call web_fetch twice in a row, sequentially and never in parallel, waiting for the first result before the second call. Both calls must use exactly this URL: $URL and exactly this prompt: $QUESTION Do not call any other web tool. After both calls succeed, reply with exactly done."

echo "model:   $MODEL"
echo "pi:      $(node "$PI_BIN" --version 2>/dev/null | tail -1)"
echo "workdir: $WORK"
status=0
(
	cd "$PROJECT"
	CC_SIDE_CALL_LOG="$WORK/reader.jsonl" node "$PI_BIN" --no-session --no-approve --no-extensions \
		-e "$REPO" \
		-e "$REPO/test/e2e/reader-cache-fetch-fixture.ts" \
		--model "$MODEL" --mode json -p "$PROMPT" > "$WORK/events.jsonl" 2> "$WORK/stderr.log"
) || {
	echo "pi exited non-zero (see $WORK/stderr.log)" >&2
	status=1
}
touch "$WORK/reader.jsonl"
if [ "$SHORT" = 1 ]; then
	if ! node "$REPO/test/e2e/cache-probe-reader.mjs" "$WORK/reader.jsonl" "$WORK/events.jsonl" --short; then
		status=1
	fi
elif ! node "$REPO/test/e2e/cache-probe-reader.mjs" "$WORK/reader.jsonl" "$WORK/events.jsonl"; then
	status=1
fi
exit "$status"
