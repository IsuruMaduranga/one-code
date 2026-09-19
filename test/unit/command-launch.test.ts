import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { commandLaunch, isBatchFile, quoteForCmd } from "../../extensions/lib/command-launch.ts";
import { whichOnPath } from "../../extensions/lib/which.ts";

/**
 * npm installs a language server (and VS Code its `code` CLI) on Windows as
 * a `.cmd` shim, which a bare spawn cannot start (findings §22): the launch
 * resolver routes such a shim through cmd.exe and leaves everything else alone. Pure, so pinned on every
 * platform with an injected PATH lookup.
 */
describe("commandLaunch", () => {
	const env = { PATH: "C:\\npm", SystemRoot: "C:\\Windows" };
	const which = (command: string) =>
		command === "typescript-language-server" ? "C:\\npm\\typescript-language-server.CMD" : command === "gopls" ? "C:\\Go\\bin\\gopls.exe" : undefined;

	it("starts a .cmd shim through cmd.exe with the command line quoted once", () => {
		const launch = commandLaunch("typescript-language-server", ["--stdio"], env, { platform: "win32", which });
		expect(launch).toEqual({
			command: join("C:\\Windows", "System32", "cmd.exe"),
			args: ["/d", "/s", "/c", '"C:\\npm\\typescript-language-server.CMD --stdio"'],
			windowsVerbatimArguments: true,
		});
	});

	it("quotes a shim path or argument that holds spaces", () => {
		const spaced = (command: string) => (command === "srv" ? "C:\\Program Files\\srv\\srv.cmd" : undefined);
		const launch = commandLaunch("srv", ["--log", "C:\\My Logs\\a.log", "plain"], env, { platform: "win32", which: spaced });
		expect(launch.args[3]).toBe('"\"C:\\Program Files\\srv\\srv.cmd\" --log \"C:\\My Logs\\a.log\" plain"');
	});

	it("spawns a real executable by its resolved path, and an unresolvable command as given (the ENOENT carries the hint)", () => {
		expect(commandLaunch("gopls", ["serve"], env, { platform: "win32", which })).toEqual({ command: "C:\\Go\\bin\\gopls.exe", args: ["serve"] });
		expect(commandLaunch("pyright-langserver", ["--stdio"], env, { platform: "win32", which })).toEqual({ command: "pyright-langserver", args: ["--stdio"] });
	});

	it("changes nothing off Windows", () => {
		expect(commandLaunch("typescript-language-server", ["--stdio"], env, { platform: "darwin", which })).toEqual({
			command: "typescript-language-server",
			args: ["--stdio"],
		});
	});

	it("recognises batch files by extension, any case", () => {
		for (const p of ["a.cmd", "A.CMD", "x\\b.bat", "c.Bat"]) expect(isBatchFile(p)).toBe(true);
		for (const p of ["a.exe", "a.cmd.exe", "cmd", "a.com"]) expect(isBatchFile(p)).toBe(false);
	});

	it("quotes for cmd.exe only when needed", () => {
		expect(quoteForCmd("--stdio")).toBe("--stdio");
		expect(quoteForCmd("two words")).toBe('"two words"');
		expect(quoteForCmd("a&b")).toBe('"a&b"');
		expect(quoteForCmd('say "hi"')).toBe('"say \\"hi\\""');
		expect(quoteForCmd("")).toBe('""');
	});

	it("doubles backslashes that would otherwise escape a quote (a quoted path ending in \\)", () => {
		// C runtime rule: `\\"` is an escaped quote, so a trailing separator before
		// the closing quote must be doubled to survive as a separator.
		expect(quoteForCmd("C:\\Program Files\\srv\\")).toBe('"C:\\Program Files\\srv\\\\"');
		expect(quoteForCmd('dir\\"x')).toBe('"dir\\\\\\"x"');
		// A backslash not before a quote is left alone.
		expect(quoteForCmd("C:\\Program Files\\srv.cmd")).toBe('"C:\\Program Files\\srv.cmd"');
	});

	it("locates cmd.exe from the process environment, not the server's env (a config must not redirect it)", () => {
		const hostile = { ...env, SystemRoot: "C:\\Malicious" };
		const launch = commandLaunch("typescript-language-server", ["--stdio"], hostile, { platform: "win32", which });
		expect(launch.command).toBe(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"));
	});
});

describe("whichOnPath for a command spelled with a directory", () => {
	const dir = mkdtempSync(join(tmpdir(), "which-ext-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("applies PATHEXT on Windows (node_modules/.bin/tsserver is tsserver.cmd on disk) and only the literal name elsewhere", () => {
		writeFileSync(join(dir, "probe.cmd"), "@echo off\r\n", { mode: 0o755 });
		const spelled = join(dir, "probe");
		// PATHEXT spelled in the file's own case: a case-folding filesystem would
		// otherwise return `probe.CMD` here, a case-sensitive one nothing.
		expect(whichOnPath(spelled, { PATHEXT: ".EXE;.cmd" }, "win32")).toBe(join(dir, "probe.cmd"));
		expect(whichOnPath(spelled, {}, "darwin")).toBeUndefined();
		expect(whichOnPath(join(dir, "probe.cmd"), {}, "darwin")).toBe(join(dir, "probe.cmd"));
	});
});

describe("whichOnPath on Windows with npm's three shims side by side", () => {
	const dir = mkdtempSync(join(tmpdir(), "which-shims-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	// npm installs `tsls` (a POSIX sh script for Git Bash), `tsls.cmd` and `tsls.ps1`.
	writeFileSync(join(dir, "tsls"), "#!/bin/sh\n", { mode: 0o755 });
	writeFileSync(join(dir, "tsls.cmd"), "@echo off\r\n", { mode: 0o755 });
	writeFileSync(join(dir, "tsls.ps1"), "", { mode: 0o755 });
	// PATHEXT spelled in the files' own case (see the test above).
	const env = { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.cmd" };

	it("prefers the PATHEXT sibling over the extensionless sh script, which Windows cannot run", () => {
		expect(whichOnPath("tsls", env, "win32")).toBe(join(dir, "tsls.cmd"));
		expect(whichOnPath(join(dir, "tsls"), env, "win32")).toBe(join(dir, "tsls.cmd"));
	});

	it("still takes a name spelled with its extension as-is", () => {
		expect(whichOnPath("tsls.cmd", env, "win32")).toBe(join(dir, "tsls.cmd"));
	});

	it("reads PATH and PATHEXT by any key case, the shape a spread of process.env has on Windows", () => {
		expect(whichOnPath("tsls", { Path: dir, PathExt: ".cmd" }, "win32")).toBe(join(dir, "tsls.cmd"));
		expect(whichOnPath("tsls", { Path: dir }, "darwin")).toBe(join(dir, "tsls"));
	});
});
