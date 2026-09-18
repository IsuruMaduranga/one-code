import { describe, expect, it } from "vitest";
import { powershellQuote, rewriteToolInput } from "../../extensions/worktree/rewrite.ts";

describe("rewriteToolInput for powershell", () => {
	it("prefixes a Set-Location into the worktree and returns the original command", () => {
		const input: Record<string, unknown> = { command: "git status" };
		const { originalCommand } = rewriteToolInput("powershell", input, "C:\\repo\\.claude\\worktrees\\wt-1");
		expect(originalCommand).toBe("git status");
		expect(input.command).toBe("Set-Location -LiteralPath 'C:\\repo\\.claude\\worktrees\\wt-1' -ErrorAction Stop; git status");
	});
	it("escapes a single quote in the path the PowerShell way", () => {
		expect(powershellQuote("/tmp/o'neil")).toBe("'/tmp/o''neil'");
	});
	it("leaves a call without a command alone", () => {
		expect(rewriteToolInput("powershell", {}, "/wt")).toEqual({});
	});
});
