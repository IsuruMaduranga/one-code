/**
 * Raw-byte key decoding for the /plugins panel (pure).
 *
 * Navigation bytes are always controls; any other printable input is a `text`
 * intent the state layer routes (search box, Add Marketplace draft, or a
 * single-letter action where the active view has no text field). Unrecognized
 * escape sequences are swallowed so they never leak into a draft.
 */

export type PanelKey =
	| { kind: "up" | "down" | "pageUp" | "pageDown" | "nextTab" | "prevTab" | "enter" | "back" | "space" | "backspace" | "close" }
	| { kind: "text"; text: string };

export function decodePanelKey(data: string): PanelKey | undefined {
	switch (data) {
		case "\x1b[A":
		case "\x1bOA":
			return { kind: "up" };
		case "\x1b[B":
		case "\x1bOB":
			return { kind: "down" };
		case "\x1b[5~":
			return { kind: "pageUp" };
		case "\x1b[6~":
			return { kind: "pageDown" };
		case "\x1b[C":
		case "\x1bOC":
		case "\t":
			return { kind: "nextTab" };
		case "\x1b[D":
		case "\x1bOD":
		case "\x1b[Z":
			return { kind: "prevTab" };
		case "\r":
		case "\n":
			return { kind: "enter" };
		case "\x1b":
			return { kind: "back" };
		case " ":
			return { kind: "space" };
		case "\x7f":
		case "\b":
			return { kind: "backspace" };
		case "\x03": // ctrl+c
			return { kind: "close" };
		default:
			break;
	}
	if (data.startsWith("\x1b")) return undefined;
	const text = [...data].filter((ch) => ch >= " " && ch !== "\x7f").join("");
	return text ? { kind: "text", text } : undefined;
}
