/**
 * Key decoding for the /permissions panel (pure).
 *
 * Keys are named through `lib/key-input.ts`, so the legacy, kitty and
 * modifyOtherKeys encodings of a key decode alike. Navigation keys are always
 * controls; any other printable input is a `text` intent the state layer
 * routes (a search box, a draft, or a single-letter action such as `r`
 * retry). Unrecognized escape sequences are swallowed so they never leak into
 * a draft.
 */

import { keyId, keyText } from "../../lib/key-input.ts";

export type PanelKey =
	| { kind: "up" | "down" | "pageUp" | "pageDown" | "nextTab" | "prevTab" | "enter" | "back" | "backspace" | "close" }
	| { kind: "text"; text: string };

export function decodePanelKey(data: string): PanelKey | undefined {
	switch (keyId(data)) {
		case "up":
			return { kind: "up" };
		case "down":
			return { kind: "down" };
		case "pageUp":
			return { kind: "pageUp" };
		case "pageDown":
			return { kind: "pageDown" };
		case "right":
		case "tab":
			return { kind: "nextTab" };
		case "left":
		case "shift+tab":
			return { kind: "prevTab" };
		case "enter":
			return { kind: "enter" };
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
