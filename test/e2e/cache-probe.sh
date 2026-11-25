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
# the classifier's own ONECODE_AUTO_MODE_LOG). `--no-classifier` skips it.
# A review phase spawns one subagent that runs a gated command, and checks the
# hand-back review reads the cache its spawn and the child's call wrote
# (cache-probe-classifier.mjs --review). `--no-review` skips it.
# A reader phase repeats a web_fetch reader call against a deterministic page
# fixture (cache-probe-reader.sh). `--no-reader` skips it.
# A fork phase asks the model to fork once and checks the fork's first request
# reads the parent's cached prompt (test/e2e/cache-probe-fork.mjs over the run's
# session files, Codex on its default WebSocket transport): the fork's tools
# must match the parent's, and on Codex the fork must send the parent's session
# id (findings §75). `--no-fork` skips it.
# On a first-party Anthropic model a late-tool phase registers a tool mid-session
# and checks it is announced without a cache miss (cache-probe-late-tool.sh).
# `--no-late-tool` skips it; `--late-tool-form tool_addition|addendum` also
# requires that announcement form.
#
# openai-codex models talk over WebSocket by default, which dump-requests.ts
# cannot see; the probe project sets `transport: "sse"` and is trusted with
# --approve so the session's requests go through fetch.
#
# `--repo-only` loads only this repo's extensions (`--no-extensions -e <repo>`),
# for an agent dir (PI_CODING_AGENT_DIR) whose settings name another package.
# `--expect-auth login|key` records the credential shape of every request in the
# session, classifier and late-tool phases (dump-requests.ts WIRE_AUTH_DUMP, never a value)
# and fails unless each one used the Anthropic login (bearer, no x-api-key) or
# the API key (test/e2e/cache-probe-auth.mjs). `--expect-one-model`, with it,
# also fails unless every one went to the probe's own model: only for a run
# that pins its side models to the probe model (the matrix's login leg), since
# a plain run's classifier and subagents pick their own.
#
# `CACHE_PROBE_SANDBOX=1` turns the command sandbox on in every probe project,
# which adds the sandbox section to message 1 and its parameters to the shell tools.
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
REVIEW=1
READER=1
FORK=1
LATE_TOOL=0
REPO_ARGS=()
EXPECT_AUTH=""
ONE_MODEL=0
LATE_FORM=()
case "$MODEL" in
anthropic/*) LATE_TOOL=1 ;;
esac
expect_auth_next=0
late_form_next=0
for arg in "$@"; do
	if [ "$expect_auth_next" = 1 ]; then
		EXPECT_AUTH="$arg"
		expect_auth_next=0
	elif [ "$late_form_next" = 1 ]; then
		LATE_FORM=(--form "$arg")
		late_form_next=0
	elif [ "$arg" = "--expect-auth" ]; then
		expect_auth_next=1
	elif [ "$arg" = "--expect-one-model" ]; then
		ONE_MODEL=1
	elif [ "$arg" = "--late-tool-form" ]; then
		late_form_next=1
	elif [ "$arg" = "--repo-only" ]; then
		REPO_ARGS=(--no-extensions -e "$REPO")
	elif [ "$arg" = "--no-classifier" ]; then
		CLASSIFIER=0
	elif [ "$arg" = "--no-review" ]; then
		REVIEW=0
	elif [ "$arg" = "--no-reader" ]; then
		READER=0
	elif [ "$arg" = "--no-fork" ]; then
		FORK=0
	elif [ "$arg" = "--no-late-tool" ]; then
		LATE_TOOL=0
	elif [ "$arg" = "--no-load" ]; then
		PROMPT='Run echo probe-one with the bash tool. Then run echo probe-two with the bash tool. Then reply with exactly the word done.'
	else
		CHECK_ARGS+=("$arg")
	fi
done
if [ "$expect_auth_next" = 1 ]; then
	echo "--expect-auth needs a value: login or key" >&2
	exit 2
fi
if [ "$late_form_next" = 1 ]; then
	echo "--late-tool-form needs a value: tool_addition or addendum" >&2
	exit 2
fi
case "$EXPECT_AUTH" in
"" | login | key) ;;
*)
	echo "--expect-auth takes login or key, not '$EXPECT_AUTH'" >&2
	exit 2
	;;
esac
case "$ONE_MODEL:$EXPECT_AUTH" in
1:)
	echo "--expect-one-model reads the requests --expect-auth records; pass both" >&2
	exit 2
	;;
esac

if [ -n "${CACHE_PROBE_WORK_DIR:-}" ]; then
	WORK="$CACHE_PROBE_WORK_DIR"
	mkdir "$WORK" # Must be new: never overwrite an earlier probe's evidence.
else
	WORK="$(mktemp -d "${TMPDIR:-/tmp}/cache-probe.XXXXXX")"
fi
# Every phase that loads dump-requests.ts appends each response's headers and
# usage here (on Codex, per-item cache attribution): a miss's evidence.
export WIRE_RESPONSE_DUMP="$WORK/responses.jsonl"
# A throwaway git project; on Codex it asks for SSE, which dump-requests.ts can
# see, unless the second argument is "websocket" (Codex's default, which users run).
probe_project() {
	mkdir -p "$1"
	git -C "$1" init -q
	printf '# Probe\n\nThrowaway project for the prompt-cache probe.\n' > "$1/CLAUDE.md"
	# CACHE_PROBE_SANDBOX=1: every phase runs with the command sandbox on (macOS, Linux).
	if [ -n "${CACHE_PROBE_SANDBOX:-}" ]; then
		mkdir -p "$1/.claude"
		printf '{"sandbox":{"enabled":true}}\n' > "$1/.claude/settings.json"
	fi
	case "$MODEL:${2:-}" in
	openai-codex/*:websocket) ;;
	openai-codex/*)
		mkdir -p "$1/.pi"
		printf '{"transport":"sse"}\n' > "$1/.pi/settings.json"
		;;
	esac
}
PROJECT="$WORK/project"
probe_project "$PROJECT"
APPROVE=()
case "$MODEL" in
openai-codex/*) APPROVE=(--approve) ;;
esac

# --expect-auth: where every recorded request notes its credential shape, and the
# dump the auto-mode phases load to record theirs.
AUTH_DUMP=""
PHASE_DUMP=()
[ -n "$EXPECT_AUTH" ] && AUTH_DUMP="$WORK/auth.jsonl"
# On Codex the phases load it too, so their responses are recorded.
if [ -n "$EXPECT_AUTH" ] || [[ "$MODEL" == openai-codex/* ]]; then
	PHASE_DUMP=(-e "$REPO/test/e2e/dump-requests.ts")
fi

echo "model:   $MODEL"
echo "pi:      $(node "$PI_BIN" --version 2>/dev/null | tail -1)"
echo "workdir: $WORK"
(
	cd "$PROJECT"
	WIRE_DUMP="$WORK/wire.jsonl" WIRE_AUTH_DUMP="$AUTH_DUMP" node "$PI_BIN" ${REPO_ARGS[@]+"${REPO_ARGS[@]}"} -e "$REPO/test/e2e/dump-requests.ts" ${APPROVE[@]+"${APPROVE[@]}"} --model "$MODEL" --mode json -p "$PROMPT" > "$WORK/events.jsonl" 2> "$WORK/stderr.log"
) || echo "pi exited non-zero (see $WORK/stderr.log)"

status=0
node "$REPO/test/e2e/cache-probe.mjs" "$WORK/wire.jsonl" "$WORK/events.jsonl" ${CHECK_ARGS[@]+"${CHECK_ARGS[@]}"} || status=1

# One auto-mode run in its own project, then the classifier cache check over
# its ONECODE_AUTO_MODE_LOG: auto_phase <name> <prompt> [check flags…].
auto_phase() {
	local name="$1" prompt="$2"
	shift 2
	echo "--- $name phase"
	mkdir -p "$WORK/$name-project"
	git -C "$WORK/$name-project" init -q
	(
		cd "$WORK/$name-project"
		WIRE_DUMP="$WORK/$name-wire.jsonl" WIRE_AUTH_DUMP="$AUTH_DUMP" ONECODE_AUTO_MODE_LOG="$WORK/$name.jsonl" node "$PI_BIN" ${REPO_ARGS[@]+"${REPO_ARGS[@]}"} ${PHASE_DUMP[@]+"${PHASE_DUMP[@]}"} --model "$MODEL" --mode json --permission-mode auto -p "$prompt" > "$WORK/$name-events.jsonl" 2> "$WORK/$name-stderr.log"
	) || echo "pi exited non-zero in the $name phase (see $WORK/$name-stderr.log)"
	touch "$WORK/$name.jsonl"
	node "$REPO/test/e2e/cache-probe-classifier.mjs" "$WORK/$name.jsonl" "$@" || status=1
}
if [ "$CLASSIFIER" = 1 ]; then
	auto_phase classifier 'Run each of these four commands in its own separate bash call, one after another (never combine them, never in parallel), then reply with exactly the word done: curl -sI https://example.com ; curl -sI https://example.org ; curl -sI https://www.iana.org ; curl -sI https://httpbin.org/get'
fi
if [ "$REVIEW" = 1 ]; then
	auto_phase review 'Call the Agent tool exactly once, with subagent_type general-purpose and this prompt: "Run curl -sI https://example.com with the bash tool, then reply with exactly the word done." After it returns, reply with exactly the word done.' --review
fi
if [ "$FORK" = 1 ]; then
	echo "--- fork phase"
	# Codex's default WebSocket transport, where a fork shares its parent's session
	# id (and cached socket); the check reads the session files, not a wire dump.
	probe_project "$WORK/fork-project" websocket
	(
		cd "$WORK/fork-project"
		WIRE_DUMP="$WORK/fork-wire.jsonl" WIRE_AUTH_DUMP="$AUTH_DUMP" node "$PI_BIN" ${REPO_ARGS[@]+"${REPO_ARGS[@]}"} ${PHASE_DUMP[@]+"${PHASE_DUMP[@]}"} --model "$MODEL" --mode json --session-dir "$WORK/fork-sessions" -p 'Call the Agent tool exactly once, with subagent_type "fork" and this prompt: "Run echo fork-probe with the bash tool, then reply with exactly the word done." After it returns, reply with exactly the word done.' > "$WORK/fork-events.jsonl" 2> "$WORK/fork-stderr.log"
	) || echo "pi exited non-zero in the fork phase (see $WORK/fork-stderr.log)"
	node "$REPO/test/e2e/cache-probe-fork.mjs" "$WORK/fork-sessions" --model "$MODEL" || status=1
fi
if [ "$READER" = 1 ]; then
	echo "--- reader phase"
	CACHE_PROBE_WORK_DIR="$WORK/reader" bash "$REPO/test/e2e/cache-probe-reader.sh" "$MODEL" || status=1
fi
if [ "$LATE_TOOL" = 1 ]; then
	echo "--- late-tool phase"
	WIRE_AUTH_DUMP="$AUTH_DUMP" CACHE_PROBE_WORK_DIR="$WORK/late-tool" bash "$REPO/test/e2e/cache-probe-late-tool.sh" "$MODEL" ${LATE_FORM[@]+"${LATE_FORM[@]}"} || status=1
fi
if [ -n "$EXPECT_AUTH" ] && [ "$ONE_MODEL" = 1 ]; then
	echo "--- credential and model check (session, auto-mode, fork and late-tool phases)"
	node "$REPO/test/e2e/cache-probe-auth.mjs" "$AUTH_DUMP" --auth "$EXPECT_AUTH" --model "${MODEL#*/}" || status=1
elif [ -n "$EXPECT_AUTH" ]; then
	echo "--- credential check (session, auto-mode, fork and late-tool phases)"
	node "$REPO/test/e2e/cache-probe-auth.mjs" "$AUTH_DUMP" --auth "$EXPECT_AUTH" || status=1
fi
if [ "$status" != 0 ] && [ -s "$WIRE_RESPONSE_DUMP" ]; then
	echo "responses (headers, usage, Codex per-item cache attribution): $WIRE_RESPONSE_DUMP"
fi
exit $status
