import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// A fake CLI records how each probe phase launched it and writes no provider
// evidence, so every probe fails; only the launch arguments are checked.
const fakePi = `
import { appendFileSync } from 'node:fs';
if (process.argv.includes('--version')) { console.log('offline-probe-cli'); }
else { appendFileSync(process.env.PROBE_INVOCATIONS, JSON.stringify(process.argv.slice(2))+'\\n'); }
`;

/** The matrix's OpenRouter leg alone against the fake CLI: every pi launch's arguments. */
function launches(env: Record<string, string>): string[][] {
	const root = mkdtempSync(join(tmpdir(), "cache-probe-matrix-"));
	try {
		const cli = join(root, "fake-pi.mjs");
		const invocations = join(root, "invocations.jsonl");
		writeFileSync(cli, fakePi);
		const result = spawnSync("bash", [resolve("test/e2e/cache-probe-matrix.sh")], {
			encoding: "utf8",
			timeout: 30_000,
			env: { ...process.env, ...env, PI_BIN: cli, TMPDIR: root, PROBE_INVOCATIONS: invocations, CACHE_PROBE_ONLY: "openrouter/deepseek" },
		});
		expect(result.error).toBeUndefined();
		expect(result.stdout).toContain("FAIL  openrouter/deepseek/deepseek-v4.1-flash");
		// No other leg ran.
		expect(result.stdout).not.toContain("=== anthropic/");
		return readFileSync(invocations, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

describe("cache-probe matrix extension loading (offline CLI)", () => {
	it("loads only this checkout's extensions in every phase by default", () => {
		const calls = launches({});
		// Session, classifier and review phases, then the reader phase.
		expect(calls.length).toBeGreaterThanOrEqual(4);
		for (const args of calls) {
			expect(args).toContain("--no-extensions");
			expect(args[args.indexOf("-e") + 1]).toBe(resolve("."));
		}
	});

	it("loads what pi's settings register with CACHE_PROBE_REGISTERED=1, except the reader phase, which never did", () => {
		const calls = launches({ CACHE_PROBE_REGISTERED: "1" });
		const probePhases = calls.slice(0, -1);
		expect(probePhases.length).toBeGreaterThanOrEqual(3);
		for (const args of probePhases) expect(args).not.toContain("--no-extensions");
		expect(calls.at(-1)).toContain("--no-extensions");
	});
});
