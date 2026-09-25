/**
 * Claude Code's `/loop` bundled skill (2.1.282): the
 * prompt each form of `/loop` sends the model. The model then schedules the
 * loop itself (cron_create, or schedule_wakeup for self-pacing) and runs the
 * first iteration, as in Claude Code (findings §21).
 *
 * The templates are Claude Code's, verbatim; only the tool names are ours. Dropped branches: the cloud-schedule offer and the
 * "tell the user" addenda (Claude Code gates them on claude.ai features One
 * Code has no counterpart for), and `TaskList`, which becomes task_output
 * (our task_list is the to-do list and shows no monitor; decisions/tools.md,
 * "Session cron").
 *
 * Pure: no pi imports.
 */

import { AUTONOMOUS_PREAMBLE, AUTONOMOUS_PREAMBLE_PERSISTENT } from "./loop-preamble.ts";
import { LOOP_FILE_DYNAMIC_SENTINEL, LOOP_FILE_SENTINEL, AUTONOMOUS_LOOP, AUTONOMOUS_LOOP_DYNAMIC, type LoopFile } from "./loop-fire.ts";
import { RECURRING_MAX_AGE_DAYS as Ofe } from "./cron.ts";
import { envFlag } from "./wakeup.ts";

const yl = "schedule_wakeup";
const ky = "cron_create";
const vA = "cron_delete";
const il = "monitor";
const Um = "task_stop";
const jb = "task_output";
const PVe = AUTONOMOUS_LOOP;
const gve = AUTONOMOUS_LOOP_DYNAMIC;
/** Claude Code's monitor-TTL branch is off here: our monitor has `persistent`. */
const b8 = (): boolean => false;
const gDe = (): number => 0;
const Ktn = (ms: number): string => `${ms}ms`;
/** The interval a bare `/loop` uses. */
const N = "10m";

export const LOOP_SKILL = {
	name: "loop",
	description: "Run a prompt or slash command on a recurring interval (e.g. /loop 5m /foo). Omit the interval to let the model self-pace.",
	whenToUse: 'When the user wants to set up a recurring task, poll for status, or run something repeatedly on an interval (e.g. "check the deploy every 5 minutes", "keep running /babysit-prs"). Do NOT invoke for one-off tasks.',
	argumentHint: "[interval] [prompt]",
} as const;

/** The autonomous-loop instructions: the persistent variant with `CLAUDE_CODE_LOOP_PERSISTENT` on. */
export function autonomousPreamble(env: NodeJS.ProcessEnv = process.env): string {
	return envFlag(env.CLAUDE_CODE_LOOP_PERSISTENT, false) ? AUTONOMOUS_PREAMBLE_PERSISTENT : AUTONOMOUS_PREAMBLE;
}

