/**
 * Claude Code's `/loop` sentinels (2.1.282). A loop
 * with no prompt schedules a sentinel as its prompt; at fire time the
 * sentinel expands to the full instructions on first delivery (and, for a
 * loop.md tasks file, whenever the file changed) and to a short tick
 * reminder after that, so the long text stays in the cached prefix
 * (findings §21). The texts are Claude Code's, verbatim with our tool names;
 * the "tell the user" addenda are dropped (no counterpart tool here).
 *
 * Pure apart from reading loop.md (`<cwd>/.claude/loop.md`, then `~/loop.md`).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const yl = "schedule_wakeup";
const il = "monitor";
const Um = "task_stop";
const jb = "task_output";

export const AUTONOMOUS_LOOP = "<<autonomous-loop>>";
export const AUTONOMOUS_LOOP_DYNAMIC = "<<autonomous-loop-dynamic>>";
export const LOOP_FILE_SENTINEL = "<<loop.md>>";
export const LOOP_FILE_DYNAMIC_SENTINEL = "<<loop.md-dynamic>>";
/** Claude Code's cap on loop.md, in characters (its text says bytes). */
export const LOOP_FILE_CAP = 25000;
/** Marks "the autonomous preamble went out because loop.md was absent". */
const PREAMBLE_MARK = "__autonomous_preamble__";

export interface LoopFile {
	path: string;
	content: string;
}

/** What went out already this session; compaction resets it (the first fire after it resends everything). */
export interface LoopDeliveryState {
	autonomousPreambleDelivered: boolean;
	lastLoopFileDelivered: string | null;
}

export function freshDeliveryState(): LoopDeliveryState {
	return { autonomousPreambleDelivered: false, lastLoopFileDelivered: null };
}

export function isAutonomousSentinel(prompt: string): boolean {
	return prompt === AUTONOMOUS_LOOP || prompt === AUTONOMOUS_LOOP_DYNAMIC;
}

export function isLoopFileSentinel(prompt: string): boolean {
	return prompt === LOOP_FILE_SENTINEL || prompt === LOOP_FILE_DYNAMIC_SENTINEL;
}

