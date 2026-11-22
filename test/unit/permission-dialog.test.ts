/**
 * The permission gate's dialog (lib/ui/permission-dialog.ts): numbered
 * options a number key picks in one keystroke, the hint row, wrapping at
 * narrow widths, sanitized model text, and the opener's fallback to the
 * gate's exact `ctx.ui.select` call wherever the dialog cannot show.
 */
import { describe, expect, it, vi } from "vitest";
import { keyId } from "../../extensions/lib/ui/key-input.ts";
import { PANEL_FOCUS_CHANNEL } from "../../extensions/lib/ui/panel-focus.ts";
import {
	applyPermissionKey,
	askPermission,
	decodePermissionKey,
	type PermissionDialogView,
	permissionHints,
	renderPermissionDialog,
} from "../../extensions/lib/ui/permission-dialog.ts";
import { visibleWidth } from "../../extensions/lib/ui/text-width.ts";
import { askDialogTitle, askView } from "../../extensions/safety/permissions/ask-view.ts";
import { modeDisplayName } from "../../extensions/safety/permissions/panel/render.ts";

const plain = { paint: (_color: string, text: string) => text, bold: (text: string) => text };
/** pi's resolved bindings: pi-tui's defaults for what the user left alone, the user's list (empty when turned off) for the rest. */
function piKeybindings(user: Record<string, string[]> = {}) {
	const keys: Record<string, string[]> = { "tui.select.up": ["up"], "tui.select.down": ["down"], "tui.select.confirm": ["enter"], "tui.select.cancel": ["escape", "ctrl+c"], "app.tools.expand": ["ctrl+o"], ...user };
	return { getKeys: (id: string) => [...(keys[id] ?? [])], matches: (data: string, id: string) => (keys[id] ?? []).includes(keyId(data) ?? "") };
}

const OPTIONS = ["Yes", "Yes, and allow write anywhere in the working directory this session", "No, tell the agent what to do differently"];
const view = (over: Partial<PermissionDialogView> = {}): PermissionDialogView => ({ title: "Bash command", subject: "ls -la", options: OPTIONS, ...over });
const render = (v: PermissionDialogView, width = 100, cursor = 0, expandKey?: string) => renderPermissionDialog(v, { cursor }, plain, width, expandKey);

