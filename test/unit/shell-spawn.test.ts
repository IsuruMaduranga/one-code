/**
 * lib/shell-spawn.ts — the resolvers with injected platform/env/fs, and the
 * PowerShell operations against a REAL pwsh when one is on this machine (PATH,
 * or the cc-windows-mode skill's portable copy); the repo never mocks
 * child_process. Skipped cleanly where no pwsh exists.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createPowerShellOperations,
	findPwshOnPath,
	gitBashOverride,
	isBashBinaryName,
	POWERSHELL_ARGS,
	powerShellEdition,
	resolveBashSpawn,
	resolvePowerShellSpawn,
	type ShellSpawn,
	spawnShellCommand,
} from "../../extensions/lib/shell-spawn.ts";

const gitBash: ShellSpawn = { shell: "C:\\Program Files\\Git\\bin\\bash.exe", args: ["-c"] };

describe("isBashBinaryName", () => {
	it("accepts bash/sh with or without .exe, any case, either separator", () => {
		for (const p of ["/bin/bash", "/bin/sh", "C:\\Git\\bin\\bash.exe", "D:/tools/SH.EXE", "bash"]) expect(isBashBinaryName(p)).toBe(true);
	});
	it("rejects anything else (CC 2.1.219 ignores a non-bash CLAUDE_CODE_GIT_BASH_PATH)", () => {
		for (const p of ["C:\\Windows\\System32\\cmd.exe", "/usr/bin/zsh", "pwsh", "C:\\Git\\bin\\bashful.exe"]) expect(isBashBinaryName(p)).toBe(false);
	});
});

describe("gitBashOverride", () => {
	it("prefers the process environment over the settings env block", () => {
		expect(gitBashOverride({ CLAUDE_CODE_GIT_BASH_PATH: "C:\\a\\bash.exe" }, { CLAUDE_CODE_GIT_BASH_PATH: "C:\\b\\bash.exe" })).toEqual({
			path: "C:\\a\\bash.exe",
			source: "env",
		});
		expect(gitBashOverride({}, { CLAUDE_CODE_GIT_BASH_PATH: "C:\\b\\bash.exe" })).toEqual({ path: "C:\\b\\bash.exe", source: "settings" });
		expect(gitBashOverride({ CLAUDE_CODE_GIT_BASH_PATH: "  " }, {})).toBeUndefined();
	});
});

describe("resolveBashSpawn", () => {
	it("uses a valid override through pi's resolver", () => {
		const seen: Array<string | undefined> = [];
		const result = resolveBashSpawn({
			env: { CLAUDE_CODE_GIT_BASH_PATH: "C:\\Git\\bin\\bash.exe" },
			exists: () => true,
			fallback: (custom) => {
				seen.push(custom);
				return { shell: custom ?? "/bin/bash", args: ["-c"] };
			},
		});
		expect(seen).toEqual(["C:\\Git\\bin\\bash.exe"]);
		expect(result.spawn?.shell).toBe("C:\\Git\\bin\\bash.exe");
		expect(result.warning).toBeUndefined();
	});

	it("ignores a non-bash override with a warning and falls back", () => {
		const result = resolveBashSpawn({
			env: { CLAUDE_CODE_GIT_BASH_PATH: "C:\\Windows\\System32\\cmd.exe" },
			exists: () => true,
			fallback: (custom) => {
				expect(custom).toBeUndefined();
				return gitBash;
			},
		});
		expect(result.spawn).toEqual(gitBash);
		expect(result.warning).toMatch(/not a bash or sh binary/);
	});

	it("ignores a missing override with a warning", () => {
		const result = resolveBashSpawn({
			env: {},
			settingsEnv: { CLAUDE_CODE_GIT_BASH_PATH: "C:\\nope\\bash.exe" },
			exists: () => false,
			fallback: () => gitBash,
		});
		expect(result.spawn).toEqual(gitBash);
		expect(result.warning).toMatch(/settings\.json env.*does not exist/);
	});

	it("reports pi's error when no bash exists (Windows without Git for Windows)", () => {
		const result = resolveBashSpawn({
			env: {},
			fallback: () => {
				throw new Error("No bash shell found. Options:\n  1. Install Git for Windows");
			},
		});
		expect(result.spawn).toBeUndefined();
		expect(result.error).toMatch(/Install Git for Windows/);
	});
});

describe("resolvePowerShellSpawn", () => {
	it("on Windows uses pi's resolver and swallows its throw", () => {
		expect(resolvePowerShellSpawn({ platform: "win32", windowsFallback: () => ({ shell: "C:\\pwsh.exe", args: [...POWERSHELL_ARGS] }) })).toEqual({
			shell: "C:\\pwsh.exe",
			args: [...POWERSHELL_ARGS],
		});
		expect(
			resolvePowerShellSpawn({
				platform: "win32",
				windowsFallback: () => {
					throw new Error("No PowerShell executable found.");
				},
			}),
		).toBeUndefined();
	});

	it("elsewhere finds pwsh on PATH with pi's argument list", () => {
		const env = { PATH: "/usr/bin:/opt/pwsh" };
		const exists = (p: string) => p === "/opt/pwsh/pwsh";
		expect(findPwshOnPath(env, exists)).toBe("/opt/pwsh/pwsh");
		expect(resolvePowerShellSpawn({ platform: "darwin", env, exists })).toEqual({
			shell: "/opt/pwsh/pwsh",
			args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"],
		});
		expect(resolvePowerShellSpawn({ platform: "linux", env, exists: () => false })).toBeUndefined();
	});

	it("honours a lowercase `Path` key (Windows spelling)", () => {
		expect(findPwshOnPath({ Path: "/x" }, (p) => p === "/x/pwsh")).toBe("/x/pwsh");
	});
});

describe("powerShellEdition", () => {
	it("reads the edition off the executable name", () => {
		expect(powerShellEdition({ shell: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", args: [] })).toBe("core");
		expect(powerShellEdition({ shell: "/opt/pwsh/pwsh", args: [] })).toBe("core");
		expect(powerShellEdition({ shell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", args: [] })).toBe("desktop");
		expect(powerShellEdition(undefined)).toBe("unknown");
	});
});

describe("spawnShellCommand", () => {
	it("appends the command for argv transport and feeds stdin for the legacy-WSL form", async () => {
		const sh: ShellSpawn = { shell: "/bin/sh", args: ["-c"] };
		const out = await collect(spawnShellCommand(sh, "echo argv-ok", { stdio: ["ignore", "pipe", "pipe"] }));
		expect(out.trim()).toBe("argv-ok");
		const viaStdin: ShellSpawn = { shell: "/bin/sh", args: ["-s"], commandTransport: "stdin" };
		const out2 = await collect(spawnShellCommand(viaStdin, "echo stdin-ok", { stdio: ["ignore", "pipe", "pipe"] }));
		expect(out2.trim()).toBe("stdin-ok");
	});
});

/** A pwsh to test against: PATH, else the cc-windows-mode skill's portable copy. */
function localPwsh(): ShellSpawn | undefined {
	const onPath = resolvePowerShellSpawn();
	if (onPath) return onPath;
	const portable = join(homedir(), ".cache", "cc-windows-mode", "pwsh", "pwsh");
	return existsSync(portable) ? { shell: portable, args: [...POWERSHELL_ARGS] } : undefined;
}

