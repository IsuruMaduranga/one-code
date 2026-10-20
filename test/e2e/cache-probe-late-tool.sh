#!/usr/bin/env bash
# Live late-tool cache probe. A test-only extension (late-tool-fixture.ts)
# registers and defers `late_echo` while the first bash call runs, so the tool
# arrives mid-session the way a late MCP server's tools do. The probe then
# checks the usual prefix rules (cache-probe.mjs) plus how the tool was
# announced: a reference-form `tool_addition` in a system message on a model
# that takes one, the deferred-tool addendum elsewhere. Either way the tool
# must ride `tools` as `defer_loading`, and every request must read what the
# one before it cached (findings §55 P1).
#
#   test/e2e/cache-probe-late-tool.sh [model] [--form tool_addition|addendum]
#
# --form fails the probe when the announcement took the other form. First-party
# Anthropic only: OpenAI caches `tools` as part of the prefix, so a late tool
# misses there by design (findings §55 P5). Costs one short four-request
# session (~30k tokens on a Claude model, mostly cache write). Run a live probe
# in tmux from a sandboxed shell.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
MODEL="anthropic/claude-sonnet-5-5"
MODEL_SET=0
FORM=()
usage() { echo "usage: cache-probe-late-tool.sh [model] [--form tool_addition|addendum]" >&2; exit 2; }
while [ $# -gt 0 ]; do
	case "$1" in
	--form)
		[ $# -ge 2 ] || usage
		FORM=(--late-tool-form "$2")
		shift
		;;
	-*) usage ;;
	*)
		[ "$MODEL_SET" = 0 ] || usage
		MODEL="$1"
		MODEL_SET=1
		;;
	esac
	shift
done

# NODE_BIN puts a specific Node first on PATH (the probe needs Node >= 22.19).
[ -n "${NODE_BIN:-}" ] && export PATH="$NODE_BIN:$PATH"
PI_BIN="${PI_BIN:-$REPO/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js}"
if [ -n "${CACHE_PROBE_WORK_DIR:-}" ]; then
	WORK="$CACHE_PROBE_WORK_DIR"
	mkdir "$WORK" # Evidence must go in a new directory, never overwrite a prior run.
else
	WORK="$(mktemp -d "${TMPDIR:-/tmp}/cache-probe-late-tool.XXXXXX")"
fi
PROJECT="$WORK/project"
mkdir -p "$PROJECT"
git -C "$PROJECT" init -q
printf '# Probe\n\nThrowaway project for the late-tool cache probe.\n' > "$PROJECT/CLAUDE.md"

# The sleep keeps the first request's turn open until the tool has arrived.
PROMPT='Run the shell command sleep 3 with the bash tool. After it finishes, if a tool named late_echo is available, call it with text hi (load it with tool_search first if it is deferred). Then run echo after-late with the bash tool. Then reply with exactly the word done.'

echo "model:   $MODEL"
echo "pi:      $(node "$PI_BIN" --version 2>/dev/null | tail -1)"
echo "workdir: $WORK"
status=0
(
	cd "$PROJECT"
	WIRE_DUMP="$WORK/wire.jsonl" node "$PI_BIN" --no-session --no-extensions \
		-e "$REPO" \
		-e "$REPO/test/e2e/dump-requests.ts" \
		-e "$REPO/test/e2e/late-tool-fixture.ts" \
		--model "$MODEL" --mode json -p "$PROMPT" > "$WORK/events.jsonl" 2> "$WORK/stderr.log"
) || {
	echo "pi exited non-zero (see $WORK/stderr.log)" >&2
	status=1
}
touch "$WORK/wire.jsonl"
node "$REPO/test/e2e/cache-probe.mjs" "$WORK/wire.jsonl" "$WORK/events.jsonl" --late-tool late_echo ${FORM[@]+"${FORM[@]}"} || status=1
exit "$status"
