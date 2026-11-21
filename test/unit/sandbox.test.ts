/**
 * The shell sandbox (lib/shell-run/sandbox.ts, sandbox-settings.ts,
 * safety/sandbox/section.ts): which settings a repository may set, which
 * calls run inside it, and how the gate treats a call that asks to leave it.
 * The runtime itself is not started here; the live checks are in
 * working-docs/features/sandbox/.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { decide } from "../../extensions/lib/rules/matcher.ts";
import { type ActiveSandbox, grantCommandHosts, reloadSandboxSettings, requestedHosts, runsSandboxed, sandboxedCommand, sandboxSettings, setSandboxForTest, unsandboxedRequest } from "../../extensions/lib/shell-run/sandbox.ts";
import { commandHosts, isExcludedCommand, mergeSandboxBlock, SANDBOX_OFF, type SandboxSettings, sandboxFilesystem, sandboxRuntimeConfig } from "../../extensions/lib/shell-run/sandbox-settings.ts";
import { registerShellTool } from "../../extensions/lib/shell-run/shell-tool.ts";
import { powerShellBashLine } from "../../extensions/lib/shell-run/shell-spawn.ts";
import { sandboxProbeFailure, usernsRestricted } from "../../extensions/lib/shell-run/sandbox-probe.ts";
import { checkDependencies } from "../../extensions/commands/doctor/dependencies.ts";
import { applySandboxPanelKey, applySandboxPick, openSandboxPanel, renderSandboxPanel, sandboxModeOf, sandboxPickOutcome } from "../../extensions/safety/sandbox/panel.ts";
import { createHostGate, type HostAnswer } from "../../extensions/safety/sandbox/hosts.ts";
import { sandboxSectionText, sandboxStatusLines } from "../../extensions/safety/sandbox/section.ts";
import { renderTranscript, toolCallEntry } from "../../extensions/safety/permissions/auto-mode/transcript.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const ON: SandboxSettings = { ...SANDBOX_OFF, enabled: true };
/** The user also turned auto-allow on. */
const AUTO: SandboxSettings = { ...ON, autoAllowBashIfSandboxed: true };
const text = {
	disableParam: "disable",
	allowedDomainsParam: "hosts",
	hostNotListed: "not listed",
	section: (p: object) => `section ${JSON.stringify(p)}`,
	turnedOff: "off",
	unavailable: (p: object) => `unavailable ${JSON.stringify(p)}`,
	refused: (p: object) => `refused ${JSON.stringify(p)}`,
};

/** A running sandbox that marks what it wraps and reports `violations` once per call. */
function fakeSandbox(settings: SandboxSettings, violations = ""): ActiveSandbox & { wrapped: Array<{ command: string; cwd: string; shell: string; id: string; text: string }>; hosts: Map<string, string[]> } {
	const wrapped: Array<{ command: string; cwd: string; shell: string; id: string; text: string }> = [];
	const hosts = new Map<string, string[]>();
	return {
		settings,
		wrapped,
		hosts,
		allowHosts: (id, list) => {
			if (list.some((host) => host.includes(" "))) throw new Error(`invalid host "${list.find((host) => host.includes(" "))}"`);
			hosts.set(id, [...list]);
		},
		release: (id) => void hosts.delete(id),
		wrap: async (command, call) => {
			wrapped.push({ command, ...call });
			return `SANDBOX(${command})`;
		},
		annotate: () => violations,
		filesystem: (cwd) => sandboxFilesystem(settings, { cwd, writableDirs: ["/tmp/session"], protectedFiles: [`${cwd}/.claude/settings.json`] }),
	};
}

const request = { command: "npm test", original: "npm test", disable: false, cwd: "/work", bash: "/bin/bash", id: "call-1" };
const supported = process.platform === "darwin" || process.platform === "linux";

afterEach(() => setSandboxForTest(undefined));

