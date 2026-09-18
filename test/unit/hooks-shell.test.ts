/**
 * Claude Code's per-hook `shell` field and `Bash|PowerShell` / `Bash,PowerShell`
 * matchers, plus the executor running a hook under a real pwsh when one is on
 * this machine (PATH or the cc-windows-mode portable copy).
 */
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultHookShell, hookShellSpawn, runHookCommand } from "../../extensions/hooks/executor.ts";
import { matcherApplies, toolMatchCandidates } from "../../extensions/hooks/matcher.ts";
import { parseHooksBlock } from "../../extensions/hooks/settings.ts";
import { resolvePowerShellSpawn } from "../../extensions/lib/shell-spawn.ts";
import { PORTABLE_PWSH_DIR } from "./helpers/local-pwsh.ts";

describe("parseHooksBlock shell field", () => {
	it("keeps bash/powershell and drops anything else with a diagnostic", () => {
		const diagnostics: string[] = [];
		const config = parseHooksBlock(
			{
				PreToolUse: [
					{
						matcher: "Bash|PowerShell",
						hooks: [
							{ type: "command", command: "a", shell: "powershell" },
							{ type: "command", command: "b", shell: "bash" },
							{ type: "command", command: "c" },
							{ type: "command", command: "d", shell: "zsh" },
						],
					},
				],
			},
			"settings.json",
			diagnostics,
		);
		expect(config.PreToolUse?.[0].hooks.map((h) => h.shell)).toEqual(["powershell", "bash", undefined, undefined]);
		expect(diagnostics).toEqual(['settings.json: PreToolUse hook shell "zsh" ignored (use "bash" or "powershell")']);
	});
});

describe("matchers", () => {
	it("PowerShell is a candidate spelling of the powershell tool", () => {
		expect(toolMatchCandidates("powershell")).toContain("PowerShell");
		expect(matcherApplies("Bash|PowerShell", toolMatchCandidates("powershell"))).toBe(true);
		expect(matcherApplies("PowerShell", toolMatchCandidates("bash"))).toBe(false);
	});
	it("accepts the comma-separated form", () => {
		expect(matcherApplies("Bash,PowerShell", toolMatchCandidates("powershell"))).toBe(true);
		expect(matcherApplies("Bash,PowerShell", toolMatchCandidates("bash"))).toBe(true);
		expect(matcherApplies("Edit,Write", toolMatchCandidates("bash"))).toBe(false);
	});
	it("still honours a regex whose comma is a quantifier (code-review fix)", () => {
		expect(matcherApplies("Bash{1,2}", ["Bash"])).toBe(true);
		expect(matcherApplies("(Bash|PowerShell){1,1}", toolMatchCandidates("powershell"))).toBe(true);
	});
});

describe("hook shell resolution", () => {
	it("defaults to bash where one exists (every non-Windows machine)", () => {
		expect(defaultHookShell()).toBe("bash");
		expect(hookShellSpawn(undefined).spec?.args).toEqual(["-c"]);
		expect(hookShellSpawn("bash").spec?.shell).toMatch(/bash|sh/);
	});
	it("names the fix when PowerShell is asked for but absent", () => {
		const result = hookShellSpawn("powershell");
		if (resolvePowerShellSpawn()) expect(result.spec).toBeDefined();
		else expect(result.error).toMatch(/PowerShell/);
	});
});

function localPwshOnPath(): boolean {
	if (resolvePowerShellSpawn()) return true;
	if (!existsSync(join(PORTABLE_PWSH_DIR, "pwsh"))) return false;
	// Put the portable copy on PATH for this process so the executor's resolver finds it.
	process.env.PATH = `${PORTABLE_PWSH_DIR}${delimiter}${process.env.PATH ?? ""}`;
	return !!resolvePowerShellSpawn();
}

describe.skipIf(!localPwshOnPath())("runHookCommand with shell: powershell (real pwsh)", () => {
	it("runs the hook under pwsh, feeds the payload on stdin, and reads the envelope", async () => {
		const result = await runHookCommand(
			`$payload = [Console]::In.ReadToEnd(); $obj = $payload | ConvertFrom-Json; Write-Output ('{"hookSpecificOutput":{"additionalContext":"tool was ' + $obj.tool_name + '"}}')`,
			JSON.stringify({ tool_name: "PowerShell" }),
			{ cwd: process.cwd(), shell: "powershell", timeoutSeconds: 30 },
		);
		expect(result.spawnError).toBeUndefined();
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('"additionalContext":"tool was PowerShell"');
	});

	it("reports a non-zero exit and stderr", async () => {
		const result = await runHookCommand("[Console]::Error.WriteLine('nope'); exit 2", "{}", { cwd: process.cwd(), shell: "powershell", timeoutSeconds: 30 });
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("nope");
	});

	it("kills a hook that overruns its timeout (taskkill on Windows) and says so", async () => {
		const started = Date.now();
		const result = await runHookCommand("Start-Sleep -Seconds 30", "{}", { cwd: process.cwd(), shell: "powershell", timeoutSeconds: 1 });
		expect(result.timedOut, JSON.stringify(result)).toBe(true);
		expect(result.exitCode).toBeNull();
		// pwsh's cold start alone takes seconds on the CI runners; the bound is on the kill, not the start.
		expect(Date.now() - started).toBeLessThan(15_000);
	}, 30_000);
});
