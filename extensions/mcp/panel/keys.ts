/**
 * Raw-byte key decoding for the /mcp panel (pure).
 *
 * The panel is a two-level menu (server list → server detail with a numbered
 * action list), navigated with the arrows and Enter, Esc to go back/close. A
 * digit selects an action directly in the detail view. No text field, so any
 * other printable input is ignored.
 */

export type McpKey =
	| { kind: "up" | "down" | "enter" | "back" | "close" }
	| { kind: "digit"; value: number };

export function decodeMcpKey(data: string): McpKey | undefined {
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
		case "\x1b":
			return { kind: "back" };
		case "\x03": // ctrl+c
			return { kind: "close" };
		default:
			break;
	}
	if (data.length === 1 && data >= "1" && data <= "9") return { kind: "digit", value: Number(data) };
	return undefined;
}
