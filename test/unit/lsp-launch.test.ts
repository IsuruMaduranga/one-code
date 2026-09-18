import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isBatchFile, quoteForCmd, serverLaunch } from "../../extensions/lsp/launch.ts";

/**
 * npm installs a language server on Windows as a `.cmd` shim, which a bare
 * spawn cannot start (findings §22): the launch resolver routes such a shim
 * through cmd.exe and leaves everything else alone. Pure, so pinned on every
 * platform with an injected PATH lookup.
 */
describe("serverLaunch", () => {
	const env = { PATH: "C:\\npm", SystemRoot: "C:\\Windows" };
	const which = (command: string) =>
		command === "typescript-language-server" ? "C:\\npm\\typescript-language-server.CMD" : command === "gopls" ? "C:\\Go\\bin\\gopls.exe" : undefined;

	it("starts a .cmd shim through cmd.exe with the command line quoted once", () => {
		const launch = serverLaunch("typescript-language-server", ["--stdio"], env, { platform: "win32", which });
		expect(launch).toEqual({
			command: join("C:\\Windows", "System32", "cmd.exe"),
			args: ["/d", "/s", "/c", '"C:\\npm\\typescript-language-server.CMD --stdio"'],
			windowsVerbatimArguments: true,
		});
	});

	it("quotes a shim path or argument that holds spaces", () => {
		const spaced = (command: string) => (command === "srv" ? "C:\\Program Files\\srv\\srv.cmd" : undefined);
		const launch = serverLaunch("srv", ["--log", "C:\\My Logs\\a.log", "plain"], env, { platform: "win32", which: spaced });
		expect(launch.args[3]).toBe('"\"C:\\Program Files\\srv\\srv.cmd\" --log \"C:\\My Logs\\a.log\" plain"');
	});

	it("spawns a real executable by its resolved path, and an unresolvable command as given (the ENOENT carries the hint)", () => {
		expect(serverLaunch("gopls", ["serve"], env, { platform: "win32", which })).toEqual({ command: "C:\\Go\\bin\\gopls.exe", args: ["serve"] });
		expect(serverLaunch("pyright-langserver", ["--stdio"], env, { platform: "win32", which })).toEqual({ command: "pyright-langserver", args: ["--stdio"] });
	});

	it("changes nothing off Windows", () => {
		expect(serverLaunch("typescript-language-server", ["--stdio"], env, { platform: "darwin", which })).toEqual({
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
});
