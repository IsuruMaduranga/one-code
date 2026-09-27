/**
 * Terminal key decoding for One Code's panels, dialogs and input listeners.
 *
 * A key reaches an extension as raw bytes, and one key has several encodings.
 * pi-tui asks the terminal for the kitty keyboard protocol (flags 7:
 * disambiguate, event types, alternate keys), and when the terminal does not
 * answer it turns on xterm's modifyOtherKeys. So Esc is `\x1b` in a legacy
 * terminal and `\x1b[27u` in kitty, Ghostty, WezTerm or VS Code; ctrl+c is
 * `\x03`, `\x1b[99;5u`, or `\x1b[27;5;99~` under tmux with `extended-keys on`;
 * and with event types on, every press is followed by a release such as
 * `\x1b[1;1:3B`. A decoder that compares legacy bytes misses all of those.
 *
 * `parseKey` is pi-tui 0.87.1's own parser (`dist/keys.js`, MIT), ported
 * verbatim so every panel names a key exactly as pi-tui and pi's keybindings
 * do. It stays here because `lib/` modules import nothing from pi, and the
 * bare `@earendil-works/pi-tui` specifier resolves to a different pi-tui in
 * tests than at runtime. `key-input.test.ts` compares this port with the
 * installed pi-tui over every encoding, so a pi bump that changes the parser
 * fails the suite.
 *
 * Decoders switch on `keyId(data)` (pi-tui's key ids: `escape`, `ctrl+c`,
 * `shift+tab`, `up`, `pageDown`, `x`) and read typed text with `keyText`.
 * An input listener, which pi-tui calls before it filters releases, checks
 * `isKeyRelease` first.
 */

const MODIFIERS = { shift: 1, alt: 2, ctrl: 4, super: 8 } as const;
/** Caps lock and num lock, which the kitty protocol reports as modifier bits. */
const LOCK_MASK = 64 + 128;

const CODEPOINTS = { escape: 27, tab: 9, enter: 13, space: 32, backspace: 127, kpEnter: 57414 } as const;
const ARROW_CODEPOINTS = { up: -1, down: -2, right: -3, left: -4 } as const;
const FUNCTIONAL_CODEPOINTS = { delete: -10, insert: -11, pageUp: -12, pageDown: -13, home: -14, end: -15 } as const;

/** Kitty keypad codes and the keys they stand for. */
const KITTY_FUNCTIONAL_KEY_EQUIVALENTS = new Map<number, number>([
	[57399, 48],
	[57400, 49],
	[57401, 50],
	[57402, 51],
	[57403, 52],
	[57404, 53],
	[57405, 54],
	[57406, 55],
	[57407, 56],
	[57408, 57],
	[57409, 46],
	[57410, 47],
	[57411, 42],
	[57412, 45],
	[57413, 43],
	[57415, 61],
	[57416, 44],
	[57417, ARROW_CODEPOINTS.left],
	[57418, ARROW_CODEPOINTS.right],
	[57419, ARROW_CODEPOINTS.up],
	[57420, ARROW_CODEPOINTS.down],
	[57421, FUNCTIONAL_CODEPOINTS.pageUp],
	[57422, FUNCTIONAL_CODEPOINTS.pageDown],
	[57423, FUNCTIONAL_CODEPOINTS.home],
	[57424, FUNCTIONAL_CODEPOINTS.end],
	[57425, FUNCTIONAL_CODEPOINTS.insert],
	[57426, FUNCTIONAL_CODEPOINTS.delete],
]);

const SYMBOL_KEYS = new Set([
	"`", "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/", "!", "@", "#", "$", "%", "^", "&", "*", "(", ")", "_",
	"+", "|", "~", "{", "}", ":", "<", ">", "?",
]);

