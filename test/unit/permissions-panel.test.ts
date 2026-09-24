import { describe, expect, it } from "vitest";
import { visibleWidth } from "../../extensions/lib/text-width.ts";
import { decodePanelKey, type PanelKey } from "../../extensions/permissions/panel/keys.ts";
import { describeRule, type PanelPaint, renderPanel } from "../../extensions/permissions/panel/render.ts";
import { type AutoEntryRow, applyPanelKey, initialPanelState, type PanelEffect, type PanelState, type PanelView, type RuleRow } from "../../extensions/permissions/panel/state.ts";

const paint: PanelPaint = { fg: (_color, text) => text, bold: (text) => text, inverse: (text) => `[${text}]` };

const rule = (raw: string, editable = true, behavior: "allow" | "ask" | "deny" = "allow"): RuleRow => ({
	key: `src\0${raw}`,
	behavior,
	raw,
	sourceLabel: editable ? "From One Code user settings (~/.onecode/settings.json)" : "From Claude Code user settings (~/.claude/settings.json)",
	editable,
	...(editable ? {} : { readOnlyNote: "One Code does not edit Claude Code's files." }),
});

const autoEntry = (section: AutoEntryRow["section"], text: string, editable = true): AutoEntryRow => ({
	key: `src\0${section}\0${text}`,
	section,
	text,
	sourceLabel: editable ? "From One Code user settings (~/.onecode/settings.json)" : "From Claude Code user settings (~/.claude/settings.json)",
	editable,
	...(editable ? {} : { readOnlyNote: "One Code does not edit Claude Code's files." }),
});

