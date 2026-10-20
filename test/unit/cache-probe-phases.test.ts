import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// A fake CLI writes no provider evidence. Both checks must fail, but the
// driver must still run the reader phase unless it was explicitly disabled.
const fakePi = `
import { appendFileSync } from 'node:fs';
if (process.argv.includes('--version')) { console.log('offline-probe-cli'); }
else { appendFileSync(process.env.PROBE_INVOCATIONS, JSON.stringify({args:process.argv.slice(2),log:process.env.CC_SIDE_CALL_LOG})+'\\n'); }
`;

describe("cache-probe reader phase wiring (offline CLI)", () => {
	it.each([true, false])("runs reader by default, opt-out=%s", (skip) => {
		const root = mkdtempSync(join(tmpdir(), "cache-probe-phases-"));
		try {
			const cli = join(root, "fake-pi.mjs");
			const invocations = join(root, "invocations.jsonl");
			writeFileSync(cli, fakePi);
			const result = spawnSync("bash", [resolve("test/e2e/cache-probe.sh"), "anthropic/claude-sonnet-5", "--no-classifier", "--no-late-tool", ...(skip ? ["--no-reader"] : [])], {
				encoding: "utf8", timeout: 20_000,
				env: { ...process.env, PI_BIN: cli, CACHE_PROBE_WORK_DIR: join(root, "probe"), PROBE_INVOCATIONS: invocations },
			});
			expect(result.error).toBeUndefined();
			expect(result.status).toBe(1);
			const calls = readFileSync(invocations, "utf8").trim().split("\n").map((line) => JSON.parse(line));
			expect(calls).toHaveLength(skip ? 1 : 2);
			if (skip) expect(result.stdout).not.toContain("--- reader phase");
			else {
				expect(result.stdout).toContain("--- reader phase");
				// The driver joins with "/", which Windows reads as a separator too.
				expect(resolve(calls[1].log)).toBe(join(root, "probe", "reader", "reader.jsonl"));
				expect(calls[1].args).toContain("anthropic/claude-sonnet-5");
				expect(result.stdout).toContain("expected exactly 2 completed reader attempts, found 0");
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("cache-probe late-tool phase wiring (offline CLI)", () => {
	it.each([
		{ model: "anthropic/claude-sonnet-5", flags: [], runs: true },
		{ model: "anthropic/claude-sonnet-5", flags: ["--no-late-tool"], runs: false },
		{ model: "openai/gpt-6.1-sol", flags: [], runs: false },
	])("$model $flags runs the late-tool phase: $runs", ({ model, flags, runs }) => {
		const root = mkdtempSync(join(tmpdir(), "cache-probe-phases-"));
		try {
			const cli = join(root, "fake-pi.mjs");
			const invocations = join(root, "invocations.jsonl");
			writeFileSync(cli, fakePi);
			const result = spawnSync("bash", [resolve("test/e2e/cache-probe.sh"), model, "--no-classifier", "--no-reader", ...flags], {
				encoding: "utf8", timeout: 20_000,
				env: { ...process.env, PI_BIN: cli, CACHE_PROBE_WORK_DIR: join(root, "probe"), PROBE_INVOCATIONS: invocations },
			});
			expect(result.error).toBeUndefined();
			expect(result.status).toBe(1);
			const calls = readFileSync(invocations, "utf8").trim().split("\n").map((line) => JSON.parse(line));
			expect(calls).toHaveLength(runs ? 2 : 1);
			expect(result.stdout.includes("--- late-tool phase")).toBe(runs);
			if (runs) {
				// The driver spells the repo path in its shell's form (`/d/a/…` in Git Bash).
				expect(calls[1].args.some((arg: string) => arg.replaceAll("\\", "/").endsWith("/test/e2e/late-tool-fixture.ts"))).toBe(true);
				expect(calls[1].args).toContain(model);
				expect(result.stdout).toContain("late_echo never reached a request's tools");
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