const LEGACY_SEQUENCE_KEY_IDS: Record<string, string> = {
	"\x1bOA": "up",
	"\x1bOB": "down",
	"\x1bOC": "right",
	"\x1bOD": "left",
	"\x1bOH": "home",
	"\x1bOF": "end",
	"\x1b[E": "clear",
	"\x1bOE": "clear",
	"\x1bOe": "ctrl+clear",
	"\x1b[e": "shift+clear",
	"\x1b[2~": "insert",
	"\x1b[2$": "shift+insert",
	"\x1b[2^": "ctrl+insert",
	"\x1b[3$": "shift+delete",
	"\x1b[3^": "ctrl+delete",
	"\x1b[[5~": "pageUp",
	"\x1b[[6~": "pageDown",
	"\x1b[a": "shift+up",
	"\x1b[b": "shift+down",
	"\x1b[c": "shift+right",
	"\x1b[d": "shift+left",
	"\x1bOa": "ctrl+up",
	"\x1bOb": "ctrl+down",
	"\x1bOc": "ctrl+right",
	"\x1bOd": "ctrl+left",
	"\x1b[5$": "shift+pageUp",
	"\x1b[6$": "shift+pageDown",
	"\x1b[7$": "shift+home",
	"\x1b[8$": "shift+end",
	"\x1b[5^": "ctrl+pageUp",
	"\x1b[6^": "ctrl+pageDown",
	"\x1b[7^": "ctrl+home",
	"\x1b[8^": "ctrl+end",
	"\x1bOP": "f1",
	"\x1bOQ": "f2",
	"\x1bOR": "f3",
	"\x1bOS": "f4",
	"\x1b[11~": "f1",
	"\x1b[12~": "f2",
	"\x1b[13~": "f3",
	"\x1b[14~": "f4",
	"\x1b[[A": "f1",
	"\x1b[[B": "f2",
	"\x1b[[C": "f3",
	"\x1b[[D": "f4",
	"\x1b[[E": "f5",
	"\x1b[15~": "f5",
	"\x1b[17~": "f6",
	"\x1b[18~": "f7",
	"\x1b[19~": "f8",
	"\x1b[20~": "f9",
	"\x1b[21~": "f10",
	"\x1b[23~": "f11",
	"\x1b[24~": "f12",
	"\x1bb": "alt+left",
	"\x1bf": "alt+right",
	"\x1bp": "alt+up",
	"\x1bn": "alt+down",
};

export type KeyEventType = "press" | "repeat" | "release";

interface ParsedSequence {
	codepoint: number;
	shiftedKey?: number;
	baseLayoutKey?: number;
	modifier: number;
	eventType: KeyEventType;
}

function parseEventType(field: string | undefined): KeyEventType {
	if (!field) return "press";
	const eventType = Number.parseInt(field, 10);
	if (eventType === 2) return "repeat";
	if (eventType === 3) return "release";
	return "press";
}

const KITTY_CSI_U = /^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u$/;

