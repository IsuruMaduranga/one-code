#!/usr/bin/env bash
# The pre-PR and pre-release cache check: test/e2e/cache-probe.sh on one model
# per provider family One Code is tested on (Anthropic, OpenAI, OpenRouter),
# each against the repo's own pi. Prints each run and a one-line summary;
# exits non-zero when any probe fails. About 75k tokens in all, mostly cache
# writes. The `pre-pr-cache-check` skill (.claude/skills/) says when to run it
# and how to read a failure.
#
#   test/e2e/cache-probe-matrix.sh
#
# Override a model with CACHE_PROBE_ANTHROPIC, CACHE_PROBE_OPENAI or
# CACHE_PROBE_OPENROUTER. From a sandboxed shell, run it inside tmux.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"

# model|flags: OpenRouter has no native tool loading, so a tool_search load
# re-caches the conversation there by design (findings §7); its probe checks
# the steady state without a load.
RUNS=(
	"${CACHE_PROBE_ANTHROPIC:-anthropic/claude-sonnet-5}|"
	"${CACHE_PROBE_OPENAI:-openai/gpt-6.1-sol}|"
	"${CACHE_PROBE_OPENROUTER:-openrouter/deepseek/deepseek-v4.1-flash}|--no-load"
)

summary=()
failed=0
for run in "${RUNS[@]}"; do
	model="${run%%|*}"
	flags="${run#*|}"
	echo "=== $model ${flags}"
	# shellcheck disable=SC2086
	if bash "$REPO/test/e2e/cache-probe.sh" "$model" $flags; then
		summary+=("PASS  $model")
	else
		summary+=("FAIL  $model")
		failed=1
	fi
	echo
done
echo "=== summary"
printf '%s\n' "${summary[@]}"
exit $failed