function cronTick(): string {return`# Autonomous loop tick

Run the autonomous check using the loop instructions established earlier in this conversation. If you cannot find them, treat this as a no-op tick. The recurring cron will fire the next tick automatically \u2014 do not call ${yl} from this tick.`}
const DYNAMIC_MONITOR_NOTE=`

If a ${il} is armed (check ${jb}), keep \`delaySeconds\` at 1200\u20131800s \u2014 the ${il} is the wake signal and this is only the fallback heartbeat. If you were woken by a \`<task-notification>\`, handle the event before deciding whether to re-arm. To stop the loop, call ${yl} with \`stop: true\` and ${Um} the monitor (use ${jb} to find its task ID if no longer in context).`;
function dynamicTick(): string {return`# Autonomous loop tick (dynamic pacing)

Run the autonomous check using the loop instructions established earlier in this conversation. If you cannot find them, treat this as a no-op tick.

You scheduled this tick via the ${yl} tool (not a recurring cron). To keep the loop alive, call ${yl} again at the end of this turn with \`prompt\` set to the literal sentinel \`${AUTONOMOUS_LOOP_DYNAMIC}\` and \`noop\` set to \`true\` if this tick changed nothing (or \`false\` if it did) \u2014 otherwise the loop ends after this tick.${DYNAMIC_MONITOR_NOTE}`}
function resolveAutonomous(e: LoopDeliveryState, t: string, preamble: string): string | null {if(!isAutonomousSentinel(t))return null;let o=t===AUTONOMOUS_LOOP_DYNAMIC?dynamicTick():cronTick();if(e.autonomousPreambleDelivered||e.lastLoopFileDelivered!==null)return o;return e.autonomousPreambleDelivered=!0,`${preamble}

---

${o}`}
function loopFileCronTick(): string {return`# /loop tick \u2014 loop.md tasks

Work the tasks from the loop.md contents established earlier in this conversation. If you cannot find them, treat this as a no-op tick. The recurring cron will fire the next tick automatically \u2014 do not call ${yl} from this tick.`}
function loopFileDynamicTick(): string {return`# /loop tick \u2014 loop.md tasks (dynamic pacing)

Work the tasks from the loop.md contents established earlier in this conversation. If you cannot find them, treat this as a no-op tick.

You scheduled this tick via the ${yl} tool (not a recurring cron). To keep the loop alive, call ${yl} again at the end of this turn with \`prompt\` set to the literal sentinel \`${LOOP_FILE_DYNAMIC_SENTINEL}\` and \`noop\` set to \`true\` if this tick changed nothing (or \`false\` if it did) \u2014 otherwise the loop ends after this tick.${DYNAMIC_MONITOR_NOTE}`}
function loopFileAbsentDynamicTick(): string {return`# /loop tick \u2014 loop.md absent (dynamic pacing)

loop.md is not currently present. Run the autonomous check using the loop instructions established earlier in this conversation.

You scheduled this tick via the ${yl} tool (not a recurring cron). To keep the loop alive \u2014 and to pick up loop.md if it is recreated \u2014 call ${yl} again at the end of this turn with \`prompt\` set to the literal sentinel \`${LOOP_FILE_DYNAMIC_SENTINEL}\` and \`noop\` set to \`true\` if this tick changed nothing (or \`false\` if it did) \u2014 otherwise the loop ends after this tick.${DYNAMIC_MONITOR_NOTE}`}
function capLoopFile(e: string): string {if(e.length<=LOOP_FILE_CAP)return e;let t=e.lastIndexOf(`
`,LOOP_FILE_CAP);return`${e.slice(0,t>0?t:LOOP_FILE_CAP)}

> WARNING: loop.md was truncated to ${LOOP_FILE_CAP} bytes. Keep the task list concise.`}
/**
 * One loop.md candidate, or null. Every read error counts as absent (Claude
 * Code rethrows all but a missing file or a directory): this runs from the
 * cron timer, where a throw would take the process down.
 */
function readLoopFileAt(path: string): LoopFile | null {
	let text: string;
	try {
		text = readFileSync(path, "utf-8");
	} catch {
		return null;
	}
	const trimmed = text.trim();
	if (trimmed.length === 0) return null;
	return { path, content: capLoopFile(trimmed) };
}

/** The loop-tasks file: the project's `.claude/loop.md`, else `~/loop.md`. */
export function readLoopFile(cwd: string, home = homedir()): LoopFile | null {
	return readLoopFileAt(join(cwd, ".claude", "loop.md")) ?? readLoopFileAt(join(home, "loop.md"));
}

function resolveLoopFile(e: LoopDeliveryState, t: string, o: LoopFile | null, preamble: string): string {let n=t===LOOP_FILE_DYNAMIC_SENTINEL;if(o){let s=n?loopFileDynamicTick():loopFileCronTick();if(e.lastLoopFileDelivered===o.content)return s;return e.lastLoopFileDelivered=o.content,`# /loop tick \u2014 tasks from ${o.path}

The user configured a loop-tasks file. Work through the tasks defined below; these are the instructions for this tick and every subsequent tick (the reminder on later fires refers back to this message).

---

${o.content}

---

${s}`}let r=n?loopFileAbsentDynamicTick():cronTick();if(e.lastLoopFileDelivered===PREAMBLE_MARK||e.autonomousPreambleDelivered)return r;return e.lastLoopFileDelivered=PREAMBLE_MARK,e.autonomousPreambleDelivered=!0,`${preamble}

---

${r}`}
/**
 * The text a fired prompt delivers, as in Claude Code:
 * a sentinel expands, updating `state`; any other prompt passes through.
 */
export function resolveLoopFire(state: LoopDeliveryState, prompt: string, cwd: string, preamble: string, home?: string): string {
	return resolveAutonomous(state, prompt, preamble) ?? (isLoopFileSentinel(prompt) ? resolveLoopFile(state, prompt, readLoopFile(cwd, home), preamble) : prompt);
}
