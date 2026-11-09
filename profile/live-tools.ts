/**
 * Leaving tools that are off out of One Code's text
 * (extensions/lib/profile/live-tools.ts): each text lists, per tool, the sentences or
 * lines that name it, and they are cut when the tool is off.
 * test/unit/profile-live-tools.test.ts renders every such text with each
 * optional tool off and fails on any mention left.
 */

import type { LiveTools } from "../extensions/sdk/profile.ts";

/** Per tool, the exact passages that name it: cut, or replaced (`[from, to]`) where the rest of the sentence still holds. */
export type ToolPassages = Readonly<Record<string, readonly (string | readonly [string, string])[]>>;

/** `text` without the passages of every tool that is off. */
export function withoutOff(text: string, live: LiveTools, passages: ToolPassages): string {
	let out = text;
	for (const [tool, parts] of Object.entries(passages)) {
		if (live.has(tool)) continue;
		for (const part of parts) out = typeof part === "string" ? out.replaceAll(part, "") : out.replaceAll(part[0], part[1]);
	}
	return out;
}
