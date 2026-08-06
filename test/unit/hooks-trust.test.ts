import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HooksSource } from "../../extensions/hooks/settings.ts";
import {
	describeProjectHooks,
	hashProjectHooks,
	persistApproval,
	projectHooksApproved,
	readStoredApproval,
	resetTrustSessionState,
} from "../../extensions/hooks/trust.ts";

const source = (command: string, scope: "project" | "local" = "project"): HooksSource => ({
	scope,
	path: `/p/.claude/settings.json`,
	config: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }] },
});

describe("hashProjectHooks", () => {
	it("is stable under object key order", () => {
		const a: HooksSource = {
			scope: "project",
			path: "/p",
			config: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "x" }] }] },
		};
		// Same content, different key insertion order.
		const b: HooksSource = {
			scope: "project",
			path: "/p",
			config: JSON.parse('{"PreToolUse":[{"hooks":[{"command":"x","type":"command"}],"matcher":"Bash"}]}'),
		};
		expect(hashProjectHooks([a])).toBe(hashProjectHooks([b]));
	});

	it("changes when a command changes", () => {
		expect(hashProjectHooks([source("a")])).not.toBe(hashProjectHooks([source("b")]));
	});
});

describe("projectHooksApproved", () => {
	let dir: string;
	let storePath: string;

	beforeEach(() => {
		resetTrustSessionState();
		dir = mkdtempSync(join(tmpdir(), "cc-hooks-trust-"));
		storePath = join(dir, "approvals.json");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const deps = (overrides: Partial<Parameters<typeof projectHooksApproved>[2]>) => ({
		hasUI: true,
		confirm: async () => true,
		notify: () => {},
		storePath,
		...overrides,
	});

	it("approves, persists, and never re-prompts for the same config", async () => {
		let prompts = 0;
		const d = deps({
			confirm: async () => {
				prompts += 1;
				return true;
			},
		});
		expect(await projectHooksApproved("/proj", [source("x")], d)).toBe(true);
		expect(prompts).toBe(1);
		expect(readStoredApproval("/proj", storePath)).toBe(hashProjectHooks([source("x")]));
		// Fresh session state, stored approval carries it.
		resetTrustSessionState();
		expect(await projectHooksApproved("/proj", [source("x")], d)).toBe(true);
		expect(prompts).toBe(1);
		expect(readFileSync(storePath, "utf-8")).toContain('"version": 1');
	});

	it("re-prompts when the hook config changes", async () => {
		let prompts = 0;
		const d = deps({
			confirm: async () => {
				prompts += 1;
				return true;
			},
		});
		await projectHooksApproved("/proj", [source("x")], d);
		await projectHooksApproved("/proj", [source("changed")], d);
		expect(prompts).toBe(2);
	});

	it("a decline sticks for the session but is not persisted", async () => {
		let prompts = 0;
		const d = deps({
			confirm: async () => {
				prompts += 1;
				return false;
			},
		});
		expect(await projectHooksApproved("/proj", [source("x")], d)).toBe(false);
		expect(await projectHooksApproved("/proj", [source("x")], d)).toBe(false);
		expect(prompts).toBe(1);
		expect(readStoredApproval("/proj", storePath)).toBeUndefined();
	});

	it("headless without stored approval skips with a notice", async () => {
		const notices: string[] = [];
		const d = deps({ hasUI: false, notify: (m: string) => notices.push(m) });
		expect(await projectHooksApproved("/proj", [source("x")], d)).toBe(false);
		expect(notices[0]).toContain("skipped");
		// But a prior stored approval works headless.
		persistApproval("/proj2", hashProjectHooks([source("x")]), storePath);
		expect(await projectHooksApproved("/proj2", [source("x")], d)).toBe(true);
	});

	it("concurrent dispatches share one prompt", async () => {
		let prompts = 0;
		const d = deps({
			confirm: async () => {
				prompts += 1;
				await new Promise((r) => setTimeout(r, 20));
				return true;
			},
		});
		const [a, b] = await Promise.all([
			projectHooksApproved("/proj", [source("x")], d),
			projectHooksApproved("/proj", [source("x")], d),
		]);
		expect(a).toBe(true);
		expect(b).toBe(true);
		expect(prompts).toBe(1);
	});

	it("no project sources means no prompt at all", async () => {
		let prompts = 0;
		const d = deps({
			confirm: async () => {
				prompts += 1;
				return true;
			},
		});
		expect(await projectHooksApproved("/proj", [], d)).toBe(true);
		expect(prompts).toBe(0);
	});
});

describe("describeProjectHooks", () => {
	it("lists commands, truncating long ones and long lists", () => {
		const sources = Array.from({ length: 7 }, (_, i) => source(`command-${i} ${"y".repeat(100)}`));
		const text = describeProjectHooks(sources);
		expect(text).toContain("7 command hook(s)");
		expect(text).toContain("… and 2 more");
		expect(text).not.toContain("y".repeat(90));
	});
});
