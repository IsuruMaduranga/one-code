import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	isSkillEnabled,
	nextSkillState,
	readSkillStates,
	setSkillOverride,
	setSkillState,
	skillListingVisibility,
	skillOverrideKey,
	skillStateFor,
} from "../../extensions/lib/skill-overrides.ts";
import { decodeSkillsKey } from "../../extensions/skill/panel/keys.ts";
import { applySkillsKey, initialSkillsState, type SkillsRow, visibleRows } from "../../extensions/skill/panel/state.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "skills-"));

describe("skill-overrides 4-state store", () => {
	it("defaults an absent skill to on", () => {
		expect(skillStateFor({}, "user:x")).toBe("on");
	});

	it("cycles on → name-only → user-only → off → on", () => {
		expect(nextSkillState("on")).toBe("name-only");
		expect(nextSkillState("name-only")).toBe("user-only");
		expect(nextSkillState("user-only")).toBe("off");
		expect(nextSkillState("off")).toBe("on");
	});

	it("maps each state to a listing visibility", () => {
		expect(skillListingVisibility("on")).toBe("full");
		expect(skillListingVisibility("name-only")).toBe("name");
		expect(skillListingVisibility("user-only")).toBe("hidden");
		expect(skillListingVisibility("off")).toBe("hidden");
	});

	it("persists and reads back a state", () => {
		const root = tmp();
		setSkillState(root, "project:deploy", "name-only");
		expect(skillStateFor(readSkillStates(root), "project:deploy")).toBe("name-only");
	});

	it("coerces legacy booleans (true → on, false → off)", () => {
		const root = tmp();
		writeFileSync(join(root, "skill-overrides.json"), JSON.stringify({ "user:a": true, "user:b": false }));
		const states = readSkillStates(root);
		expect(states["user:a"]).toBe("on");
		expect(states["user:b"]).toBe("off");
	});

	it("boolean-facing wrappers stay compatible with the store", () => {
		const root = tmp();
		setSkillOverride(root, skillOverrideKey("plugin", "p:helper"), false);
		expect(readFileSync(join(root, "skill-overrides.json"), "utf-8")).toContain('"off"');
		expect(isSkillEnabled(readSkillStates(root), "plugin:p:helper")).toBe(false);
		expect(isSkillEnabled({}, "user:absent")).toBe(true);
	});
});

describe("/skills panel state machine", () => {
	const rows: SkillsRow[] = [
		{ key: "user:zeta", name: "zeta", scope: "user", tokens: 100, state: "on", locked: false },
		{ key: "user:alpha", name: "alpha", scope: "user", tokens: 50, state: "off", locked: false },
		{ key: "plugin:p:tool", name: "p:tool", scope: "plugin", tokens: 60, state: "on", locked: true, pluginName: "p" },
	];

	it("sorts by name by default", () => {
		const view = visibleRows(rows, initialSkillsState());
		expect(view.map((r) => r.name)).toEqual(["alpha", "p:tool", "zeta"]);
	});

	it("filters by search query", () => {
		const state = { ...initialSkillsState(), search: "alp" };
		expect(visibleRows(rows, state).map((r) => r.name)).toEqual(["alpha"]);
	});

	it("state sort groups locked rows last", () => {
		const state = { ...initialSkillsState(), sort: "state" as const };
		const view = visibleRows(rows, state);
		// on (zeta) → off (alpha) → locked (p:tool)
		expect(view.map((r) => r.name)).toEqual(["zeta", "alpha", "p:tool"]);
	});

	it("space cycles a non-locked row", () => {
		const state = initialSkillsState();
		const view = visibleRows(rows, state); // alpha, p:tool, zeta
		const effect = applySkillsKey(state, { kind: "space" }, view);
		expect(effect).toEqual({ kind: "cycle", row: view[0] });
	});

	it("space on a locked row produces a locked effect without cycling", () => {
		const state = { ...initialSkillsState(), cursor: 1 };
		const view = visibleRows(rows, state); // cursor on p:tool (locked)
		expect(applySkillsKey(state, { kind: "space" }, view)).toEqual({ kind: "locked", row: view[1] });
	});

	it("/ enters search, Esc leaves it before closing", () => {
		const state = initialSkillsState();
		applySkillsKey(state, { kind: "text", text: "/" }, rows);
		expect(state.searching).toBe(true);
		applySkillsKey(state, { kind: "text", text: "de" }, rows);
		expect(state.search).toBe("de");
		expect(applySkillsKey(state, { kind: "back" }, rows)).toBeUndefined();
		expect(state.searching).toBe(false);
		expect(state.search).toBe("");
		expect(applySkillsKey(state, { kind: "back" }, rows)).toEqual({ kind: "close" });
	});

	it("t toggles the sort mode", () => {
		const state = initialSkillsState();
		applySkillsKey(state, { kind: "text", text: "t" }, rows);
		expect(state.sort).toBe("state");
	});

	it("decodes navigation and space keys", () => {
		expect(decodeSkillsKey("\x1b[B")).toEqual({ kind: "down" });
		expect(decodeSkillsKey(" ")).toEqual({ kind: "space" });
		expect(decodeSkillsKey("\r")).toEqual({ kind: "enter" });
		expect(decodeSkillsKey("q")).toEqual({ kind: "text", text: "q" });
	});
});