const view = (overrides: Partial<PanelView> = {}): PanelView => ({
	autoMode: {
		builtins: { allow: 17, soft_deny: 69, hard_deny: 1 },
		entries: [autoEntry("allow", "Staging Deploys: deploys to the staging cluster"), autoEntry("soft_deny", "Prod DB: any write to the production database", false)],
		environment: { lines: ["### Org-wide", "a", "b", "c", "d", "e"], summary: "Built-in default", isDefault: true },
	},
	workspace: {
		cwd: "/work/project",
		dirs: [
			{ key: "session\0\0/work/shared", path: "/work/shared", sourceLabel: "Added for this session", editable: true },
			{ key: "claude-user\0x\0/work/libs", path: "/work/libs", sourceLabel: "From Claude Code user settings (~/.claude/settings.json)", editable: false, readOnlyNote: "One Code does not edit Claude Code's files." },
		],
	},
	validateDir: (input) => (input.startsWith("/") ? { path: input } : { error: `${input} does not exist.` }),
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
		press(state, v, RIGHT, RIGHT);
		expect(state.tab).toBe("workspace");
		press(state, v, RIGHT);
		expect(state.tab).toBe("recent");
		press(state, v, LEFT);
		expect(state.tab).toBe("workspace");
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
		expect(press(state, v, ENTER, DOWN, ENTER)).toEqual([{ kind: "addRule", behavior: "allow", rule: "Bash()", destination: "onecode-user" }]);
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

describe("/permissions panel Auto mode tab", () => {
	const onAutoMode = (v: PanelView) => {
		const state = initialPanelState(false);
		press(state, v, LEFT, LEFT, LEFT);
		expect(state.tab).toBe("automode");
		return state;
	};

	it("adds a rule to the section picked, and refuses $defaults", () => {
		const v = view();
		const state = onAutoMode(v);
		press(state, v, ENTER);
		expect(state.dialog).toEqual({ kind: "pickSection", cursor: 0 });
		press(state, v, DOWN, DOWN, ENTER);
		expect(state.dialog).toMatchObject({ kind: "autoRuleInput", section: "hard_deny" });
		press(state, v, ..."$defaults".split(""), ENTER);
		expect(state.notice).toContain("built-in rules always apply");
		for (let i = 0; i < 9; i++) press(state, v, "\x7f");
		expect(press(state, v, ..."No prod".split(""), ENTER)).toEqual([{ kind: "addAutoRule", section: "hard_deny", text: "No prod" }]);
	});

	it("explains that built-in rules are always on, with no toggle", () => {
		const v = view();
		const state = onAutoMode(v);
		press(state, v, DOWN, ENTER);
		expect(state.dialog).toEqual({ kind: "builtinsInfo", section: "allow" });
		const text = renderPanel({ state, view: v, width: 100, height: 30 }, paint).join("\n");
		expect(text).toContain("always in effect in One Code");
		expect(text).not.toMatch(/Disable built-in/);
		expect(press(state, v, ENTER)).toEqual([]);
		expect(state.dialog).toBeUndefined();
	});

	it("edits or deletes an editable entry, and only shows a read-only one", () => {
		const v = view();
		const state = onAutoMode(v);
		// Rows: add, allow built-ins, allow entry, soft built-ins, soft entry, hard built-ins, environment.
		press(state, v, DOWN, DOWN, ENTER);
		expect(state.dialog).toMatchObject({ kind: "autoRuleDetail", cursor: 0 });
		press(state, v, ENTER);
		expect(state.dialog).toMatchObject({ kind: "autoRuleInput", section: "allow", draft: "Staging Deploys: deploys to the staging cluster" });
		press(state, v, "!");
		expect(press(state, v, ENTER)).toEqual([{ kind: "editAutoRule", key: "src\0allow\0Staging Deploys: deploys to the staging cluster", text: "Staging Deploys: deploys to the staging cluster!" }]);
		press(state, v, ENTER, "d", ENTER);
		expect(state.dialog).toMatchObject({ kind: "autoRuleDelete", cursor: 1 });
		expect(press(state, v, "y", ENTER)).toEqual([{ kind: "deleteAutoRule", key: "src\0allow\0Staging Deploys: deploys to the staging cluster" }]);
		press(state, v, DOWN, DOWN, ENTER);
		expect(state.dialog).toMatchObject({ kind: "autoRuleDetail", key: "src\0soft_deny\0Prod DB: any write to the production database" });
		expect(press(state, v, "d", ENTER)).toEqual([]);
		expect(state.dialog).toBeUndefined();
	});

	it("confirms before replacing the built-in environment, and edits a custom one directly", () => {
		const v = view();
		const state = onAutoMode(v);
		press(state, v, "\x1b[6~");
		press(state, v, ENTER);
		expect(state.dialog).toEqual({ kind: "envConfirm", cursor: 0 });
		expect(press(state, v, ENTER)).toEqual([{ kind: "editEnvironment" }]);
		const custom = view({ autoMode: { ...view().autoMode, environment: { lines: ["x"], summary: "Replaces the built-in default · from One Code user settings", isDefault: false } } });
		const state2 = onAutoMode(custom);
		press(state2, custom, "\x1b[6~");
		expect(press(state2, custom, ENTER)).toEqual([{ kind: "editEnvironment" }]);
	});

	it("renders sections, sources and the environment preview within the width", () => {
		const v = view();
		const state = onAutoMode(v);
		const text = renderPanel({ state, view: v, width: 120, height: 40 }, paint).join("\n");
		expect(text).toContain("Extra rules for the auto mode classifier.");
		expect(text).toContain("Soft allow   Built-in rules · 17 · always in effect");
		expect(text).toContain("Soft deny    Prod DB: any write to the production database  · Claude Code user settings");
		expect(text).toContain("Hard deny    Built-in rules · 1 · always in effect");
		expect(text).toContain("Environment  Built-in default · enter to edit");
		expect(text).toContain("… (+2 more lines)");
		for (const width of [30, 60]) for (const line of renderPanel({ state, view: v, width, height: 40 }, paint)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});
});

describe("/permissions panel Workspace tab", () => {
	const onWorkspace = (v: PanelView) => {
		const state = initialPanelState(false);
		press(state, v, LEFT, LEFT);
		expect(state.tab).toBe("workspace");
		return state;
	};

	it("adds a directory for the session or remembered, after checking it", () => {
		const v = view();
		const state = onWorkspace(v);
		// Rows: /work/shared, /work/libs, Add directory…
		press(state, v, DOWN, DOWN, ENTER);
		expect(state.dialog).toEqual({ kind: "addDir", draft: "" });
		press(state, v, ..."nope".split(""), ENTER);
		expect(state.notice).toBe("nope does not exist.");
		for (let i = 0; i < 4; i++) press(state, v, "\x7f");
		press(state, v, ..."/work/other".split(""), ENTER);
		expect(state.dialog).toEqual({ kind: "rememberDir", path: "/work/other", cursor: 0 });
		expect(press(state, v, DOWN, ENTER)).toEqual([{ kind: "addDir", path: "/work/other", remember: true }]);
		press(state, v, ENTER, ..."/work/x".split(""), ENTER);
		expect(press(state, v, ENTER)).toEqual([{ kind: "addDir", path: "/work/x", remember: false }]);
		// No: nothing is added.
		press(state, v, ENTER, ..."/work/y".split(""), ENTER);
		expect(press(state, v, DOWN, DOWN, ENTER)).toEqual([]);
	});

	it("removes a session directory only on Yes, and explains a read-only one", () => {
		const v = view();
		const state = onWorkspace(v);
		press(state, v, ENTER);
		expect(state.dialog).toEqual({ kind: "removeDir", key: "session\0\0/work/shared", cursor: 1 });
		expect(press(state, v, ENTER)).toEqual([]);
		expect(press(state, v, ENTER, "y", ENTER)).toEqual([{ kind: "removeDir", key: "session\0\0/work/shared" }]);
		press(state, v, DOWN, ENTER);
		const text = renderPanel({ state, view: v, width: 100, height: 30 }, paint).join("\n");
		expect(text).toContain("One Code does not edit Claude Code's files.");
		expect(press(state, v, "y", ENTER)).toEqual([]);
	});

	it("shows the working directory first, then the directories and where they come from", () => {
		const v = view();
		const text = renderPanel({ state: onWorkspace(v), view: v, width: 120, height: 30 }, paint).join("\n");
		expect(text).toContain("One Code can read files in the workspace, and make edits when auto-accept edits is on.");
		expect(text).toContain("   -  /work/project  (Original working directory)");
		expect(text).toContain("❯ /work/shared");
		expect(text).toContain("  /work/libs  · Claude Code user settings (~/.claude/settings.json)");
		expect(text).toContain("  Add directory…");
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
