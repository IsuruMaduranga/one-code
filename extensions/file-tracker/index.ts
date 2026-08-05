/**
 * file-tracker extension — Claude Code's read-before-write discipline.
 *
 * - `edit`/`write`/`notebook_edit` on a file that exists but was never read is
 *   blocked with an instruction to read it first.
 * - An edit to a file that changed since we last saw it is blocked, so the model
 *   cannot overwrite someone else's change.
 * - Files that change out of band are reported in a `<system-reminder>` with the
 *   new content around the change, line-numbered.
 *
 * Tracking is by content, not by tool call, which is what makes it catch writes
 * that went through bash and never touched an intercepted tool.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { REMINDER_CHANNEL } from "../lib/reminders.ts";
import { describeChanges, EXTERNAL_CHANGE_REMINDER, FileTracker, STALE_REASON, UNREAD_REASON } from "./tracker.ts";

const GUARDED_TOOLS = new Set(["edit", "write", "notebook_edit"]);
const READ_TOOLS = new Set(["read", "notebook_edit"]);

function readIfPresent(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return readFileSync(path, "utf-8");
	} catch {
		// Binary or unreadable: not something we can reason about, so don't guard it.
		return undefined;
	}
}

function pathOf(input: unknown, cwd: string): string | undefined {
	const raw = (input as { path?: unknown })?.path;
	if (typeof raw !== "string" || !raw.trim()) return undefined;
	return isAbsolute(raw) ? raw : resolve(cwd, raw);
}

export default function fileTrackerExtension(pi: ExtensionAPI) {
	const tracker = new FileTracker();

	pi.on("tool_call", (event, ctx) => {
		if (!GUARDED_TOOLS.has(event.toolName)) return undefined;
		const path = pathOf(event.input, ctx.cwd);
		if (!path) return undefined;

		const current = readIfPresent(path);
		const status = tracker.status(path, current);

		// Creating a new file needs no prior read.
		if (status === "absent" || status === "fresh") return undefined;
		if (status === "unread") return { block: true, reason: UNREAD_REASON(path, event.toolName) };
		return { block: true, reason: STALE_REASON(path) };
	});

	pi.on("tool_result", (event, ctx) => {
		if (event.isError) return undefined;
		if (!READ_TOOLS.has(event.toolName) && !GUARDED_TOOLS.has(event.toolName)) return undefined;

		const path = pathOf(event.input, ctx.cwd);
		if (!path) return undefined;

		// After a read we know the file; after our own write we know it again, so a
		// successful edit does not make the file look stale to the next edit.
		const current = readIfPresent(path);
		if (current === undefined) tracker.forget(path);
		else tracker.observe(path, current, Date.now());
		return undefined;
	});

	/**
	 * Before each turn, report anything that changed under us. Doing it here rather
	 * than on a watcher keeps it deterministic and costs one stat+read per tracked
	 * file, only for files the model actually touched.
	 */
	pi.on("before_agent_start", () => {
		for (const path of tracker.tracked) {
			const previous = tracker.lastSeen(path);
			if (previous === undefined || previous === "") continue;
			const current = readIfPresent(path);
			if (current === undefined) {
				tracker.forget(path);
				pi.events.emit(REMINDER_CHANNEL, {
					text: `${path} no longer exists; it was deleted or moved after you read it.`,
				});
				continue;
			}
			if (current === previous) continue;
			// Don't repeat the same warning every turn…
			if (tracker.alreadyNotified(path, current)) continue;

			const excerpt = describeChanges(previous, current);
			if (excerpt) {
				pi.events.emit(REMINDER_CHANNEL, { text: EXTERNAL_CHANGE_REMINDER(path, excerpt) });
			}
			// …but deliberately do NOT record the new content as seen: the file must
			// stay stale so the edit guard still forces a re-read. Marking it read
			// here would announce the change and then permit the clobbering edit.
			tracker.markNotified(path, current);
		}
	});
}
