/**
 * The prompt editor's wiring of the conveniences (the pure modules have their
 * own tests): the `?` panel, esc esc, the stash and its restore after a
 * submit, ctrl+r, the border title, and the command menu's ellipsis drawn by
 * pi-tui's own list.
 */
import { describe, expect, it } from "vitest";
import { visibleWidth } from "../../extensions/lib/ui/text-width.ts";
import { type EditorKeys, PromptEditor, type PromptEditorHooks } from "../../extensions/ui/branding/prompt-editor.ts";

const plain = (text: string) => text;
const theme = { borderColor: plain, selectList: { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain } };
const strip = (line: string) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b_[^\x07]*\x07/g, "");

/** pi's bindings for the keys these tests press; `extra` rebinds or adds. */
function keys(extra: Record<string, string> = {}) {
	const bound: Record<string, string> = { "app.interrupt": "\x1b", "app.clear": "\x03", "tui.input.submit": "\r", "tui.editor.deleteCharBackward": "\x7f", ...extra };
	return {
		matches: (data: string, id: string) => bound[id] === data,
		getResolvedBindings: () => Object.fromEntries(Object.keys(bound).map((id) => [id, "bound"])),
	};
}

function editor(hooks: Partial<PromptEditorHooks> = {}, keyMap = keys(), rows = 45) {
	const tui = { requestRender: () => {}, terminal: { rows, columns: 100 } };
	let clock = 0;
	const seen: EditorKeys[] = [];
	const prompt = new PromptEditor(tui as never, theme as never, keyMap as never, {
		marker: () => "> ",
		shortcuts: (_width, editorKeys) => {
			seen.push(editorKeys);
			return ["  ! for shell mode"];
		},
		now: () => clock,
		...hooks,
	});
	return { prompt, seen, tick: (ms: number) => (clock += ms), below: (width = 80) => prompt.render(width).map(strip).slice(3) };
}

describe("the ? panel", () => {
	it("opens on an empty editor and closes on the next key, which still types", () => {
		const { prompt, below } = editor();
		prompt.handleInput("?");
		expect(prompt.getText()).toBe("");
		expect(below()).toEqual(["  ! for shell mode"]);
		prompt.handleInput("a");
		expect(prompt.getText()).toBe("a");
		expect(below()).toEqual([]);
	});

	it("types a ? into text, from a paste, or after a second ? closes the panel", () => {
		const typed = editor();
		typed.prompt.setText("why");
		typed.prompt.handleInput("?");
		expect(typed.prompt.getText()).toBe("why?");
		const pasted = editor();
		pasted.prompt.handleInput("\x1b[200~?\x1b[201~");
		expect(pasted.below()).toEqual([]);
		const twice = editor();
		twice.prompt.handleInput("?");
		twice.prompt.handleInput("?");
		expect(twice.prompt.getText()).toBe("");
		expect(twice.below()).toEqual([]);
	});

	it("opens on a kitty-encoded ? press but not on its release", () => {
		const { prompt, below } = editor();
		prompt.handleInput("\x1b[63u");
		expect(below()).toEqual(["  ! for shell mode"]);
		// The release that follows the press is neither a second ? nor a new key.
		const released = editor();
		released.prompt.handleInput("\x1b[63;1:3u");
		expect(released.below()).toEqual([]);
	});

	it("builds the panel once per width while it stays open, and again after it reopens", () => {
		const { prompt, seen, below } = editor();
		prompt.handleInput("?");
		below();
		below();
		expect(seen).toHaveLength(1);
		below(60);
		expect(seen).toHaveLength(2);
		prompt.handleInput("a");
		prompt.setText("");
		prompt.handleInput("?");
		below(60);
		expect(seen).toHaveLength(3);
	});

	it("treats a ? inside a paste that arrives in pieces as text", () => {
		const { prompt, below } = editor();
		prompt.handleInput("\x1b[200~");
		prompt.handleInput("?");
		expect(below()).toEqual([]);
	});
});

describe("esc esc", () => {
	it("clears a draft on a second Esc inside the window, with the hint between", () => {
		const { prompt, tick, below } = editor();
		prompt.setText("draft");
		prompt.handleInput("\x1b");
		expect(prompt.getText()).toBe("draft");
		expect(below()).toEqual(["  esc again to clear"]);
		tick(500);
		prompt.handleInput("\x1b");
		expect(prompt.getText()).toBe("");
	});

	it("keeps the draft when the first Esc stops a running ! command", async () => {
		const { prompt } = editor();
		let finish: () => void = () => {};
		// pi runs a `!` command inside its submit handler and settles it when the command ends.
		prompt.onSubmit = async () => {
			await new Promise<void>((resolve) => (finish = resolve));
		};
		prompt.setText("!sleep 30");
		prompt.handleInput("\r");
		prompt.setText("draft");
		prompt.handleInput("\x1b");
		prompt.handleInput("\x1b");
		expect(prompt.getText()).toBe("draft");
		// Once it has ended, esc esc clears again.
		finish();
		await new Promise((resolve) => setTimeout(resolve, 0));
		prompt.handleInput("\x1b");
		prompt.handleInput("\x1b");
		expect(prompt.getText()).toBe("");
	});

	it("keeps the draft when the second Esc is late, or while a turn runs", () => {
		const late = editor();
		late.prompt.setText("draft");
		late.prompt.handleInput("\x1b");
		late.tick(900);
		expect(late.below()).toEqual([]);
		late.prompt.handleInput("\x1b");
		expect(late.prompt.getText()).toBe("draft");
		const busy = editor({ idle: () => false });
		busy.prompt.setText("draft");
		busy.prompt.handleInput("\x1b");
		busy.prompt.handleInput("\x1b");
		expect(busy.prompt.getText()).toBe("draft");
	});
});