function parseKittySequence(data: string): ParsedSequence | undefined {
	const csiU = data.match(KITTY_CSI_U);
	if (csiU) {
		return {
			codepoint: Number.parseInt(csiU[1], 10),
			shiftedKey: csiU[2] && csiU[2].length > 0 ? Number.parseInt(csiU[2], 10) : undefined,
			baseLayoutKey: csiU[3] ? Number.parseInt(csiU[3], 10) : undefined,
			modifier: (csiU[4] ? Number.parseInt(csiU[4], 10) : 1) - 1,
			eventType: parseEventType(csiU[5]),
		};
	}
	const arrow = data.match(/^\x1b\[1;(\d+)(?::(\d+))?([ABCD])$/);
	if (arrow) {
		const codes: Record<string, number> = { A: -1, B: -2, C: -3, D: -4 };
		return { codepoint: codes[arrow[3]], modifier: Number.parseInt(arrow[1], 10) - 1, eventType: parseEventType(arrow[2]) };
	}
	const func = data.match(/^\x1b\[(\d+)(?:;(\d+))?(?::(\d+))?~$/);
	if (func) {
		const funcCodes: Record<number, number> = {
			2: FUNCTIONAL_CODEPOINTS.insert,
			3: FUNCTIONAL_CODEPOINTS.delete,
			5: FUNCTIONAL_CODEPOINTS.pageUp,
			6: FUNCTIONAL_CODEPOINTS.pageDown,
			7: FUNCTIONAL_CODEPOINTS.home,
			8: FUNCTIONAL_CODEPOINTS.end,
		};
		const codepoint = funcCodes[Number.parseInt(func[1], 10)];
		if (codepoint !== undefined) {
			return { codepoint, modifier: (func[2] ? Number.parseInt(func[2], 10) : 1) - 1, eventType: parseEventType(func[3]) };
		}
	}
	const homeEnd = data.match(/^\x1b\[1;(\d+)(?::(\d+))?([HF])$/);
	if (homeEnd) {
		return {
			codepoint: homeEnd[3] === "H" ? FUNCTIONAL_CODEPOINTS.home : FUNCTIONAL_CODEPOINTS.end,
			modifier: Number.parseInt(homeEnd[1], 10) - 1,
			eventType: parseEventType(homeEnd[2]),
		};
	}
	return undefined;
}

function parseModifyOtherKeysSequence(data: string): { codepoint: number; modifier: number } | undefined {
	const match = data.match(/^\x1b\[27;(\d+);(\d+)~$/);
	if (!match) return undefined;
	return { codepoint: Number.parseInt(match[2], 10), modifier: Number.parseInt(match[1], 10) - 1 };
}

function normalizeKittyFunctionalCodepoint(codepoint: number): number {
	return KITTY_FUNCTIONAL_KEY_EQUIVALENTS.get(codepoint) ?? codepoint;
}

function normalizeShiftedLetterIdentityCodepoint(codepoint: number, modifier: number): number {
	const effective = modifier & ~LOCK_MASK;
	if ((effective & MODIFIERS.shift) !== 0 && codepoint >= 65 && codepoint <= 90) return codepoint + 32;
	return codepoint;
}

function formatKeyNameWithModifiers(keyName: string, modifier: number): string | undefined {
	const effective = modifier & ~LOCK_MASK;
	const supported = MODIFIERS.shift | MODIFIERS.ctrl | MODIFIERS.alt | MODIFIERS.super;
	if ((effective & ~supported) !== 0) return undefined;
	const mods: string[] = [];
	if (effective & MODIFIERS.shift) mods.push("shift");
	if (effective & MODIFIERS.ctrl) mods.push("ctrl");
	if (effective & MODIFIERS.alt) mods.push("alt");
	if (effective & MODIFIERS.super) mods.push("super");
	return mods.length > 0 ? `${mods.join("+")}+${keyName}` : keyName;
}

const NAMED_CODEPOINTS = new Map<number, string>([
	[CODEPOINTS.escape, "escape"],
	[CODEPOINTS.tab, "tab"],
	[CODEPOINTS.enter, "enter"],
	[CODEPOINTS.kpEnter, "enter"],
	[CODEPOINTS.space, "space"],
	[CODEPOINTS.backspace, "backspace"],
	[FUNCTIONAL_CODEPOINTS.delete, "delete"],
	[FUNCTIONAL_CODEPOINTS.insert, "insert"],
	[FUNCTIONAL_CODEPOINTS.home, "home"],
	[FUNCTIONAL_CODEPOINTS.end, "end"],
	[FUNCTIONAL_CODEPOINTS.pageUp, "pageUp"],
	[FUNCTIONAL_CODEPOINTS.pageDown, "pageDown"],
	[ARROW_CODEPOINTS.up, "up"],
	[ARROW_CODEPOINTS.down, "down"],
	[ARROW_CODEPOINTS.left, "left"],
	[ARROW_CODEPOINTS.right, "right"],
]);

function formatParsedKey(codepoint: number, modifier: number, baseLayoutKey?: number): string | undefined {
	const identity = normalizeShiftedLetterIdentityCodepoint(normalizeKittyFunctionalCodepoint(codepoint), modifier);
	// The codepoint is authoritative for a Latin letter, digit or known symbol
	// (remapped layouts); otherwise the base-layout key names it.
	const isLatinLetter = identity >= 97 && identity <= 122;
	const isDigit = identity >= 48 && identity <= 57;
	const isKnownSymbol = SYMBOL_KEYS.has(String.fromCharCode(identity));
	const effective = isLatinLetter || isDigit || isKnownSymbol ? identity : (baseLayoutKey ?? identity);
	let keyName = NAMED_CODEPOINTS.get(effective);
	if (!keyName) {
		if ((effective >= 48 && effective <= 57) || (effective >= 97 && effective <= 122)) keyName = String.fromCharCode(effective);
		else if (SYMBOL_KEYS.has(String.fromCharCode(effective))) keyName = String.fromCharCode(effective);
	}
	if (!keyName) return undefined;
	return formatKeyNameWithModifiers(keyName, modifier);
}

export interface ParseKeyOptions {
	/** pi-tui's kitty-protocol state: `\n` and `\x1b\r` then mean shift+enter. Default false. */
	kittyActive?: boolean;
	/** Windows Terminal outside SSH, where a raw `\x08` is ctrl+backspace. Default read from the environment. */
	windowsTerminal?: boolean;
}

function isWindowsTerminalSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.WT_SESSION) && !env.SSH_CONNECTION && !env.SSH_CLIENT && !env.SSH_TTY;
}

/** pi-tui 0.87.1's `parseKey`: the key id of one input chunk, or undefined. Releases parse like presses. */
export function parseKey(data: string, options: ParseKeyOptions = {}): string | undefined {
	const kitty = options.kittyActive ?? false;
	const kittySeq = parseKittySequence(data);
	if (kittySeq) return formatParsedKey(kittySeq.codepoint, kittySeq.modifier, kittySeq.baseLayoutKey);
	const mok = parseModifyOtherKeysSequence(data);
	if (mok) return formatParsedKey(mok.codepoint, mok.modifier);
	if (kitty && (data === "\x1b\r" || data === "\n")) return "shift+enter";
	const legacy = LEGACY_SEQUENCE_KEY_IDS[data];
	if (legacy) return legacy;
	switch (data) {
		case "\x1b":
			return "escape";
		case "\x1c":
			return "ctrl+\\";
		case "\x1d":
			return "ctrl+]";
		case "\x1f":
			return "ctrl+-";
		case "\x1b\x1b":
			return "ctrl+alt+[";
		case "\x1b\x1c":
			return "ctrl+alt+\\";
		case "\x1b\x1d":
			return "ctrl+alt+]";
		case "\x1b\x1f":
			return "ctrl+alt+-";
		case "\t":
			return "tab";
		case "\r":
		case "\x1bOM":
			return "enter";
		case "\x00":
			return "ctrl+space";
		case " ":
			return "space";
		case "\x7f":
			return "backspace";
		case "\x08":
			return (options.windowsTerminal ?? isWindowsTerminalSession()) ? "ctrl+backspace" : "backspace";
		case "\x1b[Z":
			return "shift+tab";
		case "\x1b\x7f":
		case "\x1b\b":
			return "alt+backspace";
	}
	if (!kitty) {
		if (data === "\n") return "enter";
		if (data === "\x1b\r") return "alt+enter";
		if (data === "\x1b ") return "alt+space";
		if (data === "\x1bB") return "alt+left";
		if (data === "\x1bF") return "alt+right";
		if (data.length === 2 && data[0] === "\x1b") {
			const code = data.charCodeAt(1);
			if (code >= 1 && code <= 26) return `ctrl+alt+${String.fromCharCode(code + 96)}`;
			const key = String.fromCharCode(code);
			if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57) || SYMBOL_KEYS.has(key)) return `alt+${key}`;
		}
	}
	switch (data) {
		case "\x1b[A":
			return "up";
		case "\x1b[B":
			return "down";
		case "\x1b[C":
			return "right";
		case "\x1b[D":
			return "left";
		case "\x1b[H":
		case "\x1bOH":
			return "home";
		case "\x1b[F":
		case "\x1bOF":
			return "end";
		case "\x1b[3~":
			return "delete";
		case "\x1b[5~":
			return "pageUp";
		case "\x1b[6~":
			return "pageDown";
	}
	if (data.length === 1) {
		const code = data.charCodeAt(0);
		if (code >= 1 && code <= 26) return `ctrl+${String.fromCharCode(code + 96)}`;
		if (code >= 32 && code <= 126) return data;
	}
	return undefined;
}

