/**
 * Distribution review 2026-09-09, L2: `runtimeProtectedDirs()` gained
 * `claudeConfigDir()` and `productStateDir()` beside pi's agent dir, so a
 * relocated `CLAUDE_CONFIG_DIR` / `ONECODE_STATE_DIR` (which the static segment
 * list in protected-paths.ts cannot catch) is still protected against writes.
 * This asserts the roots are present and honour the env relocation — the
 * safety-floor path has its own tests; this covers the decide()/protected-path
 * side.
 */
import { afterEach, describe, expect, it } from "vitest";
import { claudeConfigDir, productStateDir } from "../../extensions/lib/paths.ts";
import { runtimeProtectedDirs } from "../../extensions/lib/permission-gate.ts";
import { envName } from "../../extensions/lib/brand.mjs";

const savedClaude = process.env.CLAUDE_CONFIG_DIR;
const savedState = process.env[envName("STATE_DIR")];
afterEach(() => {
	if (savedClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
	else process.env.CLAUDE_CONFIG_DIR = savedClaude;
	if (savedState === undefined) delete process.env[envName("STATE_DIR")];
	else process.env[envName("STATE_DIR")] = savedState;
});

describe("runtimeProtectedDirs", () => {
	it("includes Claude Code's config dir and One Code's state dir", () => {
		delete process.env.CLAUDE_CONFIG_DIR;
		delete process.env[envName("STATE_DIR")];
		const dirs = runtimeProtectedDirs();
		expect(dirs).toContain(claudeConfigDir());
		expect(dirs).toContain(productStateDir());
	});

	it("follows a relocated CLAUDE_CONFIG_DIR / ONECODE_STATE_DIR", () => {
		process.env.CLAUDE_CONFIG_DIR = "/tmp/relocated-cc-config";
		process.env[envName("STATE_DIR")] = "/tmp/relocated-onecode-state";
		const dirs = runtimeProtectedDirs();
		expect(dirs).toContain("/tmp/relocated-cc-config");
		expect(dirs).toContain("/tmp/relocated-onecode-state");
	});
});