describe("permission dialog keys", () => {
	it("decodes arrows, Enter, Esc, ctrl+c, number keys and the expand binding", () => {
		expect(decodePermissionKey("\x1b[A")).toEqual({ kind: "up" });
		expect(decodePermissionKey("\x1b[B")).toEqual({ kind: "down" });
		expect(decodePermissionKey("\r")).toEqual({ kind: "enter" });
		expect(decodePermissionKey("\x1b")).toEqual({ kind: "cancel" });
		expect(decodePermissionKey("\x03")).toEqual({ kind: "cancel" });
		expect(decodePermissionKey("2")).toEqual({ kind: "number", value: 2 });
		expect(decodePermissionKey("0")).toBeUndefined();
		expect(decodePermissionKey("y")).toBeUndefined();
		expect(decodePermissionKey("\x0f", (data) => data === "\x0f")).toEqual({ kind: "expand" });
	});

	it("takes k and j and a bare newline, as pi's select does", () => {
		expect(decodePermissionKey("k")).toEqual({ kind: "up" });
		expect(decodePermissionKey("j")).toEqual({ kind: "down" });
		expect(decodePermissionKey("\n")).toEqual({ kind: "enter" });
	});

	it("follows the user's tui.select bindings through the dialog, and names them in the hint row", async () => {
		// The user moved up/down to ctrl+p/ctrl+n and confirm to tab; cancel keeps pi's default.
		const keybindings = piKeybindings({ "tui.select.up": ["ctrl+p"], "tui.select.down": ["ctrl+n"], "tui.select.confirm": ["tab"] });
		let lines: string[] = [];
		const custom = (factory: (...args: unknown[]) => { render(width: number): string[]; handleInput(data: string): void }) =>
			new Promise((resolve) => {
				const component = factory({ requestRender: () => {} }, {}, keybindings, resolve);
				// The old arrow no longer moves; the user's keys do.
				for (const key of ["\x1b[B", "\x0e", "\x0e", "\x10"]) component.handleInput(key);
				lines = component.render(120);
				component.handleInput("\t");
			});
		const ctx = { hasUI: true, mode: "interactive", ui: { select: vi.fn(), custom } };
		expect(await askPermission({ emit: () => {} }, ctx, view(), "t")).toBe(OPTIONS[1]);
		expect(lines.join("\n")).toContain("ctrl+p/ctrl+n to navigate · tab or 1-3 to select · ctrl+o to expand · Esc to cancel");
	});

	it("never approves with a key the user moved from confirm to cancel", async () => {
		// The user turned confirm off and made Enter cancel: pi's resolved bindings say [] and ["enter"].
		const keybindings = piKeybindings({ "tui.select.confirm": [], "tui.select.cancel": ["enter"] });
		let hint = "";
		const custom = (factory: (...args: unknown[]) => { render(width: number): string[]; handleInput(data: string): void }) =>
			new Promise((resolve) => {
				const component = factory({ requestRender: () => {} }, {}, keybindings, resolve);
				hint = component.render(120).at(-1) ?? "";
				component.handleInput("\r");
			});
		const ctx = { hasUI: true, mode: "interactive", ui: { select: vi.fn(), custom } };
		expect(await askPermission({ emit: () => {} }, ctx, view(), "t")).toBeUndefined();
		// The hint names no confirm key, and Enter as the cancel key.
		expect(hint).toContain("↑/↓ to navigate · 1-3 to select");
		expect(hint).toContain("Enter to cancel");
		// A key bound to both confirm and cancel cancels.
		expect(decodePermissionKey("\r", () => false, (data, action) => keyId(data) === "enter" && (action === "enter" || action === "cancel"))).toEqual({ kind: "cancel" });
	});

	it("a number key answers in one keystroke; one past the options does nothing", () => {
		const state = { cursor: 0 };
		expect(applyPermissionKey(state, OPTIONS, { kind: "number", value: 4 })).toBeUndefined();
		expect(state.cursor).toBe(0);
		expect(applyPermissionKey(state, OPTIONS, { kind: "number", value: 3 })).toEqual({ answer: OPTIONS[2] });
	});

	it("arrows move within the options and Enter answers the focused one; Esc dismisses", () => {
		const state = { cursor: 0 };
		applyPermissionKey(state, OPTIONS, { kind: "up" });
		expect(state.cursor).toBe(0);
		for (let i = 0; i < 5; i++) applyPermissionKey(state, OPTIONS, { kind: "down" });
		expect(state.cursor).toBe(2);
		applyPermissionKey(state, OPTIONS, { kind: "up" });
		expect(applyPermissionKey(state, OPTIONS, { kind: "enter" })).toEqual({ answer: OPTIONS[1] });
		expect(applyPermissionKey(state, OPTIONS, { kind: "cancel" })).toEqual({ answer: undefined });
	});
});