/**
 * Legacy Home and End forms that pi-tui's `matchesKey` accepts but its
 * `parseKey` does not name (rxvt and the Linux console send them).
 */
const EXTRA_KEY_IDS: Record<string, string> = { "\x1b[1~": "home", "\x1b[4~": "end" };

/**
 * The key id for a panel decoder: pi-tui's `parseKey`, plus the legacy Home
 * and End forms. A release or repeat names the same key as its press; pi-tui
 * drops releases before a focused component sees them.
 */
export function keyId(data: string, options?: ParseKeyOptions): string | undefined {
	return parseKey(data, options) ?? EXTRA_KEY_IDS[data];
}

/** pi-tui's `isKeyRelease`: the kitty protocol's release event (flag 2). Pasted text never counts. */
export function isKeyRelease(data: string): boolean {
	if (data.includes("\x1b[200~")) return false;
	return /:3[u~ABCDHF]/.test(data);
}

/** pi-tui's `isKeyRepeat`: the kitty protocol's auto-repeat event (flag 2). */
export function isKeyRepeat(data: string): boolean {
	if (data.includes("\x1b[200~")) return false;
	return /:2[u~ABCDHF]/.test(data);
}

const KITTY_PRINTABLE_ALLOWED_MODIFIERS = MODIFIERS.shift | LOCK_MASK;