describe("sandbox settings", () => {
	it("lets a repository's file tighten the sandbox and never widen it", () => {
		const block = {
			enabled: true,
			allowUnsandboxedCommands: false,
			failIfUnavailable: true,
			excludedCommands: ["docker *"],
			filesystem: { allowWrite: ["/etc"], denyWrite: ["secrets"], denyRead: ["~/.ssh"], allowRead: ["~/.ssh/config"] },
			network: { allowedDomains: ["evil.example"], deniedDomains: ["bad.example"], allowLocalBinding: true, allowUnixSockets: ["/var/run/docker.sock"] },
		};
		expect(mergeSandboxBlock(SANDBOX_OFF, block, true)).toEqual({
			...SANDBOX_OFF,
			enabled: true,
			allowUnsandboxedCommands: false,
			filesystem: { allowWrite: [], denyWrite: ["secrets"], denyRead: ["~/.ssh"], allowRead: [] },
			network: { ...SANDBOX_OFF.network, deniedDomains: ["bad.example"] },
		});
		// The user's own file takes all of it.
		expect(mergeSandboxBlock(SANDBOX_OFF, block, false)).toEqual({
			enabled: true,
			allowUnsandboxedCommands: false,
			failIfUnavailable: true,
			autoAllowBashIfSandboxed: false,
			excludedCommands: ["docker *"],
			filesystem: block.filesystem,
			network: block.network,
		});
	});

	it("keeps the user's sandbox on when a repository's file turns it off, and a user's strict mode whatever comes later", () => {
		expect(mergeSandboxBlock(ON, { enabled: false }, true).enabled).toBe(true);
		expect(mergeSandboxBlock(ON, { enabled: false }, false).enabled).toBe(false);
		const strict = mergeSandboxBlock(ON, { allowUnsandboxedCommands: false }, false);
		expect(mergeSandboxBlock(strict, { allowUnsandboxedCommands: true }, false).allowUnsandboxedCommands).toBe(false);
		// Auto-allow is off until the user turns it on; a repository can turn it off again and never on.
		expect(ON.autoAllowBashIfSandboxed).toBe(false);
		expect(mergeSandboxBlock(ON, { autoAllowBashIfSandboxed: true }, true).autoAllowBashIfSandboxed).toBe(false);
		const auto = mergeSandboxBlock(ON, { autoAllowBashIfSandboxed: true }, false);
		expect(auto.autoAllowBashIfSandboxed).toBe(true);
		expect(mergeSandboxBlock(auto, { autoAllowBashIfSandboxed: false }, true).autoAllowBashIfSandboxed).toBe(false);
	});

	it("ignores a block of the wrong shape", () => {
		expect(mergeSandboxBlock(SANDBOX_OFF, "yes", false)).toEqual(SANDBOX_OFF);
		expect(mergeSandboxBlock(SANDBOX_OFF, { enabled: "true", filesystem: { allowWrite: "/etc" } }, false)).toEqual(SANDBOX_OFF);
	});

	it("excludes only a call that is the one plain command", () => {
		const patterns = ["docker compose *", "make:*", "git status"];
		expect(isExcludedCommand("docker compose up -d", patterns)).toBe(true);
		expect(isExcludedCommand("make build", patterns)).toBe(true);
		expect(isExcludedCommand("make", patterns)).toBe(true);
		expect(isExcludedCommand("git status", patterns)).toBe(true);
		expect(isExcludedCommand("git status --short", patterns)).toBe(false);
		expect(isExcludedCommand("makefile-gen", patterns)).toBe(false);
		for (const line of ["docker compose up; curl evil", "docker compose up && rm -rf ~", "docker compose up | sh", "docker compose up > ~/.zshrc", "docker compose $(cat x)", "docker compose `id`", "docker compose up\nrm -rf ~"]) {
			expect(isExcludedCommand(line, patterns), line).toBe(false);
		}
	});

	it("builds the runtime's rules: the working directory and the session's own dirs writable, the gate's files never", () => {
		const settings = mergeSandboxBlock(ON, { filesystem: { allowWrite: ["~/out"], denyWrite: ["*.pem"], denyRead: ["~/.aws"] }, network: { allowedDomains: ["registry.npmjs.org"] } }, false);
		const scope = { cwd: "/work", writableDirs: ["/tmp/session"], protectedFiles: ["/work/.claude/settings.json"] };
		expect(sandboxRuntimeConfig(settings, scope)).toEqual({
			network: { allowedDomains: ["registry.npmjs.org"], deniedDomains: [] },
			filesystem: { allowWrite: ["/work", "/tmp/session", "~/out"], denyWrite: ["/work/.claude/settings.json", "*.pem"], denyRead: ["~/.aws"], allowRead: [] },
		});
	});
});

