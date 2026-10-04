import { describe, expect, it } from "vitest";
import { decodeWidgetKey } from "../../extensions/ask-user/widget.ts";
import { decodePickerKey } from "../../extensions/lib/model-picker.ts";
import { decodeBtwKey } from "../../extensions/btw/panel.ts";
import { decodeDoctorKey } from "../../extensions/doctor/viewer.ts";
import { decodeKey as decodeSliderKey } from "../../extensions/effort/slider.ts";
import { decodeMcpKey } from "../../extensions/mcp/panel/keys.ts";
import { decodeMemoryKey } from "../../extensions/memory/panel.ts";
import { decodePanelKey as decodePermissionsKey } from "../../extensions/permissions/panel/keys.ts";
import { decodeViewerKey as decodePlanKey } from "../../extensions/plan-mode/viewer.ts";
import { decodePanelKey as decodePluginsKey } from "../../extensions/plugins/panel/keys.ts";
import { classifyKey, SendNowChord } from "../../extensions/send-now/chord.ts";
import { decodeSkillsKey } from "../../extensions/skill/panel/keys.ts";
import { decodeStripKey, editorYieldsDown, isStripEntryKey } from "../../extensions/subagents/panel-keys.ts";
import { decodeViewerKey as decodeWorkflowKey } from "../../extensions/workflow/viewer.ts";

// pi-tui turns on the kitty keyboard protocol (flags 7) where the terminal
// supports it (kitty, Ghostty, WezTerm, VS Code 1.109.5+) and xterm's
// modifyOtherKeys elsewhere (tmux with `extended-keys on`, xterm). Every
// decoder must read each encoding of a key the same way.
const ESC = ["\x1b", "\x1b[27u", "\x1b[27;1:1u", "\x1b[27;65u"];
const CTRL_C = ["\x03", "\x1b[99;5u", "\x1b[99;69u", "\x1b[27;5;99~"];
const SHIFT_TAB = ["\x1b[Z", "\x1b[9;2u"];
const ENTER = ["\r", "\x1b[13u"];
const DOWN = ["\x1b[B", "\x1bOB", "\x1b[1;1B"];

function each(forms: string[], check: (data: string) => void): void {
	for (const data of forms) check(data);
}

describe("every dialog closes on Esc and ctrl+c in every encoding", () => {
	it("the /permissions, /plugins, /skills and /mcp panels", () => {
		each(ESC, (d) => {
			expect(decodePermissionsKey(d), JSON.stringify(d)).toEqual({ kind: "back" });
			expect(decodePluginsKey(d)).toEqual({ kind: "back" });
			expect(decodeSkillsKey(d)).toEqual({ kind: "back" });
			expect(decodeMcpKey(d)).toEqual({ kind: "back" });
		});
		each(CTRL_C, (d) => {
			expect(decodePermissionsKey(d), JSON.stringify(d)).toEqual({ kind: "close" });
			expect(decodePluginsKey(d)).toEqual({ kind: "close" });
			expect(decodeSkillsKey(d)).toEqual({ kind: "close" });
			expect(decodeMcpKey(d)).toEqual({ kind: "close" });
		});
		each(SHIFT_TAB, (d) => {
			expect(decodePermissionsKey(d)).toEqual({ kind: "prevTab" });
			expect(decodePluginsKey(d)).toEqual({ kind: "prevTab" });
		});
	});
	it("/effort, /memory, /doctor, the model picker, ask_user_question and plan approval", () => {
		for (const d of [...ESC, ...CTRL_C]) {
			expect(decodeSliderKey(d), JSON.stringify(d)).toBe("cancel");
			expect(decodeMemoryKey(d)).toEqual({ kind: "close" });
			expect(decodeDoctorKey(d)).toEqual({ kind: "close" });
			expect(decodePickerKey(d)).toEqual({ kind: "cancel" });
			expect(decodeWidgetKey(d)).toEqual({ kind: "esc" });
			expect(decodePlanKey(d, 10)).toEqual({ kind: "cancel" });
		}
		each(SHIFT_TAB, (d) => expect(decodeWidgetKey(d)).toEqual({ kind: "prevTab" }));
		each(ENTER, (d) => {
			expect(decodeSliderKey(d)).toBe("confirm");
			expect(decodePlanKey(d, 10)).toEqual({ kind: "confirm" });
		});
	});
	it("the workflow viewer and /btw", () => {
		each(ESC, (d) => expect(decodeWorkflowKey(d)).toEqual({ kind: "back" }));
		each(CTRL_C, (d) => expect(decodeWorkflowKey(d)).toEqual({ kind: "close" }));
		for (const d of [...ESC, ...CTRL_C, "\x04", "\x1b[100;5u"]) expect(decodeBtwKey(d), JSON.stringify(d)).toEqual({ kind: "close" });
		each(SHIFT_TAB, (d) => expect(decodeBtwKey(d)).toEqual({ kind: "browse", direction: "newer", wrap: true }));
		for (const d of ["\x10", "\x1b[112;5u", "\x1b[27;5;112~"]) expect(decodeBtwKey(d)).toEqual({ kind: "up" });
		for (const d of ["\x0e", "\x1b[110;5u"]) expect(decodeBtwKey(d)).toEqual({ kind: "down" });
	});
});

