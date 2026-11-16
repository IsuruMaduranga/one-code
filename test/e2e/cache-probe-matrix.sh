#!/usr/bin/env bash
# The pre-PR and pre-release cache check: test/e2e/cache-probe.sh on one model
# per provider family One Code is tested on (Anthropic, OpenAI, OpenAI Codex,
# OpenRouter, and Claude on OpenRouter), each against the repo's own pi.
# Prints each run and a one-line summary; exits non-zero when any probe fails.
# About 100k tokens in all, mostly cache writes. The `pre-pr-cache-check` skill (.claude/skills/) says when to run it
# and how to read a failure.
#
#   test/e2e/cache-probe-matrix.sh
#
# Every leg loads only this checkout's extensions (cache-probe.sh --repo-only),
# so the matrix tests the tree it runs from, never a copy registered with pi
# (a user package in ~/.pi, which may be another worktree or branch).
# CACHE_PROBE_REGISTERED=1 drops --repo-only from the per-provider legs and
# loads what pi's settings register instead. CACHE_PROBE_ONLY=<text> runs only
# the legs whose summary line contains <text> (e.g. `openrouter/deepseek`,
# `login`).
#
# The Anthropic run's late-tool phase takes the deferred-tool addendum (Sonnet 5
# rejects tool changes), so one more late-tool probe runs on a model that takes
# Claude Code's `tool_addition` and requires that form (findings §55 P1).
#
# A last leg runs the session (with its tool_search load), classifier and
# late-tool phases on the Anthropic login rather than an API key: pi sends some
# tool names differently on that path, so it needs its own wire check, and a
# tool batch that arrives mid-session must be announced there as Claude Code's
# `tool_addition` without a cache miss. It takes the login
# from the first agent dir whose auth.json holds an Anthropic login:
# CACHE_PROBE_LOGIN_AGENT_DIR, PI_CODING_AGENT_DIR, then the bundled app's
# ($ONECODE_STATE_DIR or ~/.onecode, /agent). It loads only this repo's
# extensions, unsets ANTHROPIC_API_KEY and ANTHROPIC_OAUTH_TOKEN, pins
# subagents to the probe model, and fails unless every request was a bearer
# request on that model. With no login it prints SKIP (CI has none);
# CACHE_PROBE_REQUIRE_LOGIN=1 turns that into a failure, and
# CACHE_PROBE_ONLY=login runs this leg alone.
#
# Override a model with CACHE_PROBE_ANTHROPIC, CACHE_PROBE_OPENAI,
# CACHE_PROBE_CODEX, CACHE_PROBE_OPENROUTER, CACHE_PROBE_OPENROUTER_QWEN, CACHE_PROBE_OPENROUTER_CLAUDE,
# CACHE_PROBE_TOOL_ADDITION or CACHE_PROBE_LOGIN.
# Each run includes the auto-mode classifier phase (cache-probe.sh). From a
# sandboxed shell, run it inside tmux.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"

# model|flags: OpenRouter has no native tool loading, so a tool_search load
# re-caches the conversation there by design (findings §7); its probe checks
# the steady state without a load. A Claude model on OpenRouter is its own
# request shape: Chat Completions carrying Anthropic's cache_control markers,
# which the classifier and the side calls place themselves. Qwen on OpenRouter
# is served by hosts that cache only with breakpoints (Reka) as well as by
# implicit ones (findings §93); each line names the host that served it.
RUNS=(
	"${CACHE_PROBE_ANTHROPIC:-anthropic/claude-sonnet-5}|"
	"${CACHE_PROBE_OPENAI:-openai/gpt-6.1-sol}|"
	"${CACHE_PROBE_CODEX:-openai-codex/gpt-6.1-sol}|"
	"${CACHE_PROBE_OPENROUTER:-openrouter/deepseek/deepseek-v4.1-flash}|--no-load"
	"${CACHE_PROBE_OPENROUTER_QWEN:-openrouter/qwen/qwen3.8-27b}|--no-load"
	"${CACHE_PROBE_OPENROUTER_CLAUDE:-openrouter/anthropic/claude-haiku-4.5}|--no-load"
)

