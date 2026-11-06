/**
 * Claude Code's `/loop` sentinels (2.1.282). A loop
 * with no prompt schedules a sentinel as its prompt; at fire time the
 * sentinel expands to the full instructions on first delivery (and, for a
 * loop.md tasks file, whenever the file changed) and to a short tick
 * reminder after that, so the long text stays in the cached prefix
 * (findings §21). This module decides what goes out and records it; the
 * profile words it (text.ts LoopText).
 *
 * Pure apart from reading loop.md (`<cwd>/.claude/loop.md`, then `~/.claude/loop.md`;
 * the corresponding `.onecode` directories in independent mode).
 */

import { projectConfigDir, userConfigDir } from "../lib/sources.ts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LoopFile, LoopText } from "./text.ts";

export const AUTONOMOUS_LOOP = "<<autonomous-loop>>";
export const AUTONOMOUS_LOOP_DYNAMIC = "<<autonomous-loop-dynamic>>";
export const LOOP_FILE_SENTINEL = "<<loop.md>>";
export const LOOP_FILE_DYNAMIC_SENTINEL = "<<loop.md-dynamic>>";
/** Claude Code's cap on loop.md, in characters (its text says bytes). */
export const LOOP_FILE_CAP = 25000;
/** Marks "the autonomous preamble went out because loop.md was absent". */
const PREAMBLE_MARK = "__autonomous_preamble__";

export type { LoopFile };

/**
 * What one conversation was already sent; compaction resets it (the first
 * fire after it resends everything). `lastLoopFileDelivered` is the delivered
 * loop.md's fingerprint (`loopFileMark`), not its text, so the record stays
 * small on the branch.
 */
export interface LoopDeliveryState {
	autonomousPreambleDelivered: boolean;
	lastLoopFileDelivered: string | null;
}

export function freshDeliveryState(): LoopDeliveryState {
	return { autonomousPreambleDelivered: false, lastLoopFileDelivered: null };
}

/**
 * The `one-code:state` key the record lives under, on the branch of the
 * conversation the fires land in (the main session's, or a subagent's own):
 * it follows `/tree`, survives `/reload` and resume, and a compaction resets
 * it (lib/ledger/state.ts `stateSinceCompaction`).
 */
export const LOOP_DELIVERY_STATE = "loop-delivery";

/**
 * The key a main-session fire's notification details carry its record
 * under. The record is written when that message is delivered (the
 * notifier's `onDelivered`), not when the text is built: the notifier may
 * still hold it, and a `/reload` or `/clear` then drops it unsent.
 */
export const LOOP_DELIVERY_DETAILS_KEY = "loopDelivery";

/** A stored record read back, or a fresh one when it is missing or malformed. */
export function deliveryFromState(value: unknown): LoopDeliveryState {
	const stored = value as Partial<LoopDeliveryState> | undefined;
	if (!stored || typeof stored !== "object") return freshDeliveryState();
	return {
		autonomousPreambleDelivered: stored.autonomousPreambleDelivered === true,
		lastLoopFileDelivered: typeof stored.lastLoopFileDelivered === "string" ? stored.lastLoopFileDelivered : null,
	};
}

/** What a delivered loop.md is remembered by: equal texts, equal marks. */
export function loopFileMark(content: string): string {
	return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export function isAutonomousSentinel(prompt: string): boolean {
	return prompt === AUTONOMOUS_LOOP || prompt === AUTONOMOUS_LOOP_DYNAMIC;
}

export function isLoopFileSentinel(prompt: string): boolean {
	return prompt === LOOP_FILE_SENTINEL || prompt === LOOP_FILE_DYNAMIC_SENTINEL;
}

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
	if (trimmed.length <= LOOP_FILE_CAP) return { path, content: trimmed };
	const lastBreak = trimmed.lastIndexOf("\n", LOOP_FILE_CAP);
	return { path, content: trimmed.slice(0, lastBreak > 0 ? lastBreak : LOOP_FILE_CAP), truncatedAt: LOOP_FILE_CAP };
}

/**
 * The loop-tasks file: the project's `.claude/loop.md` (`.onecode/loop.md` in
 * independent mode, lib/config-mode.ts), else the user config directory's
 * `loop.md` (Claude Code 2.1.296: `~/.claude/loop.md` or `CLAUDE_CONFIG_DIR`).
 */
export function readLoopFile(cwd: string, home = homedir()): LoopFile | null {
	return readLoopFileAt(join(projectConfigDir(cwd), "loop.md")) ?? readLoopFileAt(join(userConfigDir(home), "loop.md"));
}

/**
 * The text a fired prompt delivers, as in Claude Code: a sentinel expands,
 * updating `state`; any other prompt passes through. An autonomous sentinel
 * sends the instructions with its first fire (none yet, and no loop.md
 * delivered), then the tick alone. A loop.md sentinel sends the file's tasks
 * whenever the file is new or changed; with the file gone, the autonomous
 * instructions once, then the tick.
 */
export function resolveLoopFire(state: LoopDeliveryState, prompt: string, cwd: string, text: LoopText, persistent: boolean, home?: string): string {
	const withPreamble = (tick: string) => text.withPreamble({ persistent, tick });
	if (isAutonomousSentinel(prompt)) {
		const tick = text.tick(prompt === AUTONOMOUS_LOOP_DYNAMIC ? "autonomousDynamic" : "autonomous");
		if (state.autonomousPreambleDelivered || state.lastLoopFileDelivered !== null) return tick;
		state.autonomousPreambleDelivered = true;
		return withPreamble(tick);
	}
	if (!isLoopFileSentinel(prompt)) return prompt;
	const dynamic = prompt === LOOP_FILE_DYNAMIC_SENTINEL;
	const loopFile = readLoopFile(cwd, home);
	if (loopFile) {
		const tick = text.tick(dynamic ? "loopFileDynamic" : "loopFile");
		const mark = loopFileMark(loopFile.content);
		if (state.lastLoopFileDelivered === mark) return tick;
		state.lastLoopFileDelivered = mark;
		return text.loopFileTick({ loopFile, tick });
	}
	const tick = text.tick(dynamic ? "loopFileAbsentDynamic" : "autonomous");
	if (state.lastLoopFileDelivered === PREAMBLE_MARK || state.autonomousPreambleDelivered) return tick;
	state.lastLoopFileDelivered = PREAMBLE_MARK;
	state.autonomousPreambleDelivered = true;
	return withPreamble(tick);
}