describe("letter shortcuts in every encoding", () => {
	it("reads plain and CSI u letters alike, and ignores ctrl+letter", () => {
		expect(decodeSliderKey("\x1b[104u")).toBe("left");
		expect(decodeSliderKey("l")).toBe("right");
		expect(decodeDoctorKey("\x1b[103:71;2u")).toEqual({ kind: "end" });
		expect(decodeDoctorKey("G")).toEqual({ kind: "end" });
		expect(decodeWorkflowKey("\x1b[120u")).toEqual({ kind: "stop" });
		expect(decodeBtwKey("\x1b[99u")).toEqual({ kind: "copy" });
		expect(decodePermissionsKey("\x1b[114u")).toEqual({ kind: "text", text: "r" });
		expect(decodePermissionsKey("\x1b[99;5u")).not.toEqual({ kind: "text", text: "c" });
		expect(decodePlanKey("\x1b[50u", 10)).toEqual({ kind: "pick", index: 1 });
		expect(decodeMcpKey("\x1b[51u")).toEqual({ kind: "digit", value: 3 });
	});
	it("never leaks an unknown escape sequence into a draft", () => {
		for (const d of ["\x1b[15~", "\x1b[1;5P", "\x1b[200;5u"]) {
			expect(decodePermissionsKey(d), JSON.stringify(d)).toBeUndefined();
			expect(decodeWidgetKey(d)).toBeUndefined();
			expect(decodePickerKey(d)).toBeUndefined();
		}
	});
});

describe("the subagent strip under the kitty protocol", () => {
	it("ignores key releases instead of reading them as typing", () => {
		for (const d of ["\x1b[1;1:3B", "\x1b[1;1:3A", "\x1b[120;5:3u", "\x1b[13;1:3u"]) {
			expect(decodeStripKey(d, false), JSON.stringify(d)).toEqual({ chordArmed: false, release: true });
			expect(decodeStripKey(d, true)).toEqual({ chordArmed: true, release: true });
		}
		expect(isStripEntryKey("\x1b[1;1:3B")).toBe(false);
		each(DOWN, (d) => expect(isStripEntryKey(d)).toBe(true));
	});
	it("arms and completes ctrl+x ctrl+k in every encoding", () => {
		for (const x of ["\x18", "\x1b[120;5u", "\x1b[27;5;120~"]) {
			for (const k of ["\x0b", "\x1b[107;5u", "\x1b[27;5;107~"]) {
				expect(decodeStripKey(x, false)).toEqual({ chordArmed: true });
				expect(decodeStripKey(k, true), `${JSON.stringify(x)} ${JSON.stringify(k)}`).toEqual({ key: "stopAll", chordArmed: false });
			}
		}
	});
	it("leaves on Esc and repeats keys the terminal auto-repeats", () => {
		each(ESC, (d) => expect(decodeStripKey(d, false).key).toBe("leave"));
		expect(decodeStripKey("\x1b[1;1:2B", false).key).toBe("down");
	});
});

describe("send now under modifyOtherKeys", () => {
	it("classifies tmux's extended-keys ctrl+x and ctrl+s", () => {
		expect(classifyKey("\x1b[27;5;120~")).toBe("ctrl+x");
		expect(classifyKey("\x1b[27;5;115~")).toBe("ctrl+s");
		expect(classifyKey("\x1b[27;5;107~")).toBe("other");
		const chord = new SendNowChord();
		expect(chord.feed("\x1b[27;5;120~", true)).toBe("hold");
		expect(chord.feed("\x1b[27;5;115~", true)).toBe("send");
	});
});

describe("the strip yields ↓ to the editor inside a draft", () => {
	const editor = (lines: string[], line: number, extra: Record<string, unknown> = {}) => ({
		getLines: () => lines,
		getCursor: () => ({ line, col: 0 }),
		isShowingAutocomplete: () => false,
		historyIndex: -1,
		...extra,
	});
	it("takes ↓ on the last line of the draft, or in an empty editor", () => {
		expect(editorYieldsDown(editor([""], 0))).toBe(true);
		expect(editorYieldsDown(editor(["one", "two", "three"], 2))).toBe(true);
	});
	it("passes ↓ through above the last line, while history is shown, or with autocomplete open", () => {
		expect(editorYieldsDown(editor(["one", "two", "three"], 0))).toBe(false);
		expect(editorYieldsDown(editor(["recalled prompt"], 0, { historyIndex: 0 }))).toBe(false);
		expect(editorYieldsDown(editor(["/he"], 0, { isShowingAutocomplete: () => true }))).toBe(false);
	});
	it("keeps the old behaviour for an editor of unknown shape", () => {
		expect(editorYieldsDown(undefined)).toBe(true);
		expect(editorYieldsDown({})).toBe(true);
		expect(editorYieldsDown({ getLines: () => { throw new Error("gone"); } })).toBe(true);
	});
});
