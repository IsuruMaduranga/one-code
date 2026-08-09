/**
 * Hook observability, mirroring auto-mode's: CC_HOOKS_DEBUG=1 for live
 * per-invocation lines, and an opt-in JSONL (`hooks-decisions.jsonl` next to
 * the approval store) for after-the-fact "what fired and what did it decide".
 * Logging must never break a hook's fail-open guarantee, so append failures
 * are swallowed (same stance as auto-mode/decision-log.ts).
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { oneCodeStateDir } from "../lib/paths.ts";

export interface HookLogEntry {
	ts: string;
	sessionId?: string;
	event: string;
	scope: string;
	command: string;
	decision: "allow" | "block" | "context" | "error";
	reason?: string;
	exitCode: number | null;
	durationMs: number;
}

export function hooksDebugEnabled(): boolean {
	const value = process.env.CC_HOOKS_DEBUG;
	return value === "1" || value === "2";
}

const COMMAND_LIMIT = 120;

export function clipCommand(command: string): string {
	const flat = command.replace(/\s+/g, " ").trim();
	return flat.length > COMMAND_LIMIT ? `${flat.slice(0, COMMAND_LIMIT)}…` : flat;
}

export function formatDebugLine(entry: Omit<HookLogEntry, "ts" | "sessionId">): string {
	const reason = entry.reason ? ` — ${entry.reason}` : "";
	return `[hooks] ${entry.event} (${entry.scope}) ${clipCommand(entry.command)} → ${entry.decision}${reason} (${entry.durationMs}ms)`;
}

export function hooksLogPath(): string {
	return join(oneCodeStateDir(), "hooks", "hooks-decisions.jsonl");
}

export function appendHookLog(entry: HookLogEntry, file = hooksLogPath()): void {
	try {
		mkdirSync(dirname(file), { recursive: true });
		appendFileSync(file, `${JSON.stringify(entry)}\n`);
	} catch {
		// Never break a hook over its diary.
	}
}