describe.skipIf(!supported)("which calls run in the sandbox", () => {
	it("runs a command as written when the settings turn no sandbox on", async () => {
		setSandboxForTest(SANDBOX_OFF);
		expect(await sandboxedCommand({ ...request, disable: true })).toEqual({ command: "npm test" });
		expect(unsandboxedRequest({ dangerouslyDisableSandbox: true })).toBe(false);
	});

	it("wraps a command for its own directory and shell", async () => {
		const sandbox = fakeSandbox(ON);
		setSandboxForTest(ON, sandbox);
		expect(await sandboxedCommand(request)).toMatchObject({ command: "SANDBOX(npm test)", run: {} });
		expect(sandbox.wrapped).toMatchObject([{ command: "npm test", cwd: "/work", shell: "/bin/bash" }]);
		// The id the command presents to the proxy is random, never the tool call's.
		expect(sandbox.wrapped[0].id).toMatch(/^[\w-]{22}$/);
		expect(sandbox.wrapped[0].id).not.toBe("call-1");
	});

	it("gives a call the hosts the gate granted it, for its one run", async () => {
		const sandbox = fakeSandbox(ON);
		setSandboxForTest(ON, sandbox);
		grantCommandHosts("call-1", ["registry.npmjs.org"]);
		const first = await sandboxedCommand(request);
		const id = sandbox.wrapped[0].id;
		expect(sandbox.hosts.get(id)).toEqual(["registry.npmjs.org"]);
		if (!("run" in first) || !first.run) throw new Error("not sandboxed");
		first.run.finish();
		first.run.finish();
		expect(sandbox.hosts.size).toBe(0);
		// The grant was the one run's: the same call id again gets nothing.
		await sandboxedCommand(request);
		expect(sandbox.hosts.size).toBe(0);
	});

	it("gives a call nothing without the gate's grant", async () => {
		const sandbox = fakeSandbox(ON);
		setSandboxForTest(ON, sandbox);
		grantCommandHosts("call-1", ["registry.npmjs.org"]);
		await sandboxedCommand({ ...request, id: "call-2" });
		expect(sandbox.hosts.size).toBe(0);
	});

	it("wraps the bash line of a tool whose own shell is not bash, and files denials under the model's command", async () => {
		const sandbox = fakeSandbox(ON);
		setSandboxForTest(ON, sandbox);
		const line = powerShellBashLine({ shell: "/usr/local/bin/pwsh", args: ["-NoProfile", "-Command"] }, "Write-Output hi");
		expect(line.startsWith("'/usr/local/bin/pwsh' '-NoProfile' '-Command' '")).toBe(true);
		expect(line.endsWith("Write-Output hi'")).toBe(true);
		await sandboxedCommand({ ...request, command: "Get-ChildItem", original: "Get-ChildItem", line: "'pwsh' '-Command' 'Get-ChildItem'" });
		expect(sandbox.wrapped[0]).toMatchObject({ command: "'pwsh' '-Command' 'Get-ChildItem'", shell: "/bin/bash", text: "Get-ChildItem" });
	});

	it("takes auto-allow and the fallback from the settings again without a restart, and nothing else", () => {
		const settings = { ...ON, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: true };
		setSandboxForTest(settings, fakeSandbox(settings));
		const loaded = reloadSandboxSettings();
		expect(sandboxSettings()).toMatchObject({ enabled: true, allowUnsandboxedCommands: loaded.allowUnsandboxedCommands, autoAllowBashIfSandboxed: loaded.autoAllowBashIfSandboxed });
	});

	it("refuses a call whose granted host list the sandbox rejects, with the reason", async () => {
		const sandbox = fakeSandbox(ON);
		setSandboxForTest(ON, sandbox);
		grantCommandHosts("call-1", ["not a host"]);
		expect(await sandboxedCommand(request)).toEqual({ refused: { kind: "hosts", reason: 'invalid host "not a host"' } });
		expect(sandbox.wrapped).toEqual([]);
	});

	it("reads a call's own hosts only where a sandbox will hold the call", () => {
		expect(commandHosts({ allowed_domains: [" a.example ", "a.example", "", 3, "x".repeat(261)] })).toEqual(["a.example"]);
		expect(commandHosts({ allowed_domains: Array.from({ length: 150 }, (_, i) => `h${i}.example`) })).toHaveLength(100);
		setSandboxForTest(SANDBOX_OFF);
		expect(requestedHosts({ allowed_domains: ["a.example"] })).toEqual([]);
		setSandboxForTest(ON, fakeSandbox(ON));
		expect(requestedHosts({ allowed_domains: ["a.example"] })).toEqual(["a.example"]);
		expect(requestedHosts({ allowed_domains: ["a.example"], dangerouslyDisableSandbox: true })).toEqual([]);
	});

	it("says which calls will run sandboxed, for the gate's manual modes", () => {
		setSandboxForTest(SANDBOX_OFF);
		expect(runsSandboxed({}, "npm test")).toBe(false);
		setSandboxForTest(AUTO, undefined, "no bwrap");
		expect(runsSandboxed({}, "npm test")).toBe(false);
		const settings = { ...AUTO, excludedCommands: ["docker *"] };
		setSandboxForTest(settings, fakeSandbox(settings));
		expect(runsSandboxed({}, "npm test")).toBe(true);
		expect(runsSandboxed({ dangerouslyDisableSandbox: true }, "npm test")).toBe(false);
		expect(runsSandboxed({}, "docker ps")).toBe(false);
		// Off by default: the sandbox alone changes no prompt.
		setSandboxForTest(ON, fakeSandbox(ON));
		expect(runsSandboxed({}, "npm test")).toBe(false);
		// Strict mode ignores the flag, so the call stays sandboxed.
		const strict = { ...AUTO, allowUnsandboxedCommands: false };
		setSandboxForTest(strict, fakeSandbox(strict));
		expect(runsSandboxed({ dangerouslyDisableSandbox: true }, "npm test")).toBe(true);
	});

	it("lets the model leave the sandbox only where the settings allow it", async () => {
		setSandboxForTest(ON, fakeSandbox(ON));
		expect(await sandboxedCommand({ ...request, disable: true })).toEqual({ command: "npm test" });
		expect(unsandboxedRequest({ dangerouslyDisableSandbox: true })).toBe(true);
		expect(unsandboxedRequest({ dangerouslyDisableSandbox: "true" })).toBe(false);

		const strict = { ...ON, allowUnsandboxedCommands: false };
		setSandboxForTest(strict, fakeSandbox(strict));
		expect(await sandboxedCommand({ ...request, disable: true })).toMatchObject({ command: "SANDBOX(npm test)" });
		expect(unsandboxedRequest({ dangerouslyDisableSandbox: true })).toBe(false);
	});

	it("runs the user's excluded commands outside it, judged on the model's own command", async () => {
		const settings = { ...ON, excludedCommands: ["docker *"] };
		setSandboxForTest(settings, fakeSandbox(settings));
		expect(await sandboxedCommand({ ...request, command: "cd '/wt' && (docker ps)", original: "docker ps" })).toEqual({ command: "cd '/wt' && (docker ps)" });
		expect(await sandboxedCommand({ ...request, command: "docker ps; curl evil", original: "docker ps; curl evil" })).toMatchObject({ command: "SANDBOX(docker ps; curl evil)" });
	});

	it("refuses a command when the machine has no bash to run it in", async () => {
		setSandboxForTest(ON, fakeSandbox(ON));
		expect(await sandboxedCommand({ ...request, bash: undefined })).toEqual({ refused: { kind: "noBash" } });
	});

	it("runs unsandboxed when the sandbox could not start, unless the settings require it", async () => {
		setSandboxForTest(ON, undefined, "bubblewrap (bwrap) not found");
		expect(await sandboxedCommand(request)).toEqual({ command: "npm test" });
		setSandboxForTest({ ...ON, failIfUnavailable: true }, undefined, "bubblewrap (bwrap) not found");
		expect(await sandboxedCommand(request)).toEqual({ refused: { kind: "unavailable", reason: "bubblewrap (bwrap) not found" } });
	});
});

