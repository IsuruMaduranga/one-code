/**
 * Which tools this session can have, for text that names another tool. The
 * base answers from the feature registry and the tool switches when the
 * profile resolves (lib/profile/profile.ts), and builds the profile's text
 * for that answer (`Profile.text`); the text leaves out what is off, so a
 * request never names a tool it does not carry. The golden sweep fails when
 * one does (test/e2e/golden-requests.mjs --sweep).
 *
 * A text lists, per tool, the sentences or lines that name it (`ToolPassages`),
 * and `withoutOff` cuts them when the tool is off. A leaf module: the
 * profile's text imports it through extensions/sdk/profile.ts.
 */

export interface LiveTools {
	has(tool: string): boolean;
}

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