summary=()
failed=0
REPO_ONLY=(--repo-only)
[ "${CACHE_PROBE_REGISTERED:-0}" = 1 ] && REPO_ONLY=()
# Whether the leg whose summary line is "$1" runs (CACHE_PROBE_ONLY).
selected() { [ -z "${CACHE_PROBE_ONLY:-}" ] || [[ "$1" == *"$CACHE_PROBE_ONLY"* ]]; }
for run in "${RUNS[@]}"; do
	model="${run%%|*}"
	flags="${run#*|}"
	selected "$model" || continue
	echo "=== $model ${flags}"
	# shellcheck disable=SC2086
	if bash "$REPO/test/e2e/cache-probe.sh" "$model" $flags ${REPO_ONLY[@]+"${REPO_ONLY[@]}"}; then
		summary+=("PASS  $model")
	else
		summary+=("FAIL  $model")
		failed=1
	fi
	echo
done
addition_model="${CACHE_PROBE_TOOL_ADDITION:-anthropic/claude-sonnet-5-5}"
# cache-probe-late-tool.sh loads only this checkout's extensions itself.
if selected "$addition_model late tool"; then
	echo "=== $addition_model late tool (tool_addition)"
	if bash "$REPO/test/e2e/cache-probe-late-tool.sh" "$addition_model" --form tool_addition; then
		summary+=("PASS  $addition_model late tool")
	else
		summary+=("FAIL  $addition_model late tool")
		failed=1
	fi
	echo
fi

# The agent dir whose auth.json holds an Anthropic login (pi's `type: "oauth"`
# entry); never prints a credential.
login_agent_dir() {
	local dir
	for dir in "${CACHE_PROBE_LOGIN_AGENT_DIR:-}" "${PI_CODING_AGENT_DIR:-}" "${ONECODE_STATE_DIR:-$HOME/.onecode}/agent"; do
		[ -n "$dir" ] && [ -f "$dir/auth.json" ] || continue
		if node -e 'const a = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).anthropic; process.exit(a && (a.type === "oauth" || typeof a.refresh === "string") ? 0 : 1)' "$dir/auth.json" 2>/dev/null; then
			echo "$dir"
			return 0
		fi
	done
	return 1
}
login_model="${CACHE_PROBE_LOGIN:-anthropic/claude-haiku-5-5}"
if ! selected "$login_model on the Anthropic login"; then
	: # not selected
elif login_dir="$(login_agent_dir)"; then
	echo "=== $login_model on the Anthropic login"
	echo "login:   $login_dir/auth.json (anthropic login)"
	if env -u ANTHROPIC_API_KEY -u ANTHROPIC_OAUTH_TOKEN -u CLAUDE_CODE_SUBAGENT_MODEL \
		PI_CODING_AGENT_DIR="$login_dir" ONECODE_SUBAGENT_MODEL="$login_model" \
		bash "$REPO/test/e2e/cache-probe.sh" "$login_model" --repo-only --expect-auth login --expect-one-model --no-review --no-reader --late-tool-form tool_addition; then
		summary+=("PASS  $login_model on the Anthropic login")
	else
		summary+=("FAIL  $login_model on the Anthropic login")
		failed=1
	fi
else
	echo "=== $login_model on the Anthropic login"
	echo "!!! SKIP: no Anthropic login found (looked in CACHE_PROBE_LOGIN_AGENT_DIR, PI_CODING_AGENT_DIR"
	echo "!!! and ${ONECODE_STATE_DIR:-$HOME/.onecode}/agent). The login path was NOT checked."
	summary+=("SKIP  $login_model on the Anthropic login: no login found, NOT checked")
	[ "${CACHE_PROBE_REQUIRE_LOGIN:-0}" = 1 ] && failed=1
fi
echo
echo "=== summary"
printf '%s\n' ${summary[@]+"${summary[@]}"}
exit $failed