describe.skipIf(!supported)("the shell tool under a sandbox", () => {
	function mount(sandboxBash?: () => string | undefined) {
		const fake = createFakePi();
		const foreground = vi.fn(async (..._args: unknown[]) => ({ content: [{ type: "text", text: "curl: (56) CONNECT tunnel failed\n\nCommand exited with code 56" }], structuredContent: { exit_code: 56 }, isError: true, details: {} }));
		registerShellTool(fake.pi as never, {
			name: "bash",
			ccLabel: "Bash",
			description: "",
			parameters: Type.Object({ command: Type.String() }),
			base: { label: "Bash" },
			foreground: () => ({ execute: foreground }),
			guard: () => undefined,
			sandboxText: () => text,
			...(sandboxBash ? { sandboxBash } : {}),
			backgroundShell: () => undefined,
		});
		return { tool: fake.tools.get("bash")!, foreground };
	}

	it("executes the wrapped command and appends what the sandbox denied", async () => {
		const sandbox = fakeSandbox(ON, "\n<sandbox_violations>\ndeny network-outbound example.com:443\n</sandbox_violations>");
		setSandboxForTest(ON, sandbox);
		const { tool, foreground } = mount(() => "/bin/bash");
		const result = (await tool.execute("c1", { command: "curl https://example.com" }, undefined, undefined, createFakeCtx({ mode: "tui", cwd: "/work" }))) as { content: Array<{ text: string }> };
		expect((foreground.mock.calls[0][1] as { command: string }).command).toBe("SANDBOX(curl https://example.com)");
		expect(result.content[0].text).toBe("Exit code 56\ncurl: (56) CONNECT tunnel failed\n<sandbox_violations>\ndeny network-outbound example.com:443\n</sandbox_violations>");
	});

	it("executes the model's command as written when it may leave the sandbox", async () => {
		setSandboxForTest(ON, fakeSandbox(ON));
		const { tool, foreground } = mount(() => "/bin/bash");
		await tool.execute("c1", { command: "curl https://example.com", dangerouslyDisableSandbox: true }, undefined, undefined, createFakeCtx({ mode: "tui" }));
		expect((foreground.mock.calls[0][1] as { command: string }).command).toBe("curl https://example.com");
	});

	it("runs a non-bash tool's sandboxed command through its bash executor, and an unsandboxed one through its own", async () => {
		const sandbox = fakeSandbox(ON);
		setSandboxForTest(ON, sandbox);
		const fake = createFakePi();
		const result = { content: [{ type: "text", text: "ok" }], details: {} };
		const own = vi.fn(async (..._args: unknown[]) => result);
		const viaBash = vi.fn(async (..._args: unknown[]) => result);
		registerShellTool(fake.pi as never, {
			name: "powershell",
			ccLabel: "PowerShell",
			description: "",
			parameters: Type.Object({ command: Type.String() }),
			base: { label: "PowerShell" },
			foreground: () => ({ execute: own }),
			guard: () => undefined,
			sandboxText: () => text,
			sandboxBash: () => "/bin/bash",
			sandboxed: { line: (command: string) => `pwsh -Command ${command}`, foreground: () => ({ execute: viaBash }), spawn: () => undefined },
			backgroundShell: () => undefined,
		} as never);
		const tool = fake.tools.get("powershell")!;
		await tool.execute("c1", { command: "Get-Date" }, undefined, undefined, createFakeCtx({ mode: "tui", cwd: "/work" }));
		expect(sandbox.wrapped[0]).toMatchObject({ command: "pwsh -Command Get-Date", text: "Get-Date" });
		expect((viaBash.mock.calls[0][1] as { command: string }).command).toBe("SANDBOX(pwsh -Command Get-Date)");
		expect(own).not.toHaveBeenCalled();
		await tool.execute("c2", { command: "Get-Date", dangerouslyDisableSandbox: true }, undefined, undefined, createFakeCtx({ mode: "tui", cwd: "/work" }));
		expect((own.mock.calls[0][1] as { command: string }).command).toBe("Get-Date");
	});

	it("releases a background command's hosts when no shell can start it", async () => {
		const sandbox = fakeSandbox(ON);
		setSandboxForTest(ON, sandbox);
		grantCommandHosts("c1", ["registry.npmjs.org"]);
		const { tool } = mount(() => "/bin/bash");
		const result = await tool.execute("c1", { command: "npm install", run_in_background: true }, undefined, undefined, createFakeCtx({ mode: "tui", cwd: "/work" }));
		expect(result).toMatchObject({ isError: true });
		expect(sandbox.wrapped).toHaveLength(1);
		expect(sandbox.hosts.size).toBe(0);
	});

	it("refuses a call the sandbox cannot run, loudly, and runs nothing", async () => {
		setSandboxForTest(ON, fakeSandbox(ON));
		const { tool, foreground } = mount();
		const result = await tool.execute("c1", { command: "Get-ChildItem" }, undefined, undefined, createFakeCtx({ mode: "tui" }));
		expect(result).toMatchObject({ isError: true, content: [{ text: 'refused {"kind":"noBash"}' }] });
		expect(foreground).not.toHaveBeenCalled();
	});
});

