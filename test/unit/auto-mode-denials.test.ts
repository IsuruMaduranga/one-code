import { describe, expect, it } from "vitest";
import { DenialStore, MAX_DENIALS, denialInputKey, permissionGrantedMessage } from "../../extensions/auto-mode/denials.ts";

const denial = (inputKey: string, display = inputKey) => ({
	toolName: "bash",
	display,
	inputKey,
	reason: "Irreversible Local Destruction",
	rule: "Irreversible Local Destruction",
	timestamp: 1,
});

describe("denialInputKey", () => {
	it("keys a shell call by its command and directory only", () => {
		const a = denialInputKey("bash", { command: "rm -rf dist", description: "clean", timeout: 5 }, "/p", true);
		const b = denialInputKey("bash", { command: "rm -rf dist" }, "/p", true);
		expect(a).toBe(b);
		expect(denialInputKey("bash", { command: "rm -rf dist" }, "/q", true)).not.toBe(b);
		expect(denialInputKey("bash", { command: "rm -rf dist " }, "/p", true)).not.toBe(b);
	});

	it("keys any other tool by its whole input, whatever the key order", () => {
		const a = denialInputKey("write", { path: "a", content: "x" }, "/p", false);
		expect(denialInputKey("write", { content: "x", path: "a" }, "/p", false)).toBe(a);
		expect(denialInputKey("write", { content: "y", path: "a" }, "/p", false)).not.toBe(a);
		expect(denialInputKey("edit", { path: "a", content: "x" }, "/p", false)).not.toBe(a);
		expect(denialInputKey("mcp__s__t", { q: { b: 1, a: [2, { d: 3, c: 4 }] } }, "/p", false)).toBe(
			denialInputKey("mcp__s__t", { q: { a: [2, { c: 4, d: 3 }], b: 1 } }, "/p", false),
		);
	});
});

describe("DenialStore", () => {
	it("lists newest first and keeps Claude Code's 20", () => {
		const store = new DenialStore();
		for (let i = 0; i < MAX_DENIALS + 5; i++) store.record(denial(`k${i}`));
		expect(store.list()).toHaveLength(MAX_DENIALS);
		expect(store.list()[0].inputKey).toBe(`k${MAX_DENIALS + 4}`);
		expect(new Set(store.list().map((d) => d.id)).size).toBe(MAX_DENIALS);
	});

	it("mints one grant per approval, spent by the exact call", () => {
		const store = new DenialStore();
		const first = store.record(denial("k1"));
		store.record(denial("k2"));
		expect(store.takeGrant("k1")).toBe(false);
		expect(store.approve(new Set([first.id, 999])).map((d) => d.inputKey)).toEqual(["k1"]);
		expect(store.list().map((d) => d.inputKey)).toEqual(["k2"]);
		expect(store.takeGrant("k2")).toBe(false);
		expect(store.takeGrant("k1")).toBe(true);
		// One run per approval: the same call again is judged as usual.
		expect(store.takeGrant("k1")).toBe(false);
	});

	it("keeps a grant for each approved denial of the same call", () => {
		const store = new DenialStore();
		const ids = [store.record(denial("k1")).id, store.record(denial("k1")).id];
		store.approve(new Set(ids));
		expect(store.takeGrant("k1")).toBe(true);
		expect(store.takeGrant("k1")).toBe(true);
		expect(store.takeGrant("k1")).toBe(false);
	});

	it("drops a denial when the same call later goes through", () => {
		const store = new DenialStore();
		store.record(denial("k1"));
		store.record(denial("k2"));
		store.record(denial("k1"));
		store.settle("k1");
		expect(store.list().map((d) => d.inputKey)).toEqual(["k2"]);
	});

	it("starts a new session empty, grants included", () => {
		const store = new DenialStore();
		store.approve(new Set([store.record(denial("k1")).id]));
		store.record(denial("k2"));
		store.reset();
		expect(store.list()).toEqual([]);
		expect(store.takeGrant("k1")).toBe(false);
	});
});

describe("permissionGrantedMessage", () => {
	it("uses Claude Code's wording", () => {
		expect(permissionGrantedMessage(["bash(rm -rf dist)"])).toBe(
			"Permission granted for: bash(rm -rf dist). You may now retry this command if you would like.",
		);
		expect(permissionGrantedMessage(["a", "b"])).toBe("Permission granted for: a, b. You may now retry these commands if you would like.");
	});
});
