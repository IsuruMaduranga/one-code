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

/**
 * The test process's environment without the probe's own controls (every
 * CACHE_PROBE_* variable: model overrides, leg selection, registered mode,
 * login settings), so a person's exported probe settings never reach the
 * script; each test sets the ones it means to. Everything else (PATH) stays.
 */
function inheritedEnv(): NodeJS.ProcessEnv {
	return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("CACHE_PROBE_")));
}

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
			env: { ...inheritedEnv(), ...env, PI_BIN: cli, TMPDIR: root, PROBE_INVOCATIONS: invocations, CACHE_PROBE_ONLY: "openrouter/deepseek" },
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
			// Git Bash hands a native program its POSIX paths converted to the
			// forward-slashed Windows form (`D:/a/x`); pi resolves an `-e` path
			// with path.resolve, which reads that form and the native one alike.
			expect(resolve(args[args.indexOf("-e") + 1])).toBe(resolve("."));
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

describe("cache-probe matrix login leg (offline CLI)", () => {
	it("runs the late-tool phase on the login, requires tool_addition, and records its credentials", () => {
		const root = mkdtempSync(join(tmpdir(), "cache-probe-login-"));
		try {
			const cli = join(root, "fake-pi.mjs");
			const invocations = join(root, "invocations.jsonl");
			writeFileSync(cli, fakePi);
			const agentDir = join(root, "agent");
			spawnSync("mkdir", ["-p", agentDir]);
			writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "oauth", refresh: "r", access: "a", expires: 0 } }));
			const result = spawnSync("bash", [resolve("test/e2e/cache-probe-matrix.sh")], {
				encoding: "utf8",
				timeout: 30_000,
				env: { ...inheritedEnv(), PI_BIN: cli, TMPDIR: root, PROBE_INVOCATIONS: invocations, CACHE_PROBE_ONLY: "login", CACHE_PROBE_LOGIN_AGENT_DIR: agentDir },
			});
			expect(result.error).toBeUndefined();
			expect(result.stdout).toContain("--- late-tool phase");
			expect(result.stdout).toContain("--- credential and model check (session, auto-mode, fork and late-tool phases)");
			const calls = readFileSync(invocations, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
			const late = calls.find((args) => args.some((arg) => arg.endsWith("late-tool-fixture.ts")));
			expect(late).toBeDefined();
			expect(late).toContain("--no-extensions");
			expect(late).toContain("anthropic/claude-haiku-5-5");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("cache-probe credential check (offline CLI)", () => {
	it("checks only the credential on a run that does not pin its side models", () => {
		const root = mkdtempSync(join(tmpdir(), "cache-probe-key-"));
		try {
			const cli = join(root, "fake-pi.mjs");
			writeFileSync(cli, fakePi);
			const result = spawnSync("bash", [resolve("test/e2e/cache-probe.sh"), "anthropic/claude-sonnet-5", "--expect-auth", "key", "--no-classifier", "--no-review", "--no-reader", "--no-late-tool"], {
				encoding: "utf8",
				timeout: 30_000,
				env: { ...inheritedEnv(), PI_BIN: cli, TMPDIR: root, PROBE_INVOCATIONS: join(root, "invocations.jsonl") },
			});
			expect(result.error).toBeUndefined();
			expect(result.stdout).toContain("--- credential check (session, auto-mode, fork and late-tool phases)");
			expect(result.stdout).not.toContain("model check");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses the one-model check without the credential record it reads", () => {
		const result = spawnSync("bash", [resolve("test/e2e/cache-probe.sh"), "anthropic/claude-sonnet-5", "--expect-one-model"], { encoding: "utf8", timeout: 30_000 });
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("--expect-one-model");
	});
});
