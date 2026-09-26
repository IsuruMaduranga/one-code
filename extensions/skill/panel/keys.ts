/**
 * Key decoding for the /skills panel (pure), named through
 * `lib/key-input.ts` so every terminal encoding of a key decodes alike.
 *
 * Same key map as the /plugins panel; kept local so the skill
 * extension carries no dependency on another extension's internals. Printable
 * input is a `text` intent the state layer routes (into the search box, or as a
 * single-letter action when search is inactive). Skill names never contain
 * spaces, so Space is always the cycle action, never typed.
 */

import { keyId, keyText } from "../../lib/key-input.ts";

export type SkillsKey =
	| { kind: "up" | "down" | "enter" | "space" | "back" | "backspace" | "close" }
	| { kind: "text"; text: string };

export function decodeSkillsKey(data: string): SkillsKey | undefined {
	switch (keyId(data)) {
		case "up":
			return { kind: "up" };
		case "down":
			return { kind: "down" };
		case "enter":
			return { kind: "enter" };
		case "space":
			return { kind: "space" };
		case "escape":
			return { kind: "back" };
		case "backspace":
		case "ctrl+backspace":
			return { kind: "backspace" };
		case "ctrl+c":
			return { kind: "close" };
		default:
			break;
	}
	const text = keyText(data);
	return text ? { kind: "text", text } : undefined;
}