describe("the gate and a call that asks to leave the sandbox", () => {
	const base = { toolName: "bash", cwd: "/work", deny: [], ask: [], allow: [], claudeCodeFastPaths: true };

	it("takes no shell fast path: a read-only command is asked about, or classified in auto mode", () => {
		expect(decide({ ...base, mode: "default", subject: "ls" })).toMatchObject({ decision: "allow", cause: "read-only" });
		expect(decide({ ...base, mode: "default", subject: "ls", unsandboxed: true }).decision).toBe("ask");
		expect(decide({ ...base, mode: "acceptEdits", subject: "mkdir out", unsandboxed: true }).decision).toBe("ask");
		expect(decide({ ...base, mode: "auto", subject: "ls", unsandboxed: true }).decision).toBe("classify");
		expect(decide({ ...base, mode: "dontAsk", subject: "ls", unsandboxed: true }).decision).toBe("deny");
	});
});

describe("the gate and a command the sandbox will hold", () => {
	const base = { toolName: "bash", cwd: "/work", deny: [], ask: [], allow: [], claudeCodeFastPaths: true, sandboxed: true };

	it("runs without a prompt in default and acceptEdits modes only", () => {
		expect(decide({ ...base, mode: "default", subject: "npm test", sandboxed: false }).decision).toBe("ask");
		expect(decide({ ...base, mode: "default", subject: "npm test" })).toMatchObject({ decision: "allow", cause: "sandboxed" });
		expect(decide({ ...base, mode: "acceptEdits", subject: "npm test" })).toMatchObject({ decision: "allow", cause: "sandboxed" });
		expect(decide({ ...base, toolName: "monitor", mode: "default", subject: "tail -f log" }).decision).toBe("ask");
		expect(decide({ ...base, mode: "auto", subject: "npm test" }).decision).toBe("classify");
		expect(decide({ ...base, mode: "dontAsk", subject: "npm test" }).decision).toBe("deny");
	});

	it("keeps deny rules, ask rules and the prompt for a write it can see on a protected path", () => {
		const rule = (raw: string) => ({ tool: "bash", pattern: raw, raw: `Bash(${raw})` });
		expect(decide({ ...base, mode: "default", subject: "npm publish", deny: [rule("npm publish:*")] } as never).decision).toBe("deny");
		expect(decide({ ...base, mode: "default", subject: "npm publish", ask: [rule("npm publish:*")] } as never).decision).toBe("ask");
		expect(decide({ ...base, mode: "default", subject: "echo x > .git/hooks/pre-commit" }).decision).toBe("ask");
		expect(decide({ ...base, mode: "default", subject: "echo x > out.txt" })).toMatchObject({ decision: "allow" });
	});
});