describe("permission dialog rendering", () => {
	it("has Claude Code's shape: title, subject, description, reason, question, numbered options, hints", () => {
		const lines = render(view({ description: "List the files", notes: ["The ask rule Bash(ls:*) matches this call."] }));
		const text = lines.join("\n");
		expect(lines[1]).toBe(" Bash command");
		expect(text).toContain("\n   ls -la\n   List the files\n");
		expect(text).toContain("\n The ask rule Bash(ls:*) matches this call.\n");
		expect(text).toContain("\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and allow write");
		expect(text).toContain("\n   3. No, tell the agent what to do differently\n");
		expect(lines.at(-1)).toBe(" ↑/↓ to navigate · Enter or 1-3 to select · Esc to cancel");
	});

	it("moves the pointer with the cursor and names the expand key when it is bound", () => {
		const lines = render(view(), 100, 2, "ctrl+o");
		expect(lines).toContain(" ❯ 3. No, tell the agent what to do differently");
		expect(lines).toContain("   1. Yes");
		expect(lines.at(-1)).toContain("ctrl+o to expand · Esc to cancel");
	});

	it("wraps a long command, a long path and long options whole at 70 and 40 columns", () => {
		const command = `for f in ${Array.from({ length: 30 }, (_, i) => `file-${i}.txt`).join(" ")}; do wc -l "$f"; done`;
		const path = `/very/long/${"nested-directory/".repeat(8)}target-file.ts`;
		for (const width of [70, 40]) {
			for (const subject of [command, path]) {
				const lines = render(view({ subject }), width);
				for (const line of lines) expect(visibleWidth(line), line).toBeLessThanOrEqual(width);
				// Nothing is cut: the wrapped rows join back to the subject.
				// The subject block runs from under the title's blank line to the next blank line.
				const rows = lines.slice(3, lines.indexOf("", 3));
				expect(rows.length).toBeGreaterThan(1);
				expect(rows.map((line) => line.slice(3)).join("")).toBe(subject);
			}
			const lines = render(view(), width);
			expect(lines.join(" ").replace(/\s+/g, " ")).toContain("allow write anywhere in the working directory this session");
			// Every key stays named on a narrow screen.
			expect(lines.join(" ")).toContain("Esc to cancel");
		}
	});

	it("shows control characters in the subject as escapes and strips them from the description, notes and options", () => {
		const lines = render(
			view({
				subject: "echo hi\x1b]0;pwned\x07",
				description: "\x1b[31mRed\x1b[0m description\x1b]52;c;Zm9v\x07",
				notes: ["Note\x1b[8m hidden"],
				options: ["Yes\x1b[2J", "No"],
			}),
		);
		const text = lines.join("\n");
		expect(text).not.toContain("\x1b");
		expect(text).not.toContain("\x07");
		expect(text).toContain("echo hi\\x1b]0;pwned\\x07");
		expect(text).toContain("Red description");
		expect(text).toContain("Note hidden");
		expect(text).toContain("1. Yes");
	});

	it("never renders a line wider than a tiny terminal", () => {
		for (const width of [1, 5, 12]) for (const line of render(view({ description: "d", notes: ["n"] }), width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});

	it("words the hint for two options", () => {
		expect(permissionHints(2)).toBe("↑/↓ to navigate · Enter or 1-2 to select · Esc to cancel");
	});
});

describe("askPermission", () => {
	const events = { emit: vi.fn() };
	/** A TUI ctx whose custom() builds the component and feeds it `keys`. */
	const tuiCtx = (keys: string[], over: Record<string, unknown> = {}) => {
		const select = vi.fn(async () => "from select");
		const setToolsExpanded = vi.fn();
		let rendered: string[] = [];
		let options: Record<string, unknown> | undefined;
		const custom = vi.fn((factory: (...args: unknown[]) => unknown, opts?: Record<string, unknown>) => {
			options = opts;
			return new Promise((resolve) => {
				const keybindings = piKeybindings();
				const component = factory({ requestRender: () => {} }, {}, keybindings, resolve) as { render(width: number): string[]; handleInput(data: string): void };
				rendered = component.render(80);
				for (const key of keys) component.handleInput(key);
			});
		});
		const ctx = { hasUI: true, mode: "interactive", ui: { select, custom, setToolsExpanded, getToolsExpanded: () => false }, ...over };
		return { ctx, select, custom, setToolsExpanded, rendered: () => rendered, options: () => options };
	};

	it("returns the option a number key picks, the same string select would", async () => {
		const t = tuiCtx(["2"]);
		expect(await askPermission(events, t.ctx, view(), "Allow bash?\n\n  ls -la")).toBe(OPTIONS[1]);
		expect(t.select).not.toHaveBeenCalled();
		expect(t.rendered()[1]).toBe(" Bash command");
		expect(t.options()).toEqual({ blocked: { kind: "permission", message: "Bash command" } });
	});

	it("answers with arrows and Enter, and dismisses with Esc", async () => {
		expect(await askPermission(events, tuiCtx(["\x1b[B", "\x1b[B", "\r"]).ctx, view(), "t")).toBe(OPTIONS[2]);
		expect(await askPermission(events, tuiCtx(["\x1b"]).ctx, view(), "t")).toBeUndefined();
	});

	it("toggles tool output with the expand key and stays open", async () => {
		const t = tuiCtx(["\x0f", "1"]);
		expect(await askPermission(events, t.ctx, view(), "t")).toBe("Yes");
		expect(t.setToolsExpanded).toHaveBeenCalledWith(true);
		expect(t.rendered().at(-1)).toContain("ctrl+o to expand");
	});

	it("opens through panel focus like every panel: answering reports it gone", async () => {
		const emit = vi.fn();
		expect(await askPermission({ emit }, tuiCtx(["1"]).ctx, view(), "t")).toBe("Yes");
		expect(emit).toHaveBeenCalledWith(PANEL_FOCUS_CHANNEL, expect.objectContaining({ focused: false }));
	});

	it("closes as dismissed when the turn aborts while it shows", async () => {
		const abort = new AbortController();
		const t = tuiCtx([]);
		const answer = askPermission(events, t.ctx, view(), "t", { signal: abort.signal });
		abort.abort();
		expect(await answer).toBeUndefined();
	});

	describe("on an 80x24 terminal", () => {
		const shown = async (over: Partial<PermissionDialogView>) => {
			let lines: string[] = [];
			const custom = (factory: (...args: unknown[]) => { render(width: number): string[]; handleInput(data: string): void }) =>
				new Promise((resolve) => {
					const component = factory({ requestRender: () => {}, terminal: { rows: 24, columns: 80 } }, {}, piKeybindings(), resolve);
					lines = component.render(80);
					component.handleInput("\x1b");
				});
			await askPermission({ emit: () => {} }, { hasUI: true, mode: "interactive", ui: { select: vi.fn(), custom } }, view(over), "t");
			return lines;
		};
		const visible = (lines: string[]) => {
			// pi's two footer lines sit under the dialog.
			expect(lines.length).toBeLessThanOrEqual(22);
			expect(lines).toContain(" Do you want to proceed?");
			for (const [index, option] of OPTIONS.entries()) expect(lines.some((line) => line.includes(`${index + 1}. ${option.slice(0, 20)}`))).toBe(true);
			expect(lines.at(-1)).toContain("Esc to cancel");
		};

		it("cuts a 30-line description with a more-lines row", async () => {
			const lines = await shown({ subject: "ls", description: Array.from({ length: 30 }, (_, i) => `Description line ${i}`).join("\n") });
			visible(lines);
			expect(lines).toContain("   ls");
			expect(lines.some((line) => /… \d+ more lines/.test(line))).toBe(true);
		});

		it("cuts a 40-line command, keeping its first lines", async () => {
			const lines = await shown({ subject: Array.from({ length: 40 }, (_, i) => `echo ${i}`).join("\n") });
			visible(lines);
			expect(lines).toContain("   echo 0");
			expect(lines.some((line) => /… \d+ more lines/.test(line))).toBe(true);
		});
	});

	it("keeps pi's select while the prompt editor holds a draft, which custom() would rewrite on close", async () => {
		const drafted = tuiCtx(["1"]);
		Object.assign(drafted.ctx.ui, { getEditorText: () => "fix the parser [paste #1 +200 lines]" });
		expect(await askPermission(events, drafted.ctx, view(), "t")).toBe("from select");
		expect(drafted.custom).not.toHaveBeenCalled();
		const empty = tuiCtx(["1"]);
		Object.assign(empty.ctx.ui, { getEditorText: () => "" });
		expect(await askPermission(events, empty.ctx, view(), "t")).toBe("Yes");
	});

	it("asks through the gate's exact select call in RPC, for a timed prompt, and where custom() builds nothing", async () => {
		const abort = new AbortController();
		const rpc = tuiCtx(["1"], { mode: "rpc" });
		expect(await askPermission(events, rpc.ctx, view(), "Allow bash?\n\n  ls -la", { signal: abort.signal })).toBe("from select");
		expect(rpc.select).toHaveBeenCalledWith("Allow bash?\n\n  ls -la", OPTIONS, { signal: abort.signal });
		expect(rpc.custom).not.toHaveBeenCalled();

		const timed = tuiCtx(["1"]);
		expect(await askPermission(events, timed.ctx, view(), "paused", { timeout: 5000 })).toBe("from select");
		expect(timed.select).toHaveBeenCalledWith("paused", OPTIONS, { signal: undefined, timeout: 5000 });

		const stub = { hasUI: true, mode: "interactive", ui: { select: vi.fn(async () => "No"), custom: vi.fn(async () => undefined) } };
		expect(await askPermission(events, stub, view(), "t")).toBe("No");
		expect(stub.ui.select).toHaveBeenCalledWith("t", OPTIONS, { signal: undefined });
	});
});

describe("askView", () => {
	it("titles a shell call as Claude Code does and other tools by their Claude Code name", () => {
		expect(askDialogTitle("bash")).toBe("Bash command");
		expect(askDialogTitle("bash", true)).toBe("Bash command (unsandboxed)");
		expect(askDialogTitle("write")).toBe("Write");
		expect(askDialogTitle("edit")).toBe("Edit");
		expect(askDialogTitle("read")).toBe("Read");
		expect(askDialogTitle("web_fetch")).toBe("WebFetch");
		expect(askDialogTitle("mcp__github__get_issue")).toBe("mcp__github__get_issue");
	});

	it("shows a shell call's description, and no description for other tools", () => {
		const base = { subject: "x", cause: "tier", pausedResume: false, unsandboxed: false, options: OPTIONS };
		expect(askView({ ...base, toolName: "bash", input: { command: "x", description: "Do x" } }).description).toBe("Do x");
		expect(askView({ ...base, toolName: "mcp__s__t", input: { description: "a field" } }).description).toBeUndefined();
		expect(askView({ ...base, toolName: "bash", subject: "" }).subject).toBe("(no arguments)");
	});

	it("says why it asks from what the gate already has", () => {
		const base = { toolName: "write", subject: "a", pausedResume: false, unsandboxed: false, options: OPTIONS };
		expect(askView({ ...base, cause: "tier" }).notes).toEqual([]);
		expect(askView({ ...base, cause: "rule", rule: "Write(a)" }).notes).toEqual(["The ask rule Write(a) matches this call."]);
		expect(askView({ ...base, cause: "working-dir" }).notes).toEqual(["This is outside the working directory."]);
		expect(askView({ ...base, cause: "protected-path" }).notes?.[0]).toContain("protected path");
		expect(askView({ ...base, cause: "plan-unproven" }).notes?.[0]).toContain("Plan mode could not confirm");
		expect(askView({ ...base, cause: "tier", pausedResume: true }).notes).toEqual(["Auto mode is paused after repeated blocks. Approve to resume."]);
		expect(askView({ ...base, cause: "tier", agent: "explore" }).notes).toEqual(["Requested by subagent explore."]);
		expect(askView({ ...base, cause: "tier", agent: null }).notes).toEqual(["Requested by a subagent."]);
		expect(askView({ ...base, cause: "mode", fallback: "Review failed" }).notes).toEqual(["Review failed"]);
	});
});

describe("modeDisplayName", () => {
	it("names each mode as the mode line does", () => {
		expect(modeDisplayName("default")).toBe("manual mode");
		expect(modeDisplayName("acceptEdits")).toBe("accept edits");
		expect(modeDisplayName("plan")).toBe("plan mode");
		expect(modeDisplayName("auto")).toBe("auto mode");
		expect(modeDisplayName("bypassPermissions")).toBe("bypass permissions");
		expect(modeDisplayName("dontAsk")).toBe("don't ask");
	});
});
