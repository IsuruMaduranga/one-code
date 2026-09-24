import { describe, expect, it } from "vitest";
import { visibleWidth } from "../../extensions/lib/text-width.ts";
import { decodePanelKey, type PanelKey } from "../../extensions/permissions/panel/keys.ts";
import { describeRule, type PanelPaint, renderPanel } from "../../extensions/permissions/panel/render.ts";
import { applyPanelKey, initialPanelState, type PanelEffect, type PanelState, type PanelView, type RuleRow } from "../../extensions/permissions/panel/state.ts";

const paint: PanelPaint = { fg: (_color, text) => text, bold: (text) => text, inverse: (text) => `[${text}]` };

const rule = (raw: string, editable = true, behavior: "allow" | "ask" | "deny" = "allow"): RuleRow => ({
	key: `src\0${raw}`,
	behavior,
	raw,
	sourceLabel: editable ? "From One Code user settings (~/.onecode/settings.json)" : "From Claude Code user settings (~/.claude/settings.json)",
	editable,
	...(editable ? {} : { readOnlyNote: "One Code does not edit Claude Code's files." }),
});

const view = (overrides: Partial<PanelView> = {}): PanelView => ({
	denials: [
		{ id: 1, display: "bash(rm -rf ../elsewhere)", rule: "Irreversible Local Destruction" },
		{ id: 2, display: "write(/etc/hosts)", rule: "Security Weaken" },
	],
	rules: { allow: [rule("Bash(npm test:*)"), rule("Read", false)], ask: [], deny: [rule("Bash(rm:*)", true, "deny")] },
	destinations: [
		{ id: "onecode-project", label: "One Code project settings", description: "Saved in ~/.onecode/projects/p/settings.json" },
		{ id: "onecode-user", label: "One Code user settings", description: "Saved in ~/.onecode/settings.json" },
	],
	ruleError: (raw) => (/^[A-Za-z_]+(\(.*\))?$/.test(raw) ? undefined : `Could not parse "${raw}".`),
	...overrides,
});

const press = (state: PanelState, v: PanelView, ...keys: string[]): PanelEffect[] => {
	const effects: PanelEffect[] = [];
	for (const data of keys) {
		const key = decodePanelKey(data) as PanelKey;
		const effect = applyPanelKey(state, key, v);
		if (effect) effects.push(effect);
	}
	return effects;
};

const ENTER = "\r";
const ESC = "\x1b";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";
const DOWN = "\x1b[B";

describe("/permissions panel state", () => {
	it("opens on Recently denied only when there are denials", () => {
		expect(initialPanelState(true).tab).toBe("recent");
		expect(initialPanelState(false).tab).toBe("allow");
	});

	it("toggles approval with Enter and retry with r, a retry being an approval", () => {
		const v = view();
		const state = initialPanelState(true);
		press(state, v, ENTER);
		expect([...state.approved]).toEqual([1]);
		press(state, v, DOWN, "r");
		expect([...state.retry]).toEqual([2]);
		expect([...state.approved].sort()).toEqual([1, 2]);
		// r again takes the retry back but leaves the approval (Claude Code).
		press(state, v, "r");
		expect(state.retry.size).toBe(0);
		expect(state.approved.has(2)).toBe(true);
		// Un-approving a retried row drops its retry too.
		press(state, v, "r", ENTER);
		expect(state.approved.has(2)).toBe(false);
		expect(state.retry.has(2)).toBe(false);
	});

	it("closes on Esc or ctrl+c, and switches tabs with ←/→ and Tab", () => {
		const v = view();
		const state = initialPanelState(true);
		press(state, v, RIGHT);
		expect(state.tab).toBe("allow");
		press(state, v, "\t", "\t");
		expect(state.tab).toBe("deny");
		press(state, v, RIGHT);
		expect(state.tab).toBe("recent");
		press(state, v, LEFT);
		expect(state.tab).toBe("deny");
		expect(press(state, v, ESC)).toEqual([{ kind: "close" }]);
		expect(press(initialPanelState(true), v, "\x03")).toEqual([{ kind: "close" }]);
	});

	it("starts a search on a typed key, not on j k m i r or space, and Esc clears it before closing", () => {
		const v = view();
		const state = initialPanelState(false);
		press(state, v, "j");
		expect(state.cursor.allow).toBe(1);
		press(state, v, "k", "m", "i", "r", " ");
		expect(state.searching).toBe(false);
		expect(state.cursor.allow).toBe(0);
		press(state, v, "n", "p");
		expect(state.search.allow).toBe("np");
		press(state, v, "\x7f");
		expect(state.search.allow).toBe("n");
		expect(press(state, v, ESC)).toEqual([]);
		expect(state.search.allow).toBe("");
		expect(press(state, v, ESC)).toEqual([{ kind: "close" }]);
		press(state, v, "/");
		expect(state.searching).toBe(true);
		expect(state.search.allow).toBe("");
	});

	it("adds a rule: type it, fix a bad one, then pick where it is saved", () => {
		const v = view();
		const state = initialPanelState(false);
		press(state, v, ENTER);
		expect(state.dialog).toEqual({ kind: "addRule", behavior: "allow", draft: "" });
		press(state, v, "B", "a", "s", "h", "(", ENTER);
		expect(state.notice).toContain("Could not parse");
		expect(state.dialog?.kind).toBe("addRule");
		press(state, v, ")", ENTER);
		expect(state.dialog).toEqual({ kind: "saveRule", behavior: "allow", rule: "Bash()", cursor: 0 });
		// Esc goes back to the draft.
		press(state, v, ESC);
		expect(state.dialog).toEqual({ kind: "addRule", behavior: "allow", draft: "Bash()" });
		expect(press(state, v, ENTER, DOWN, DOWN, ENTER)).toEqual([{ kind: "addRule", behavior: "allow", rule: "Bash()", destination: "onecode-user" }]);
		expect(state.dialog).toBeUndefined();
	});

	it("deletes an editable rule only on Yes, and only shows a read-only one", () => {
		const v = view();
		const state = initialPanelState(false);
		// Rows: Add a new rule…, Bash(npm test:*), Read.
		press(state, v, DOWN, ENTER);
		expect(state.dialog).toMatchObject({ kind: "ruleDetail", key: "src\0Bash(npm test:*)" });
		expect(press(state, v, "n", ENTER)).toEqual([]);
		expect(press(state, v, ENTER, ENTER)).toEqual([{ kind: "deleteRule", behavior: "allow", key: "src\0Bash(npm test:*)" }]);
		press(state, v, DOWN, ENTER);
		expect(state.dialog).toMatchObject({ kind: "ruleDetail", key: "src\0Read" });
		expect(press(state, v, "y", ENTER)).toEqual([]);
		expect(state.dialog).toBeUndefined();
	});

	it("hides Add a new rule while a query filters the list", () => {
		const v = view();
		const state = initialPanelState(false);
		press(state, v, "R", "e");
		press(state, v, ENTER);
		expect(state.dialog).toMatchObject({ kind: "ruleDetail", key: "src\0Read" });
	});
});

