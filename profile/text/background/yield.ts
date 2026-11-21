/**
 * One Code's yield words (the profile's `text.background.yield`): Claude Code
 * 2.1.327's `Yield` description (findings §94), with one clause changed:
 * Claude Code resumes shortly before the prompt cache would expire, One Code
 * after an hour (pi's warmer keeps the cache warm during a run, so the base
 * needs no resume for it; extensions/tools/background/yield-wait.ts). Claude
 * Code ships it behind a server flag; One Code offers it on every model, so a
 * model that wants to wait for an agent has one blocking call instead of a poll.
 */

import type { YieldText } from "../../../extensions/sdk/profile.ts";

export const yieldTool: YieldText = {
	description:
		"Pause until one of your asynchronous tools reports something. Call it only when you have no other work. You resume as soon as a report or a message arrives (shown after the line that follows this call's result, before your next reply, unless that line says it waits for the end of your turn), at once if none of your asynchronous tools has anything under way that could produce a report, or when a tool you are waiting on reaches its own time limit. Also resumes after an hour with no report, with a line saying how many tasks are still running; call it again to keep waiting.",
};