const INTERVAL_ONLY=/^\d+[smhd]$/;
const EVERY_ONLY=/^every\s+(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\s*$/i;
function normalizeEvery(e: RegExpMatchArray): string {let o=e[1],t=e[2].toLowerCase();if(t.startsWith("s"))return`${o}s`;if(t.startsWith("h"))return`${o}h`;if(t.startsWith("d"))return`${o}d`;return`${o}m`}
const I="| Interval pattern      | Cron expression     | Notes                                    |\n|-----------------------|---------------------|------------------------------------------|\n| `Nm` where N \u2264 59   | `*/N * * * *`     | every N minutes                          |\n| `Nm` where N \u2265 60   | `0 */H * * *`     | round to hours (H = N/60, must divide 24)|\n| `Nh` where N \u2264 23   | `0 */N * * *`     | every N hours                            |\n| `Nd`                | `0 0 */N * *`     | every N days at midnight local           |\n| `Ns`                | treat as `ceil(N/60)m` | cron minimum granularity is 1 minute  |\n\n**If the interval doesn't cleanly divide its unit** (e.g. `7m` \u2192 `*/7 * * * *` gives uneven gaps at :56\u2192:00; `90m` \u2192 1.5h which cron can't express), pick the nearest clean interval and tell the user what you rounded to before scheduling.";

function armMonitor(): string {return b8()?`arm one now with \`timeout_ms: ${gDe()}\``:"arm one now with `persistent: true`"}
function rearmReminder(e: "iterations" | "ticks"): string {if(b8())return`A monitor expires after at most ${Ktn(gDe())} and tells you; on later ${e} call ${jb} first and re-arm only if no monitor for it is still running.`;return e==="iterations"?`Arm once; on later iterations call ${jb} first and skip this step if a monitor is already running.`:`Arm once; on later ticks call ${jb} first and skip if a monitor is already running.`}
function explicitPrompt(e: string): string {let o=`The user wants you to self-pace. Decide what makes the next iteration worth running \u2014 a passage of time, or an observable event.

1. **Run the parsed prompt now.** If it's a slash command, invoke it via the skill tool; otherwise act on it directly.
2. **If the next run is gated on an event** (CI finishing, a log line matching, a file changing, a PR comment) and no ${il} is already running for it: ${armMonitor()}. Its events arrive as \`<task-notification>\` messages and wake this loop immediately \u2014 you do not wait for the ${yl} deadline. ${rearmReminder("iterations")}
3. **Briefly confirm**: that you're self-pacing, whether a ${il} is the primary wake signal, that you ran the task now, and what fallback delay you're about to pick. Write this as text *before* calling ${yl} \u2014 the turn ends as soon as that tool returns.
4. **Then, as the last action of this turn, decide whether the loop continues.** If the task needs another iteration, call ${yl} with:
   - \`delaySeconds\`: with a ${il} armed this is the **fallback heartbeat** \u2014 how long to wait if no event fires (lean 1200\u20131800s; idle ticks more frequent than the task needs are pure overhead). Without a ${il} this is the cadence \u2014 pick based on what you observed. Read the tool's own description for cache-aware delay guidance.
   - \`reason\`: one short sentence on why you picked that delay.
   - \`prompt\`: the full original /loop input verbatim, prefixed with \`/loop \` so the next firing re-enters this skill and continues the loop. For example, if the user typed \`/loop check the deploy\`, pass \`/loop check the deploy\` as the prompt.
   - \`noop\`: \`true\` if this tick changed nothing ("still waiting", "quiet hold"); \`false\` if it did something worth keeping. Consecutive \`noop: true\` ticks collapse in the terminal.
   If it doesn't need another iteration, stop instead (step 6) \u2014 re-arming is a per-turn choice, not a default.
5. **If you were woken by a \`<task-notification>\`** rather than this prompt: handle the event in the context of the loop task, then make the same decision. If the loop should continue, call ${yl} again with the same \`prompt\` and the same 1200\u20131800s \`delaySeconds\` from step 4 (the ${il} remains the wake signal; the new wakeup is only the fallback heartbeat). If the event means the work is finished, stop (step 6).
6. **To stop the loop** \u2014 the task is complete, further iterations can't make progress, or the user asked you to stop \u2014 call ${yl} with \`stop: true\` (no other fields) and ${Um} any ${il} you armed (use ${jb} to find the task ID if it is no longer in context). Stopping is the loop's normal ending \u2014 the user can restart it anytime with /loop.`;return`# /loop \u2014 schedule a recurring or self-paced prompt

Parse the input below into \`[interval] <prompt\u2026>\` and schedule it.

## Parsing (in priority order)

1. **Leading token**: if the first whitespace-delimited token matches \`^\\d+[smhd]$\` (e.g. \`5m\`, \`2h\`), that's the interval; the rest is the prompt.
2. **Trailing "every" clause**: otherwise, if the input ends with \`every <N><unit>\` or \`every <N> <unit-word>\` (e.g. \`every 20m\`, \`every 5 minutes\`, \`every 2 hours\`), extract that as the interval and strip it from the prompt. Only match when what follows "every" is a time expression \u2014 \`check every PR\` has no interval.
3. **No interval**: otherwise, the entire input is the prompt and you'll self-pace dynamically (see "Dynamic mode" below).

If the resulting prompt is empty, show usage \`/loop [interval] <prompt>\` and stop.

Examples:
- \`5m /babysit-prs\` \u2192 interval \`5m\`, prompt \`/babysit-prs\` (rule 1)
- \`check the deploy every 20m\` \u2192 interval \`20m\`, prompt \`check the deploy\` (rule 2)
- \`run tests every 5 minutes\` \u2192 interval \`5m\`, prompt \`run tests\` (rule 2)
- \`check the deploy\` \u2192 no interval \u2192 dynamic mode, prompt \`check the deploy\` (rule 3)
- \`check every PR\` \u2192 no interval \u2192 dynamic mode, prompt \`check every PR\` (rule 3 \u2014 "every" not followed by time)
- \`5m\` \u2192 empty prompt \u2192 show usage

## Fixed-interval mode (rules 1 and 2)

Convert the interval to a cron expression:

${I}

Then:
1. Call ${ky} with: \`cron\` (the expression above), \`prompt\` (the parsed prompt verbatim), \`recurring: true\`.
2. Briefly confirm: what's scheduled, the cron expression, the human-readable cadence, that recurring tasks auto-expire after ${Ofe} days, and that the user can cancel sooner with ${vA} (include the job ID).
3. **Then immediately execute the parsed prompt now** \u2014 don't wait for the first cron fire. If it's a slash command, invoke it via the skill tool; otherwise act on it directly.

## Dynamic mode (rule 3 \u2014 no interval)

${o}

## Input

${e}`}
function noPromptBody(e: LoopFile | null, o: boolean, t: string): string {let s: string=e?`## Loop tasks (from ${e.path})`:"## Autonomous-loop instructions (for the immediate execution and every fire)";let r: string;if(e)r=e.content;else r=autonomousPreamble();let h=e?"the loop.md tasks":"the autonomous check";if(o){let c=e?LOOP_FILE_DYNAMIC_SENTINEL:gve,O=e?`# /loop \u2014 loop.md tasks with dynamic pacing

The user invoked \`/loop\` with no prompt and no interval and has a loop-tasks file at \`${e.path}\`. Run those tasks now, then self-pace the next iteration via ${yl} \u2014 no cron.`:`# /loop \u2014 autonomous default with dynamic pacing

The user invoked \`/loop\` with no prompt and no interval. Run the autonomous check now, then self-pace the next iteration via ${yl} \u2014 no cron.`,b=e?`that you're running tasks from \`${e.path}\` in dynamic-pacing mode, that you ran the first tick now`:"that this is the autonomous default in dynamic-pacing mode, that you ran the check now",_=`1. **Run ${h} now**, following the instructions inlined below.
2. **If the next tick is gated on an event** (CI finishing, a PR comment, a log line) and no ${il} is already running for it: ${armMonitor()}. Its events wake this loop immediately \u2014 you do not wait for the ${yl} deadline. ${rearmReminder("ticks")}
3. **Briefly confirm**: ${b}, whether a ${il} is the primary wake signal, and what fallback delay you're about to pick. Write this as text *before* calling ${yl} \u2014 the turn ends as soon as that tool returns.
4. **Then, as the last action of this turn, decide whether the loop continues.** If the next check is worth running, call ${yl} with:
   - \`delaySeconds\`: with a ${il} armed this is the fallback heartbeat (lean 1200\u20131800s). Without one, pick based on what you observed this turn \u2014 quiet branch? wait longer. Lots in flight? wait shorter. Read the tool's own description for cache-aware delay guidance.
   - \`reason\`: one short sentence on why you picked that delay.
   - \`prompt\`: the literal string \`${c}\` \u2014 the dynamic-mode sentinel expands at fire time to the full instructions (first fire / first fire post-compact / loop.md edited) or a dynamic-pacing-specific short reminder (subsequent fires). Do not pass the full instructions; that is handled automatically.
   - \`noop\`: \`true\` if this tick changed nothing ("still waiting", "quiet hold"); \`false\` if it did something worth keeping. Consecutive \`noop: true\` ticks collapse in the terminal.
   If it isn't, stop instead (step 6) \u2014 re-arming is a per-turn choice, not a default.
5. **If woken by a \`<task-notification>\`** rather than this prompt: handle the event, then make the same decision. If the loop should continue, call ${yl} again with \`${c}\` and the same 1200\u20131800s \`delaySeconds\` (the ${il} remains the wake signal; the new wakeup is only the fallback heartbeat). If the event means the work is finished, stop (step 6).
6. **To stop the loop** \u2014 the task is complete, further iterations can't make progress, or the user asked you to stop \u2014 call ${yl} with \`stop: true\` (no other fields) and ${Um} any ${il} you armed (use ${jb} to find the task ID if it is no longer in context). Stopping is the loop's normal ending \u2014 the user can restart it anytime with /loop.`;return`${O}

## Action

${_}

${s}

${r}`}let l=e?LOOP_FILE_SENTINEL:PVe,u=e?`# /loop \u2014 schedule loop.md tasks

The user invoked \`/loop\` with no prompt (input was empty or just the interval \`${t}\`) and has a loop-tasks file at \`${e.path}\`. Schedule a recurring cron that runs those tasks each tick, then run the first tick immediately.`:`# /loop \u2014 schedule the autonomous default

The user invoked \`/loop\` with no prompt (input was empty or just the interval \`${t}\`). Schedule the autonomous-loop default and then run the first autonomous check immediately.`,k=e?"it expands at fire time to the full loop.md contents on first delivery (and whenever loop.md has been edited since last fire), and to a short reminder on subsequent unchanged fires. The long instructions stay in the cached message-prefix.":"it expands at fire time to the full autonomous-loop instructions on first delivery, and to a short reminder on subsequent fires (the long instructions stay in the cached message-prefix).",v=e?`what's scheduled, the cron expression, the human-readable cadence, that it's running tasks from \`${e.path}\`, that recurring tasks auto-expire after ${Ofe} days, and that the user can cancel sooner with ${vA} (include the job ID).`:`what's scheduled, the cron expression, the human-readable cadence, that recurring tasks auto-expire after ${Ofe} days, and that they can cancel sooner with ${vA} (include the job ID). Mention this is the autonomous default and that the autonomous-loop instructions are baked in.`;return`${u}

## Action

1. Convert \`${t}\` to a 5-field cron expression. Supported suffixes: \`s\` \u2192 ceil to nearest minute, \`m\` (minutes), \`h\` (hours), \`d\` (days). Examples: \`5m\` \u2192 \`*/5 * * * *\`, \`1h\` \u2192 \`0 * * * *\`, \`1d\` \u2192 \`0 0 * * *\`. If the interval doesn't cleanly divide its unit, round to the nearest clean interval and tell the user what you rounded to.
2. Call ${ky} with:
   - \`cron\`: the expression from step 1
   - \`prompt\`: the literal string \`${l}\` \u2014 ${k}
   - \`recurring\`: \`true\`
3. Briefly confirm: ${v}
4. **Then immediately run ${h} now**, following the instructions inlined below. Don't wait for the first cron fire.

${s}

${r}`}

/**
 * What `/loop <args>` sends the model, as in Claude Code:
 * no prompt runs the autonomous default, self-paced when there is no
 * interval either; anything else goes to the model to parse.
 */
export function loopSkillPrompt(args: string, loopFile: LoopFile | null): string {
	const t = args.trim();
	const every = t.match(EVERY_ONLY);
	if (!t || INTERVAL_ONLY.test(t) || every !== null) {
		return noPromptBody(loopFile, !t, every ? normalizeEvery(every) : t || N);
	}
	return explicitPrompt(t);
}
