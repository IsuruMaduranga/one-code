/**
 * Claude Code's `/loop` bundled skill (2.1.288), the base's half: which form
 * `/loop <args>` takes. No prompt runs the autonomous default, self-paced
 * when there is no interval either; anything else goes to the model to
 * parse. The profile words each form (text.ts LoopText.skillBody); the model
 * then schedules the loop itself (cron_create, or schedule_wakeup for
 * self-pacing) and runs the first iteration, as in Claude Code (findings §21).
 *
 * Pure: no pi imports.
 */

import { knobValue } from "../lib/profile/knobs.ts";
import type { LoopSkillForm } from "./text.ts";
import { envFlag } from "./wakeup.ts";

/** The interval a bare `/loop` uses. */
const DEFAULT_INTERVAL = "10m";

/** Whether the autonomous-loop instructions take their persistent variant (the `LOOP_PERSISTENT` knob, lib/profile/knobs.ts). */
export function loopPersistent(env: NodeJS.ProcessEnv = process.env): boolean {
	return envFlag(knobValue("LOOP_PERSISTENT", env), false);
}

const INTERVAL_ONLY=/^\d+[smhd]$/;
const EVERY_ONLY=/^every\s+(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\s*$/i;
function normalizeEvery(e: RegExpMatchArray): string {let o=e[1],t=e[2].toLowerCase();if(t.startsWith("s"))return`${o}s`;if(t.startsWith("h"))return`${o}h`;if(t.startsWith("d"))return`${o}d`;return`${o}m`}

export function loopSkillForm(args: string): LoopSkillForm {
	const t = args.trim();
	const every = t.match(EVERY_ONLY);
	if (!t || INTERVAL_ONLY.test(t) || every !== null) {
		return { kind: "noPrompt", selfPaced: !t, interval: every ? normalizeEvery(every) : t || DEFAULT_INTERVAL };
	}
	return { kind: "prompt", input: t };
}
