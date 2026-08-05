import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findSessionFile, nextRunName, RunRegistry } from "../../extensions/subagents/runs.ts";

describe("nextRunName", () => {
	it("allocates the lowest free <agent>-<n>", () => {
		expect(nextRunName([], "explore")).toBe("explore-1");
		expect(nextRunName(["explore-1", "explore-2"], "explore")).toBe("explore-3");
		expect(nextRunName(["explore-2"], "explore")).toBe("explore-1");
	});
});

describe("RunRegistry", () => {
	const record = (name: string, taskId: string) => ({ name, agent: "explore", taskId, sessionSearchDir: "", cwd: "/x" });

	it("resolves by name, id, and unique id prefix; latest wins per name", () => {
		const registry = new RunRegistry();
		registry.add(record("explore-1", "b1111111"));
		registry.add(record("explore-1", "b2222222"));
		expect(registry.resolve("explore-1")?.taskId).toBe("b2222222");
		expect(registry.resolve("b1111111")?.name).toBe("explore-1");
		expect(registry.resolve("b222")?.taskId).toBe("b2222222");
		expect(registry.resolve("missing")).toBeUndefined();
	});
});

describe("findSessionFile", () => {
	let dir: string;
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("finds the newest .jsonl recursively", () => {
		dir = mkdtempSync(join(tmpdir(), "cc-runs-test-"));
		const nested = join(dir, "encoded-cwd");
		mkdirSync(nested, { recursive: true });
		const older = join(nested, "old.jsonl");
		const newer = join(nested, "new.jsonl");
		writeFileSync(older, "{}");
		writeFileSync(newer, "{}");
		const past = new Date(Date.now() - 60_000);
		utimesSync(older, past, past);
		writeFileSync(join(nested, "not-a-session.txt"), "x");
		expect(findSessionFile(dir)).toBe(newer);
	});

	it("returns undefined for missing or empty dirs", () => {
		dir = mkdtempSync(join(tmpdir(), "cc-runs-test-"));
		expect(findSessionFile(dir)).toBeUndefined();
		expect(findSessionFile(join(dir, "nope"))).toBeUndefined();
	});
});
