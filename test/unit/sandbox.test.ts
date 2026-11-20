/**
 * The shell sandbox (lib/shell-run/sandbox.ts, sandbox-settings.ts,
 * safety/sandbox/section.ts): which settings a repository may set, which
 * calls run inside it, and how the gate treats a call that asks to leave it.
 * The runtime itself is not started here; the live checks are in
 * working-docs/features/sandbox/.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { decide } from "../../extensions/lib/rules/matcher.ts";
import { type ActiveSandbox, sandboxedCommand, setSandboxForTest, unsandboxedRequest } from "../../extensions/lib/shell-run/sandbox.ts";
import { isExcludedCommand, mergeSandboxBlock, SANDBOX_OFF, type SandboxSettings, sandboxFilesystem, sandboxRuntimeConfig } from "../../extensions/lib/shell-run/sandbox-settings.ts";
import { registerShellTool } from "../../extensions/lib/shell-run/shell-tool.ts";
import { sandboxSectionText, sandboxStatusLines } from "../../extensions/safety/sandbox/section.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const ON: SandboxSettings = { ...SANDBOX_OFF, enabled: true };
const text = {
	disableParam: "disable",
	section: (p: object) => `section ${JSON.stringify(p)}`,
	turnedOff: "off",
	unavailable: (p: object) => `unavailable ${JSON.stringify(p)}`,
	refused: (p: object) => `refused ${JSON.stringify(p)}`,
};

/** A running sandbox that marks what it wraps and reports `violations` once per call. */
function fakeSandbox(settings: SandboxSettings, violations = ""): ActiveSandbox & { wrapped: Array<{ command: string; cwd: string; shell: string; id: string }> } {
	const wrapped: Array<{ command: string; cwd: string; shell: string; id: string }> = [];
	return {
		settings,
		wrapped,
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
		expect(await sandboxedCommand(request)).toEqual({ command: "SANDBOX(npm test)", sandbox });
		expect(sandbox.wrapped).toEqual([{ command: "npm test", cwd: "/work", shell: "/bin/bash", id: "call-1" }]);
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

	it("refuses a PowerShell command, which the sandbox does not run", async () => {
		setSandboxForTest(ON, fakeSandbox(ON));
		expect(await sandboxedCommand({ ...request, bash: undefined })).toEqual({ refused: { kind: "powershell" } });
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

	it("refuses a call the sandbox cannot run, loudly, and runs nothing", async () => {
		setSandboxForTest(ON, fakeSandbox(ON));
		const { tool, foreground } = mount();
		const result = await tool.execute("c1", { command: "Get-ChildItem" }, undefined, undefined, createFakeCtx({ mode: "tui" }));
		expect(result).toMatchObject({ isError: true, content: [{ text: 'refused {"kind":"powershell"}' }] });
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

describe("the sandbox section and /sandbox", () => {
	const facts = { settings: ON, platform: "darwin" as const, unavailable: undefined, cwd: "/work" };

	it("prints the session's rules for the command's directory", () => {
		const section = sandboxSectionText(text, { ...facts, active: fakeSandbox(ON) });
		expect(section).toBe(
			`section ${JSON.stringify({
				platform: "darwin",
				filesystem: JSON.stringify({ read: { denyOnly: [], allowWithinDeny: [] }, write: { allowOnly: ["/work", "/tmp/session"], denyWithinAllow: ["/work/.claude/settings.json"] } }),
				network: JSON.stringify({ allowedDomains: [], deniedDomains: [] }),
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