const pwsh = localPwsh();

describe.skipIf(!pwsh)("createPowerShellOperations (real pwsh)", () => {
	const ops = createPowerShellOperations(() => pwsh);
	const run = async (command: string, extra: { signal?: AbortSignal; timeout?: number } = {}) => {
		let output = "";
		const result = await ops.exec(command, process.cwd(), { onData: (d) => (output += d.toString()), ...extra });
		return { ...result, output };
	};

	it("runs a command, streams its output, and reports the exit code", async () => {
		const { exitCode, output } = await run("Write-Output 'hello from pwsh'; Write-Output $PSVersionTable.PSEdition");
		expect(exitCode).toBe(0);
		expect(output).toContain("hello from pwsh");
		expect(output).toContain("Core");
	});

	it("passes a non-zero exit code through", async () => {
		const { exitCode } = await run("exit 3");
		expect(exitCode).toBe(3);
	});

	it("times out with pi's error string and kills the process", async () => {
		const started = Date.now();
		await expect(run("Start-Sleep -Seconds 30", { timeout: 1 })).rejects.toThrow("timeout:1");
		expect(Date.now() - started).toBeLessThan(10_000);
	});

	it("aborts with pi's error string", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 200);
		await expect(run("Start-Sleep -Seconds 30", { signal: controller.signal })).rejects.toThrow("aborted");
	});

	it("refuses a missing working directory with pi's message", async () => {
		await expect(ops.exec("Write-Output x", "/definitely/not/here", { onData: () => {} })).rejects.toThrow(/Working directory does not exist/);
	});

	it("emits UTF-8 (the prefix pi prepends)", async () => {
		const { output } = await run("Write-Output 'héllo — ✓'");
		expect(output).toContain("héllo — ✓");
	});
});

function collect(child: ReturnType<typeof spawnShellCommand>): Promise<string> {
	return new Promise((resolve, reject) => {
		let out = "";
		child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
		child.on("error", reject);
		child.on("close", () => resolve(out));
	});
}