describe("the gate and a call that names hosts for itself", () => {
	const base = { toolName: "bash", cwd: "/work", deny: [], ask: [], allow: [], claudeCodeFastPaths: true, mode: "auto" as const };

	it("is classified in auto mode whatever fast path or allow rule would clear the command", () => {
		const allow = [{ tool: "bash", pattern: "curl:*", raw: "Bash(curl:*)" }];
		expect(decide({ ...base, subject: "ls" })).toMatchObject({ decision: "allow", cause: "read-only" });
		expect(decide({ ...base, subject: "ls", commandHosts: true }).decision).toBe("classify");
		expect(decide({ ...base, subject: "curl https://a.example", allow } as never)).toMatchObject({ decision: "allow", cause: "rule" });
		expect(decide({ ...base, subject: "curl https://a.example", allow, commandHosts: true } as never).decision).toBe("classify");
	});

	it("shows the classifier the hosts with the command, and a plain command as before", () => {
		const line = (input: object, asWritten?: string) => renderTranscript([toolCallEntry("bash", input, asWritten)]);
		expect(line({ command: "ls", description: "list" })).toContain('{"Bash":"ls"}');
		expect(line({ command: "curl https://a.example", allowed_domains: ["a.example"] })).toContain('{"Bash":{"command":"curl https://a.example","allowed_domains":["a.example"]}}');
		expect(line({ command: "cd /wt && (curl x)", allowed_domains: ["a.example"] }, "curl x")).toContain('{"Bash":{"command":"curl x","allowed_domains":["a.example"]}}');
		expect(line({ command: "ls", allowed_domains: [] })).toContain('{"Bash":"ls"}');
		// The flag that asks to leave the sandbox is not part of the entry, as in Claude Code.
		expect(line({ command: "ls", dangerouslyDisableSandbox: true })).toContain('{"Bash":"ls"}');
	});
});

describe("the gate and a monitor that names hosts for itself", () => {
	it("is not cleared by an allow rule for its command", () => {
		const base = { toolName: "monitor", cwd: "/work", deny: [], ask: [], allow: [{ tool: "monitor", pattern: "tail:*", raw: "Monitor(tail:*)" }], claudeCodeFastPaths: true, mode: "auto" as const, subject: "tail -f log" };
		expect(decide(base as never)).toMatchObject({ decision: "allow", cause: "rule" });
		expect(decide({ ...base, commandHosts: true } as never).decision).toBe("classify");
	});
});

describe("a host the settings do not list", () => {
	function gate(mode: string, answers: HostAnswer[] = []) {
		const asked: string[] = [];
		const hosts = createHostGate({
			mode: () => mode,
			notListed: "not listed",
			prompt: async (host) => {
				asked.push(host);
				return answers.shift();
			},
		});
		return { hosts, asked };
	}

	it("follows the permission mode without asking where no prompt belongs", async () => {
		expect(await gate("bypassPermissions").hosts.ask({ host: "a.example" })).toBe(true);
		expect(await gate("auto").hosts.ask({ host: "a.example" })).toEqual({ allow: false, reason: "not listed" });
		expect(await gate("dontAsk").hosts.ask({ host: "a.example" })).toBe(false);
	});

	it("asks the user once per host and run, and keeps a session grant", async () => {
		const { hosts, asked } = gate("default", ["once", "no", "session", "no"]);
		expect(await Promise.all([hosts.ask({ host: "a.example" }), hosts.ask({ host: "A.example", port: 443 })])).toEqual([true, true]);
		expect(await hosts.ask({ host: "b.example" })).toBe(false);
		expect(await hosts.ask({ host: "b.example" })).toBe(false);
		expect(await hosts.ask({ host: "c.example" })).toBe(true);
		expect(asked).toEqual(["a.example", "b.example", "c.example"]);
		hosts.endRun();
		expect(await hosts.ask({ host: "c.example" })).toBe(true);
		expect(await hosts.ask({ host: "a.example" })).toBe(false);
		expect(asked).toEqual(["a.example", "b.example", "c.example", "a.example"]);
		expect(hosts.sessionHosts()).toEqual(["c.example"]);
	});

	it("refuses when there is no one to ask, and asks again next time", async () => {
		const { hosts, asked } = gate("default", [undefined, "once"]);
		expect(await hosts.ask({ host: "a.example" })).toBe(false);
		expect(await hosts.ask({ host: "a.example" })).toBe(true);
		expect(asked).toEqual(["a.example", "a.example"]);
	});
});

