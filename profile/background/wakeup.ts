/**
 * One Code's schedule_wakeup text (the profile's `text.background.wakeup`):
 * Claude Code's, with our tool names. The description is Claude Code's for a
 * session whose prompt-cache TTL it cannot name (its third branch): One Code
 * runs on any provider, so the 1-hour and 5-minute branches, which assume
 * Anthropic billing, never apply as such.
 */

import type { WakeupMissingField, WakeupText } from "../../extensions/background/text.ts";

const MISSING: Record<WakeupMissingField, string> = {
	delayAndReason: "`delaySeconds` and `reason` are required when `stop` is not true.",
	prompt: "`prompt` is required when `stop` is not true.",
	noop: "`noop` is required when `stop` is not true.",
};

export const wakeup: WakeupText = {
	description: `Schedule when to resume work in /loop dynamic mode — the user invoked /loop without an interval, asking you to self-pace iterations of a specific task.

Do NOT schedule a short-interval wakeup to poll for background work you started — when harness-tracked work finishes, you are re-invoked automatically, so polling is wasted. Instead schedule a long fallback (1200s+) so the loop survives if the work hangs or never notifies. The exception is external work the harness cannot track (a CI run, a deploy, a remote queue) — there, pick a delay matched to how fast that state actually changes.

Pass the same /loop prompt back via \`prompt\` each turn so the next firing repeats the task. For an autonomous /loop (no user prompt), pass the literal sentinel \`<<autonomous-loop-dynamic>>\` as \`prompt\` instead — the runtime resolves it back to the autonomous-loop instructions at fire time. (There is a similar \`<<autonomous-loop>>\` sentinel for cron_create-based autonomous loops; do not confuse the two — schedule_wakeup always uses the \`-dynamic\` variant.) To end the loop, call this tool with \`stop: true\` (omit every other field) — the loop ends immediately and no further wakeups fire.

Set \`noop: true\` if nothing changed — you checked and there's nothing to report ("no change", "still waiting", "quiet hold"). Set \`noop: false\` if something happened worth keeping — you edited a file, posted a message, advanced state, or surfaced a finding. Consecutive \`noop: true\` ticks are collapsed in the user's terminal view and tracked as a streak, so long quiet holds stay legible to the user without scrolling. Omit \`noop\` when stopping (\`stop: true\`).

## Picking delaySeconds

The Anthropic prompt cache decides how expensive a wake-up is: waking inside the cache TTL re-reads your conversation context cached (fast, cheap); waking past it re-reads everything uncached. The TTL depends on how the session is billed: Claude subscriber sessions get a 1-hour TTL (dropping to 5 minutes during usage overage), while API-key, Bedrock, and Vertex sessions default to 5 minutes.

In either regime: never schedule extra wakeups just to keep the cache warm — they cost more than the cache miss they avoid. Match the delay to what you're actually waiting for: when actively polling external state the harness can't notify you about (a CI run, a deploy, a remote queue), pick the delay from how fast that state actually changes; for idle ticks with no specific signal to watch, default to **1200s–1800s** (20–30 min) — the user can always interrupt if they need you sooner.

On a 5-minute TTL only, two refinements: under 300s (60s–270s) the cache stays warm, so prefer 270s over 300s when actively polling (300s is the worst-of-both — you pay the miss without amortizing it); and commit to 1200s+ rather than repeated ~300s waits, so one cache miss buys a long wait.

The runtime clamps to [60, 3600], so you don't need to clamp yourself.

## The reason field

One short sentence on what you chose and why. Goes to telemetry and is shown back to the user. "watching CI run" beats "waiting." The user reads this to understand what you're doing without having to predict your cadence in advance — make it specific.
`,
	params: {
		delaySeconds: "Seconds from now to wake up. Clamped to [60, 3600] by the runtime. Required unless `stop` is true.",
		reason: "One short sentence explaining the chosen delay. Goes to telemetry and is shown to the user. Be specific. Required unless `stop` is true.",
		prompt:
			"The /loop input to fire on wake-up. Pass the same /loop input verbatim each turn so the next firing re-enters the skill and continues the loop. For autonomous /loop (no user prompt), pass the literal sentinel `<<autonomous-loop-dynamic>>` instead (the dynamic-pacing variant, not the cron_create-mode `<<autonomous-loop>>`). Required unless `stop` is true.",
		stop: "Set to true to end the dynamic loop immediately instead of scheduling another wakeup. When true, all other fields are ignored and no further wakeups fire.",
		noop: "true = nothing changed (you checked and there is nothing to report). false = something happened worth keeping (edited a file, posted a message, advanced state, surfaced a finding). Consecutive noop:true ticks are collapsed in the user's terminal view and tracked as a streak. Required unless `stop` is true.",
	},
	scheduled: ({ clock, inSeconds, clampedTo }) => {
		const clamped = clampedTo !== undefined ? ` (clamped to ${clampedTo}s from your requested value)` : "";
		return `Next wakeup scheduled for ${clock} (in ${inSeconds}s)${clamped}. Nothing more to do this turn — the harness re-invokes you when the wakeup fires or a task-notification arrives.`;
	},
	missing: (field) => MISSING[field],
	agedOut: "Wakeup not scheduled. The loop reached its maximum duration — the loop has ended; do not re-issue.",
	stopped: ({ cancelled }) => {
		const monitor = "If you armed a monitor for this loop, task_stop it now; otherwise nothing more to do this turn.";
		if (cancelled === 0)
			return `Loop stopped — any dynamic loop in this session is ended; there was no pending wakeup to cancel. If you are running a fixed-interval /loop (a recurring cron), it is NOT stopped by this call — cancel it with cron_delete. ${monitor}`;
		return `Loop stopped — cancelled ${cancelled} pending wakeup(s); no further dynamic-loop wakeups scheduled. ${monitor}`;
	},
};
