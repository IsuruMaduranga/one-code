import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { decodePrintableKey, isKeyRelease, isKeyRepeat, keyId, keyText, parseKey } from "../../extensions/lib/key-input.ts";
import { resolvePiTuiEntry } from "../../extensions/subagents/prose.ts";

// pi's own pi-tui (the copy pi loads, nested or hoisted) is the
// authority on key names: pi's components and keybindings use its parser.
interface PiKeys {
	parseKey(data: string): string | undefined;
	isKeyRelease(data: string): boolean;
	isKeyRepeat(data: string): boolean;
	decodeKittyPrintable(data: string): string | undefined;
	setKittyProtocolActive(active: boolean): void;
}
let pi: PiKeys;

beforeAll(async () => {
	pi = (await import(pathToFileURL(resolvePiTuiEntry()).href)) as PiKeys;
	if (typeof pi.parseKey !== "function") throw new Error("pi-tui exports no parseKey");
});
afterEach(() => pi.setKittyProtocolActive(false));

/** Every encoding a terminal can send for the keys the panels use, and many more. */
function corpus(): string[] {
	const out = new Set<string>();
	for (let b = 0; b < 128; b++) {
		out.add(String.fromCharCode(b));
		out.add(`\x1b${String.fromCharCode(b)}`);
		out.add(`\x1bO${String.fromCharCode(b)}`);
		out.add(`\x1b[${String.fromCharCode(b)}`);
	}
	for (const s of ["é", "漢", "hello", "\x1b[200~paste:3u\x1b[201~", "\x1b[[5~", "\x1b[[A", "\x1b[2$", "\x1b[7^"]) out.add(s);
	const codes = [9, 13, 27, 32, 127, 57414, 1089, 57399, 57417, 57426, 60000];
	for (let c = 33; c < 127; c++) codes.push(c);
	const mods = ["", ";1", ";2", ";3", ";5", ";6", ";7", ";9", ";13", ";17", ";65", ";69", ";133", ";255"];
	const events = ["", ":1", ":2", ":3"];
	for (const c of codes) {
		for (const m of mods) {
			for (const e of m ? events : [""]) {
				out.add(`\x1b[${c}${m}${e}u`);
				out.add(`\x1b[${c}:${c - 32}${m}${e}u`);
				out.add(`\x1b[${c}::99${m}${e}u`);
				out.add(`\x1b[${c}:${c + 1}:1089${m}${e}u`);
			}
			if (m) out.add(`\x1b[27${m};${c}~`);
		}
	}
	for (let n = 1; n <= 24; n++) {
		out.add(`\x1b[${n}~`);
		for (const m of mods.slice(1)) for (const e of events) out.add(`\x1b[${n}${m}${e}~`);
	}
	for (const f of "ABCDHF") {
		out.add(`\x1b[${f}`);
		for (const m of mods.slice(1)) for (const e of events) out.add(`\x1b[1${m}${e}${f}`);
	}
	return [...out];
}

describe("key-input matches pi-tui's parser", () => {
	it("names every encoding as pi-tui does, legacy mode", () => {
		const diffs: string[] = [];
		for (const data of corpus()) {
			if (parseKey(data) !== pi.parseKey(data)) diffs.push(`${JSON.stringify(data)}: ${parseKey(data)} vs ${pi.parseKey(data)}`);
		}
		expect(diffs).toEqual([]);
	});
	it("names every encoding as pi-tui does with the kitty protocol active", () => {
		pi.setKittyProtocolActive(true);
		const diffs: string[] = [];
		for (const data of corpus()) {
			const ours = parseKey(data, { kittyActive: true });
			if (ours !== pi.parseKey(data)) diffs.push(`${JSON.stringify(data)}: ${ours} vs ${pi.parseKey(data)}`);
		}
		expect(diffs).toEqual([]);
	});
	it("classifies releases and repeats and decodes printable CSI u as pi-tui does", () => {
		for (const data of corpus()) {
			expect(isKeyRelease(data), JSON.stringify(data)).toBe(pi.isKeyRelease(data));
			expect(isKeyRepeat(data), JSON.stringify(data)).toBe(pi.isKeyRepeat(data));
			if (/^\x1b\[\d/.test(data) && data.endsWith("u")) {
				expect(decodePrintableKey(data), JSON.stringify(data)).toBe(pi.decodeKittyPrintable(data));
			}
		}
	});
});

describe("keyId and keyText", () => {
	it("names Esc, ctrl+c, shift+tab and ctrl+letters in all three encodings", () => {
		for (const [data, id] of [
			["\x1b", "escape"],
			["\x1b[27u", "escape"],
			["\x03", "ctrl+c"],
			["\x1b[99;5u", "ctrl+c"],
			["\x1b[99;69u", "ctrl+c"], // caps lock on
			["\x1b[27;5;99~", "ctrl+c"],
			["\x1b[Z", "shift+tab"],
			["\x1b[9;2u", "shift+tab"],
			["\x18", "ctrl+x"],
			["\x1b[120;5u", "ctrl+x"],
			["\x1b[27;5;120~", "ctrl+x"],
			["\x1b[1~", "home"],
			["\x1b[4~", "end"],
			["\x1b[B", "down"],
			["\x1b[1;1:3B", "down"],
		] as const) {
			expect(keyId(data), JSON.stringify(data)).toBe(id);
		}
	});
	it("flags the kitty release of an arrow", () => {
		expect(isKeyRelease("\x1b[1;1:3B")).toBe(true);
		expect(isKeyRelease("\x1b[B")).toBe(false);
	});
	it("reads typed text from plain input and encoded printable keys only", () => {
		expect(keyText("h")).toBe("h");
		expect(keyText("hello\x07")).toBe("hello");
		expect(keyText("\x1b[104u")).toBe("h");
		expect(keyText("\x1b[103:71;2u")).toBe("G");
		expect(keyText("\x1b[27;2;71~")).toBe("G");
		expect(keyText("\x1b[104;1:3u")).toBeUndefined();
		expect(keyText("\x1b[99;5u")).toBeUndefined();
		expect(keyText("\x1b[A")).toBeUndefined();
		expect(keyText("\x1b")).toBeUndefined();
	});
});
