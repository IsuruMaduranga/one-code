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
	/**
	 * For a test: hears of every passage a text is checked for, and whether
	 * the text has it. A reworded sentence leaves its passage a silent no-op,
	 * which only shows as a passage no rendering ever has.
	 */
	watch?(passage: string, found: boolean): void;
}

/** Per tool, the exact passages that name it: cut, or replaced (`[from, to]`) where the rest of the sentence still holds. */
export type ToolPassages = Readonly<Record<string, readonly (string | readonly [string, string])[]>>;

/** `text` without the passages of every tool that is off. */
export function withoutOff(text: string, live: LiveTools, passages: ToolPassages): string {
	let out = text;
	for (const [tool, parts] of Object.entries(passages)) {
		// Before cutting: a passage may be what an earlier tool's replacement left.
		if (live.watch) for (const part of parts) live.watch(typeof part === "string" ? part : part[0], out.includes(typeof part === "string" ? part : part[0]));
		if (live.has(tool)) continue;
		for (const part of parts) out = typeof part === "string" ? out.replaceAll(part, "") : out.replaceAll(part[0], part[1]);
	}
	return out;
}
