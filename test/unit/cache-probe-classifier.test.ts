import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** One classifier log row on OpenAI Responses, with history breakpoints when `marks` > 0. */
const row = (history: string, read: number, marks: number) => {
	const system = "ruleset";
	const user = `<transcript>${history}</transcript>\nstage instruction`;
	return {
		api: "openai-responses",
		model: "openai/gpt-probe",
		stopReason: "stop",
		system,
		user,
		usage: { input: 10_000 - read, output: 5, cacheRead: read, cacheWrite: 0 },
		cacheBreakpoints: true,
		cacheEdited: marks > 0,
		cacheMarks: marks,
		systemChars: system.length,
		historyChars: `<transcript>${history}`.length,
	};
};

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "probe-classifier-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const probe = (rows: unknown[]) => {
	const file = join(dir, "classifier.jsonl");
	writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
	const result = spawnSync(process.execPath, [resolve("test/e2e/cache-probe-classifier.mjs"), file], { encoding: "utf8" });
	return { status: result.status, out: result.stdout };
};

describe("cache-probe-classifier on history breakpoints", () => {
	const first = "x".repeat(4000);
	const second = `${first}${"y".repeat(400)}`;

	it("fails a marked request that misses the marked history before it", () => {
		const { status, out } = probe([row(first, 0, 2), row(second, 0, 2)]);
		expect(status).toBe(1);
		expect(out).toContain("FAIL  classifier call 2 read 0 cached tokens");
	});

	it("checks a request its own hook left unmarked as an implicit cache, with a WARN", () => {
		const { status, out } = probe([row(first, 0, 2), row(second, 0, 0)]);
		expect(out).not.toContain("FAIL");
		expect(out).toContain("WARN  classifier call 2 had the cache hook but it left this request unmarked");
		expect(out).toContain("WARN  classifier call 2 read 0 cached tokens");
		expect(status).toBe(0);
	});

	it("checks an unmarked request after a marked one on another model under the implicit rule, with a WARN", () => {
		// The classifier moved to a model whose payload has no hook: nothing skipped, nothing marked.
		const unhooked = { ...row(second, 0, 0), model: "openai/gpt-older", cacheBreakpoints: false };
		const { status, out } = probe([row(first, 0, 2), unhooked]);
		expect(out).not.toContain("FAIL");
		expect(out).toContain("WARN  classifier call 2 read 0 cached tokens");
		expect(status).toBe(0);
	});

	it("holds a request past the mark cap to the marked history only, not the unmarked tail", () => {
		// The first 4,000 characters are the marked parts; the 4,000 after them pass the cap and stay unmarked.
		const marked = "x".repeat(4000);
		const capped = (history: string, read: number) => ({ ...row(history, read, 1000), markedHistoryChars: `<transcript>${marked}`.length });
		const long = `${marked}${"y".repeat(4000)}`;
		const { status, out } = probe([capped(long, 0), capped(`${long}z`, 6000)]);
		expect(out).not.toContain("FAIL");
		expect(status).toBe(0);
	});

	it("checks a log without the cache-hook fields under the implicit rule", () => {
		const older = (history: string) => {
			const { cacheBreakpoints: _b, cacheEdited: _e, cacheMarks: _m, systemChars: _s, historyChars: _h, ...rest } = row(history, 0, 2);
			return rest;
		};
		const { status, out } = probe([older(first), older(second)]);
		expect(out).toContain("(implicit cache)");
		expect(out).toContain("WARN  classifier call 2 read 0 cached tokens");
		expect(status).toBe(0);
	});
});