describe("the sandbox section and /sandbox", () => {
	const facts = { settings: ON, platform: "darwin" as const, unavailable: undefined, cwd: "/work" };

	it("prints the session's rules for the command's directory", () => {
		const section = sandboxSectionText(text, { ...facts, active: fakeSandbox(ON) });
		expect(section).toBe(
			`section ${JSON.stringify({
				platform: "darwin",
				filesystem: JSON.stringify({ read: { denyOnly: [], allowWithinDeny: [] }, write: { allowOnly: ["/work", "/tmp/session"], denyWithinAllow: ["/work/.claude/settings.json"] } }),
				unsandboxedAllowed: true,
			})}`,
		);
	});

	it("says so when the sandbox could not start", () => {
		expect(sandboxSectionText(text, { ...facts, settings: { ...ON, failIfUnavailable: true }, active: undefined, unavailable: "no bwrap" })).toBe('unavailable {"reason":"no bwrap","required":true}');
	});

	it("tells the user the state in each case", () => {
		expect(sandboxStatusLines({ ...facts, platform: undefined, active: undefined })[0]).toContain("not available on this platform");
		expect(sandboxStatusLines({ ...facts, settings: SANDBOX_OFF, active: undefined })[0]).toBe("Command sandbox: off.");
		expect(sandboxStatusLines({ ...facts, active: undefined, unavailable: "no bwrap" })).toEqual(["Command sandbox: on in settings, not running (no bwrap).", "Shell commands run without it."]);
		expect(sandboxStatusLines({ ...facts, active: fakeSandbox(ON) })).toContain("Writable: /work, /tmp/session");
	});
});

describe("the /sandbox panel", () => {
	const plain = (_color: string, value: string) => value;
	const bold = (value: string) => value;

	it("opens on the current mode and lists the three modes", () => {
		const state = openSandboxPanel(AUTO);
		expect(state).toMatchObject({ tab: "mode", row: 0 });
		const lines = renderSandboxPanel({ state, mode: "auto-allow", override: "fallback", config: [], width: 100, height: 30 }, plain, bold);
		expect(lines.filter((line) => /Sandbox commands|No sandbox/.test(line))).toEqual(["  ❯ ✔ Sandbox commands, with auto-allow", "      Sandbox commands, with regular permissions", "      No sandbox"]);
		expect(lines.at(-1)).toContain("Enter to select");
		expect(lines.at(-1)).toContain("Esc to close");
	});

	it("moves between rows and tabs, picks with Enter and scrolls the config", () => {
		const current = { mode: sandboxModeOf(ON), override: "strict" as const };
		const state = openSandboxPanel(ON);
		expect(state.row).toBe(1);
		applySandboxPanelKey(state, "down", current, 10);
		expect(applySandboxPanelKey(state, "select", current, 10)).toEqual({ kind: "pick", pick: { tab: "mode", value: "off" } });
		applySandboxPanelKey(state, "right", current, 10);
		expect(state).toMatchObject({ tab: "overrides", row: 1 });
		applySandboxPanelKey(state, "up", current, 10);
		expect(applySandboxPanelKey(state, "select", current, 10)).toEqual({ kind: "pick", pick: { tab: "overrides", value: "fallback" } });
		applySandboxPanelKey(state, "right", current, 10);
		const config = Array.from({ length: 40 }, (_, index) => `line ${index}`);
		const shown = renderSandboxPanel({ state, mode: "regular", override: "strict", config, width: 80, height: 15 }, plain, bold);
		expect(shown).toHaveLength(15);
		// A path longer than the panel is cut across rows, never off the edge.
		const long = renderSandboxPanel({ state: { tab: "config", row: 0, offset: 0 }, mode: "regular", override: "strict", config: [`Writable: /${"a".repeat(120)}`], width: 60, height: 15 }, plain, bold);
		expect(long.join("")).toContain("a".repeat(56));
		expect(long.filter((line) => line.includes("aaa")).length).toBe(3);
		applySandboxPanelKey(state, "down", current, 10);
		expect(state.offset).toBe(1);
		expect(applySandboxPanelKey(state, "select", current, 10)).toBeUndefined();
		expect(applySandboxPanelKey(state, "close", current, 10)).toEqual({ kind: "close" });
		applySandboxPanelKey(state, "right", current, 10);
		expect(state.tab).toBe("mode");
	});

	it("writes a pick into the sandbox block and keeps every other key", () => {
		const file = { model: "x", sandbox: { network: { allowedDomains: ["a.example"] }, enabled: false } };
		expect(applySandboxPick(file, { tab: "mode", value: "auto-allow" })).toEqual({ model: "x", sandbox: { network: { allowedDomains: ["a.example"] }, enabled: true, autoAllowBashIfSandboxed: true } });
		expect(applySandboxPick(file, { tab: "mode", value: "regular" }).sandbox).toMatchObject({ enabled: true, autoAllowBashIfSandboxed: false });
		expect(applySandboxPick({ sandbox: { autoAllowBashIfSandboxed: true } }, { tab: "mode", value: "off" }).sandbox).toEqual({ autoAllowBashIfSandboxed: true, enabled: false });
		expect(applySandboxPick({}, { tab: "overrides", value: "strict" })).toEqual({ sandbox: { allowUnsandboxedCommands: false } });
		expect(applySandboxPick({}, { tab: "overrides", value: "fallback" })).toEqual({ sandbox: { allowUnsandboxedCommands: true } });
	});

	it("says what holds now, what waits for a restart and what another file overrides", () => {
		expect(sandboxPickOutcome({ tab: "mode", value: "auto-allow" }, true, AUTO)).toMatch(/^Sandbox with auto-allow.*modes[.]$/);
		expect(sandboxPickOutcome({ tab: "mode", value: "auto-allow" }, false, AUTO)).toContain("turns on at the next start");
		expect(sandboxPickOutcome({ tab: "mode", value: "auto-allow" }, true, ON)).toContain("another settings file turns auto-allow off");
		expect(sandboxPickOutcome({ tab: "mode", value: "off" }, true, SANDBOX_OFF)).toBe("No sandbox. The sandbox turns off at the next start.");
		expect(sandboxPickOutcome({ tab: "mode", value: "off" }, true, ON)).toContain("another settings file turns the sandbox on");
		expect(sandboxPickOutcome({ tab: "overrides", value: "fallback" }, true, { ...ON, allowUnsandboxedCommands: false })).toContain("strict sandbox mode stays");
		expect(sandboxPickOutcome({ tab: "overrides", value: "strict" }, true, { ...ON, allowUnsandboxedCommands: false })).toContain("Strict sandbox mode");
	});
});