describe("ctrl+s stash", () => {
	it("stashes, shows the notice, and comes back after the next submit", () => {
		const { prompt, below } = editor();
		const submitted: string[] = [];
		prompt.onSubmit = (text) => {
			submitted.push(text);
		};
		prompt.setText("keep this");
		prompt.handleInput("\x13");
		expect(prompt.getText()).toBe("");
		expect(below()).toEqual(["  › Stashed (auto-restores after submit)"]);
		prompt.setText("ask now");
		prompt.handleInput("\r");
		expect(submitted).toEqual(["ask now"]);
		expect(prompt.getText()).toBe("keep this");
		expect(below()).toEqual([]);
	});

	it("comes back after a command whose handler clears the editor after an await (pi's /copy), unless the user typed meanwhile", async () => {
		const { prompt, below } = editor();
		let release: () => void = () => {};
		// pi's /copy: await the command, then setText("").
		prompt.onSubmit = async () => {
			await new Promise<void>((resolve) => (release = resolve));
			prompt.setText("");
		};
		prompt.setText("keep this");
		prompt.handleInput("\x13");
		prompt.setText("/copy");
		prompt.handleInput("\r");
		expect(prompt.getText()).toBe("");
		release();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(prompt.getText()).toBe("keep this");
		expect(below()).toEqual([]);
		// Typed while a command ran (one whose handler leaves the editor alone): the draft stays, and so do the stash and its notice.
		prompt.onSubmit = async () => {
			await new Promise<void>((resolve) => (release = resolve));
		};
		prompt.handleInput("\x13");
		prompt.setText("/help");
		prompt.handleInput("\r");
		prompt.setText("new draft");
		release();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(prompt.getText()).toBe("new draft");
		expect(below()).toEqual(["  › Stashed (auto-restores after submit)"]);
	});

	it("leaves a ctrl+s the ctrl+x chord offers, and a ctrl+s the user bound in pi", () => {
		const chord = editor({ chordKey: () => "ctrl+s" });
		chord.prompt.setText("text");
		chord.prompt.handleInput("\x13");
		expect(chord.prompt.getText()).toBe("text");
		const rebound = editor({}, keys({ "tui.editor.cursorLeft": "\x13" }));
		rebound.prompt.setText("text");
		rebound.prompt.handleInput("\x13");
		expect(rebound.prompt.getText()).toBe("text");
		// Nor does the ? panel offer it.
		rebound.prompt.setText("");
		rebound.prompt.handleInput("?");
		rebound.below();
		expect(rebound.seen.at(-1)).toEqual({ clearInput: true, historySearch: "ctrl+r" });
	});
});

describe("ctrl+r history search", () => {
	it("finds a prompt pi recorded, and ctrl+c puts the draft back", () => {
		const { prompt, below } = editor();
		prompt.addToHistory("run the tests");
		prompt.addToHistory("deploy it");
		prompt.setText("draft");
		prompt.handleInput("\x12");
		for (const ch of "run") prompt.handleInput(ch);
		expect(prompt.getText()).toBe("run the tests");
		expect(below()).toEqual(["  search prompts: run"]);
		prompt.handleInput("\x03");
		expect(prompt.getText()).toBe("draft");
		expect(below()).toEqual([]);
	});

	it("submits the match on Enter", () => {
		const { prompt } = editor();
		const submitted: string[] = [];
		prompt.onSubmit = (text) => {
			submitted.push(text);
		};
		prompt.addToHistory("deploy it");
		prompt.handleInput("\x12");
		prompt.handleInput("d");
		prompt.handleInput("\r");
		expect(submitted).toEqual(["deploy it"]);
	});
});

describe("the border title", () => {
	it("sits at the right of the top border, and is absent without a name", () => {
		const named = editor({ title: () => "Auto-mode handoff feature" });
		expect(strip(named.prompt.render(60)[0] ?? "")).toBe(`${"─".repeat(60 - 28)} Auto-mode handoff feature ─`);
		const unnamed = editor();
		expect(strip(unnamed.prompt.render(60)[0] ?? "")).toBe("─".repeat(60));
	});

	it("goes before an agent badge", () => {
		const both = editor({ title: () => "Title", badge: () => "@agent", paintBadge: (label) => ` ${label} ` });
		expect(strip(both.prompt.render(60)[0] ?? "")).toMatch(/─ Title ─ @agent ─$/);
	});
});

describe("the command menu", () => {
	it("ends a cut description with an ellipsis in pi-tui's list, and sizes the list by the terminal", async () => {
		const { prompt } = editor({}, keys(), 34);
		const long = "Health-check your setup and fix what is wrong, a checkup run by the model, with a report";
		const items = Array.from({ length: 15 }, (_, i) => ({ value: `cmd${i}`, label: `/cmd${i}`, description: long }));
		prompt.setAutocompleteProvider({
			getSuggestions: async () => ({ items, prefix: "/" }),
			applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
		});
		prompt.render(70);
		prompt.handleInput("/");
		await new Promise((resolve) => setTimeout(resolve, 50));
		const lines = prompt.render(70).map(strip);
		const rows = lines.filter((line) => line.includes("/cmd"));
		// 34 rows: ten menu rows (34 less the 24 kept for the rest).
		expect(rows).toHaveLength(10);
		for (const row of rows) {
			expect(row.trimEnd().endsWith("…")).toBe(true);
			expect(visibleWidth(row)).toBeLessThanOrEqual(70);
		}
	});
});