describe("/permissions panel rendering", () => {
	const render = (state: PanelState, v: PanelView, width = 100) => renderPanel({ state, view: v, width, height: 30, status: "Mode: auto · 2 blocked by auto mode this session" }, paint);

	it("shows denials with their marks, retry and rule, and the approve hints", () => {
		const state = initialPanelState(true);
		const v = view();
		press(state, v, "r");
		const text = render(state, v).join("\n");
		expect(text).toContain("[ Recently denied ]");
		expect(text).toContain("Commands recently denied by the auto mode classifier.");
		expect(text).toContain("❯ ✔ bash(rm -rf ../elsewhere) (retry)  [Irreversible Local Destruction]");
		expect(text).toContain("  ✗ write(/etc/hosts)  [Security Weaken]");
		expect(text).toContain("Enter to approve · r to retry");
		expect(text).toContain("Approvals apply when you close the panel.");
	});

	it("says so when nothing was denied", () => {
		const text = render(initialPanelState(false), view({ denials: [] }), 100).join("\n");
		expect(text).toContain("One Code won't ask before using allowed tools.");
		const state = initialPanelState(false);
		press(state, view({ denials: [] }), LEFT);
		expect(render(state, view({ denials: [] })).join("\n")).toContain("No recent denials.");
	});

	it("names where a read-only rule lives and describes rules the way Claude Code does", () => {
		const state = initialPanelState(false);
		const v = view();
		expect(render(state, v).join("\n")).toContain("Read  · Claude Code user settings (~/.claude/settings.json)");
		press(state, v, DOWN, ENTER);
		const detail = render(state, v).join("\n");
		expect(detail).toContain("Delete allowed tool?");
		expect(detail).toContain("Any Bash command starting with npm test");
		expect(describeRule("Bash")).toBe("Any Bash command");
		expect(describeRule("Bash(git status)")).toBe("The Bash command git status");
		expect(describeRule("WebFetch")).toBe("Any use of the WebFetch tool");
		expect(describeRule("Read(src/**)")).toBeUndefined();
	});

	it("never renders a line wider than the terminal", () => {
		const long = "x".repeat(300);
		const v = view({
			denials: [{ id: 1, display: `bash(${long} 漢字漢字)`, rule: "Irreversible Local Destruction" }],
			rules: { allow: [rule(`Bash(${long})`, false)], ask: [], deny: [] },
		});
		for (const width of [30, 60, 100]) {
			for (const setup of [[], [RIGHT], [RIGHT, ENTER], [RIGHT, DOWN, ENTER]]) {
				const state = initialPanelState(true);
				press(state, v, ...setup);
				for (const line of render(state, v, width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});
});