describe("/doctor and the Linux sandbox's programs", () => {
	const input = { cwd: "/nowhere", env: { PATH: "" }, mcpServers: [], webSearchSettings: {} };

	it("asks for bubblewrap and socat on Linux when the sandbox is on, as an error where it is required", () => {
		const on = checkDependencies({ ...input, platform: "linux", sandbox: { enabled: true, required: false } });
		expect(on.checks.filter((check) => ["bwrap", "socat"].includes(check.name))).toEqual([expect.objectContaining({ found: false, need: "required" }), expect.objectContaining({ found: false, need: "required" })]);
		expect(on.findings.find((finding) => finding.text.includes("command sandbox"))).toMatchObject({ level: "warn", fix: expect.stringContaining("apt install bubblewrap") });
		const required = checkDependencies({ ...input, platform: "linux", sandbox: { enabled: true, required: true } });
		expect(required.findings.find((finding) => finding.text.includes("command sandbox"))).toMatchObject({ level: "error" });
	});

	it("names the kernel's user-namespace restriction when both programs are there and bubblewrap still cannot start", () => {
		const bin = mkdtempSync(join(tmpdir(), "sandbox-doctor-"));
		try {
			for (const name of ["bwrap", "socat"]) writeFileSync(join(bin, name), "#!/bin/sh\n", { mode: 0o755 });
			const sandbox = { enabled: true, required: true, usernsRestricted: true };
			const restricted = checkDependencies({ ...input, env: { PATH: bin }, platform: "linux", sandbox });
			expect(restricted.findings.find((entry) => entry.text.includes("user namespaces"))).toMatchObject({ level: "error", fix: expect.stringContaining("apparmor_restrict_unprivileged_userns=0") });
			// A machine without the programs gets the install finding, not this one.
			const missing = checkDependencies({ ...input, platform: "linux", sandbox });
			expect(missing.findings.some((entry) => entry.text.includes("user namespaces"))).toBe(false);
			expect(checkDependencies({ ...input, env: { PATH: bin }, platform: "linux", sandbox: { ...sandbox, usernsRestricted: false } }).findings.some((entry) => entry.text.includes("command sandbox"))).toBe(false);
		} finally {
			rmSync(bin, { recursive: true, force: true });
		}
		expect(usernsRestricted(() => "1\n")).toBe(true);
		expect(usernsRestricted(() => "0\n")).toBe(false);
		expect(usernsRestricted(() => {
			throw new Error("ENOENT");
		})).toBe(false);
		expect(sandboxProbeFailure("\nbwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\n", true)).toMatch(/^bubblewrap could not run a command \(bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\)\. This kernel restricts.*sudo sysctl -w kernel\.apparmor_restrict_unprivileged_userns=0/);
		expect(sandboxProbeFailure("", false)).toBe("bubblewrap could not run a command (no error output)");
	});

	it("says nothing where the sandbox is off, and lists nothing on macOS", () => {
		const off = checkDependencies({ ...input, platform: "linux", sandbox: { enabled: false, required: false } });
		expect(off.findings.some((finding) => finding.text.includes("command sandbox"))).toBe(false);
		expect(off.checks.find((check) => check.name === "bwrap")).toMatchObject({ need: "unused" });
		const mac = checkDependencies({ ...input, platform: "darwin", sandbox: { enabled: true, required: true } });
		expect(mac.checks.some((check) => check.name === "bwrap")).toBe(false);
	});
});
