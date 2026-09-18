import { describe, expect, it } from "vitest";
import { powershellPathTokens, safetyControlWrite } from "../../extensions/auto-mode/safety-floor.ts";

const home = "/home/u";
const cwd = "/home/u/proj";
const floor = (command: string) => safetyControlWrite({ toolName: "powershell", input: { command }, cwd, home });

describe("powershellPathTokens", () => {
	it("extracts path-shaped tokens, expanding $env:USERPROFILE, $HOME and ~, forward-slashed", () => {
		expect(powershellPathTokens(`Set-Content -Path "$env:USERPROFILE\\.claude\\settings.json" '{}'`, home)).toEqual(["/home/u/.claude/settings.json"]);
		expect(powershellPathTokens("Get-Content ~/.onecode/settings.json | Out-Null", home)).toEqual(["/home/u/.onecode/settings.json"]);
		expect(powershellPathTokens("Set-Content -Path:.claude\\settings.local.json x", home)).toEqual([".claude/settings.local.json"]);
		expect(powershellPathTokens("git status; npm test", home)).toEqual([]);
	});
});

describe("safetyControlWrite for powershell", () => {
	it("stops any command line that names a gate-control file, read or write", () => {
		expect(floor(`Set-Content -Path "$env:USERPROFILE\\.claude\\settings.json" -Value '{}'`)).toMatch(/permission rules and auto-mode configuration/);
		expect(floor("Add-Content .claude/settings.local.json '{}'")).toBeDefined();
		expect(floor("Get-Content ~/.onecode/settings.json")).toBeDefined();
		expect(floor("Remove-Item ~/.claude.json")).toBeDefined();
	});
	it("lets ordinary work through", () => {
		expect(floor("git status; npm test")).toBeUndefined();
		expect(floor("Set-Content src/config.json '{}'")).toBeUndefined();
		expect(floor("Get-Content package.json")).toBeUndefined();
	});
});
