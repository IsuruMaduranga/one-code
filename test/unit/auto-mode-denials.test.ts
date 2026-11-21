import { describe, expect, it } from "vitest";
import { DenialStore, MAX_DENIALS, denialInputKey, permissionGrantedMessage, sandboxAskSuffix } from "../../extensions/safety/permissions/auto-mode/denials.ts";
import { autoModeResultText } from "../../extensions/safety/permissions/auto-mode/text.ts";

const denial = (inputKey: string, display = inputKey) => ({
	toolName: "bash",
	display,
	fullDisplay: display,
	inputKey,
	reason: "Irreversible Local Destruction",
	rule: "Irreversible Local Destruction",
	timestamp: 1,
});

/** No sandbox runs: nothing is asked of it. */
const NONE = { unsandboxed: false, hosts: [] };

describe("denialInputKey", () => {
	it("keys a shell call by its command and directory only", () => {
		const a = denialInputKey("bash", { command: "rm -rf dist", description: "clean", timeout: 5 }, "/p", true, NONE);
		const b = denialInputKey("bash", { command: "rm -rf dist" }, "/p", true, NONE);
		expect(a).toBe(b);
		expect(denialInputKey("bash", { command: "rm -rf dist" }, "/q", true, NONE)).not.toBe(b);
		expect(denialInputKey("bash", { command: "rm -rf dist " }, "/p", true, NONE)).not.toBe(b);
	});

	it("keys any other tool by its whole input, whatever the key order", () => {
		const a = denialInputKey("write", { path: "a", content: "x" }, "/p", false, NONE);
		expect(denialInputKey("write", { content: "x", path: "a" }, "/p", false, NONE)).toBe(a);
		expect(denialInputKey("write", { content: "y", path: "a" }, "/p", false, NONE)).not.toBe(a);
		expect(denialInputKey("edit", { path: "a", content: "x" }, "/p", false, NONE)).not.toBe(a);
		expect(denialInputKey("mcp__s__t", { q: { b: 1, a: [2, { d: 3, c: 4 }] } }, "/p", false, NONE)).toBe(
			denialInputKey("mcp__s__t", { q: { a: [2, { c: 4, d: 3 }], b: 1 } }, "/p", false, NONE),
		);
	});

	it("counts what the call asks of the sandbox from the gate's facts, not the input's own fields", () => {
		const input = { command: "curl https://a.example", allowed_domains: ["a.example"], dangerouslyDisableSandbox: true };
		// No sandbox runs: the fields ask nothing of it, so the call is the plain command.
		expect(denialInputKey("bash", input, "/p", true, NONE)).toBe(denialInputKey("bash", { command: input.command }, "/p", true, NONE));
		// A sandbox runs: leaving it, or being granted hosts, is another action.
		const plain = denialInputKey("bash", input, "/p", true, NONE);
		expect(denialInputKey("bash", input, "/p", true, { unsandboxed: true, hosts: [] })).not.toBe(plain);
		expect(denialInputKey("bash", input, "/p", true, { unsandboxed: false, hosts: ["a.example"] })).not.toBe(plain);
		// A non-shell tool that takes hosts (monitor) counts its whole input and the hosts it would be granted.
		const monitor = { command: "tail -f log", description: "d", allowed_domains: ["a.example"] };
		expect(denialInputKey("monitor", monitor, "/p", false, { unsandboxed: false, hosts: ["a.example"] })).not.toBe(denialInputKey("monitor", monitor, "/p", false, NONE));
	});

	it("shows the same facts the key holds", () => {
		expect(sandboxAskSuffix(NONE)).toBe("");
		expect(sandboxAskSuffix({ unsandboxed: true, hosts: [] })).toBe(" (unsandboxed)");
		expect(sandboxAskSuffix({ unsandboxed: false, hosts: ["a.example", "b.example"] })).toBe(" [hosts: a.example, b.example]");
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
	it("passes every granted display to the profile's wording", () => {
		const { permissionGranted } = autoModeResultText;
		expect(permissionGrantedMessage(["bash(rm -rf dist)"])).toBe(permissionGranted({ displays: ["bash(rm -rf dist)"] }));
		expect(permissionGrantedMessage(["a", "b"])).toBe(permissionGranted({ displays: ["a", "b"] }));
	});
});
