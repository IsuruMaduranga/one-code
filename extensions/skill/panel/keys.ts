/**
 * Raw-byte key decoding for the /skills panel (pure).
 *
 * Same control-byte map as the /plugins panel; kept local so the skill
 * extension carries no dependency on another extension's internals. Printable
 * input is a `text` intent the state layer routes (into the search box, or as a
 * single-letter action when search is inactive). Skill names never contain
 * spaces, so Space is always the cycle action, never typed.
 */

export type SkillsKey =
	| { kind: "up" | "down" | "enter" | "space" | "back" | "backspace" | "close" }
	| { kind: "text"; text: string };

export function decodeSkillsKey(data: string): SkillsKey | undefined {
	switch (data) {
		case "\x1b[A":
		case "\x1bOA":
			return { kind: "up" };
		case "\x1b[B":
		case "\x1bOB":
			return { kind: "down" };
		case "\r":
		case "\n":
			return { kind: "enter" };
		case " ":
			return { kind: "space" };
		case "\x1b":
			return { kind: "back" };
		case "\x7f":
		case "\b":
			return { kind: "backspace" };
		case "\x03":
			return { kind: "close" };
		default:
			break;
	}
	if (data.startsWith("\x1b")) return undefined;
	const text = [...data].filter((ch) => ch >= " " && ch !== "\x7f").join("");
	return text ? { kind: "text", text } : undefined;
}
