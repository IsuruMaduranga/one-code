/**
 * Key decoding for the /plugins panel (pure), named through
 * `lib/key-input.ts` so every terminal encoding of a key decodes alike.
 *
 * Navigation keys are always controls; any other printable input is a `text`
 * intent the state layer routes (search box, Add Marketplace draft, or a
 * single-letter action where the active view has no text field). Unrecognized
 * escape sequences are swallowed so they never leak into a draft.
 */

import { keyId, keyText } from "../../lib/key-input.ts";

export type PanelKey =
	| { kind: "up" | "down" | "pageUp" | "pageDown" | "nextTab" | "prevTab" | "enter" | "back" | "space" | "backspace" | "close" }
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
		case "space":
			return { kind: "space" };
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