/** pi-tui's `decodePrintableKey`: the character a kitty CSI u or modifyOtherKeys sequence types, if any. */
export function decodePrintableKey(data: string): string | undefined {
	const csiU = data.match(KITTY_CSI_U);
	if (csiU) {
		const codepoint = Number.parseInt(csiU[1] ?? "", 10);
		if (!Number.isFinite(codepoint)) return undefined;
		const shiftedKey = csiU[2] && csiU[2].length > 0 ? Number.parseInt(csiU[2], 10) : undefined;
		const modValue = csiU[4] ? Number.parseInt(csiU[4], 10) : 1;
		const modifier = Number.isFinite(modValue) ? modValue - 1 : 0;
		if ((modifier & ~KITTY_PRINTABLE_ALLOWED_MODIFIERS) !== 0) return undefined;
		if (modifier & (MODIFIERS.alt | MODIFIERS.ctrl)) return undefined;
		let effective = codepoint;
		if (modifier & MODIFIERS.shift && typeof shiftedKey === "number") effective = shiftedKey;
		effective = normalizeKittyFunctionalCodepoint(effective);
		if (!Number.isFinite(effective) || effective < 32) return undefined;
		try {
			return String.fromCodePoint(effective);
		} catch {
			return undefined;
		}
	}
	const mok = parseModifyOtherKeysSequence(data);
	if (!mok) return undefined;
	if (((mok.modifier & ~LOCK_MASK) & ~MODIFIERS.shift) !== 0) return undefined;
	if (!Number.isFinite(mok.codepoint) || mok.codepoint < 32) return undefined;
	try {
		return String.fromCodePoint(mok.codepoint);
	} catch {
		return undefined;
	}
}

/**
 * The text a chunk types, for a search box, a draft or a letter shortcut:
 * plain input (a key or a paste) with control characters removed, or the
 * character an encoded printable key stands for. A control sequence types
 * nothing, so its tail never leaks into a draft.
 */
export function keyText(data: string): string | undefined {
	if (data.startsWith("\x1b")) {
		if (isKeyRelease(data)) return undefined;
		return decodePrintableKey(data);
	}
	const text = [...data].filter((ch) => ch >= " " && ch !== "\x7f").join("");
	return text.length > 0 ? text : undefined;
}
