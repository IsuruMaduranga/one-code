/**
 * Key decoding for the /mcp panel (pure), named through `lib/key-input.ts`
 * so every terminal encoding of a key decodes alike.
 *
 * The panel is a two-level menu (server list → server detail with a numbered
 * action list), navigated with the arrows and Enter, Esc to go back/close. A
 * digit selects an action directly in the detail view. No text field, so any
 * other printable input is ignored.
 */

import { keyId } from "../../lib/key-input.ts";

export type McpKey =
	| { kind: "up" | "down" | "enter" | "back" | "close" }
	| { kind: "digit"; value: number };

export function decodeMcpKey(data: string): McpKey | undefined {
	const id = keyId(data);
	switch (id) {
		case "up":
			return { kind: "up" };
		case "down":
			return { kind: "down" };
		case "enter":
			return { kind: "enter" };
		case "escape":
			return { kind: "back" };
		case "ctrl+c":
			return { kind: "close" };
		default:
			break;
	}
	if (id && id.length === 1 && id >= "1" && id <= "9") return { kind: "digit", value: Number(id) };
	return undefined;
}
