import { describe, expect, it } from "vitest";
import { requireText } from "../../extensions/lib/profile/profile.ts";
import { powershellGuardReason, startSleepSeconds } from "../../extensions/powershell/guards.ts";

describe("startSleepSeconds", () => {
	it("reads positional, -Seconds, -s and -Milliseconds forms", () => {
		expect(startSleepSeconds("Start-Sleep 5")).toBe(5);
		expect(startSleepSeconds("Start-Sleep -Seconds 30")).toBe(30);
		expect(startSleepSeconds("Start-Sleep -s 1")).toBe(1);
		expect(startSleepSeconds("Start-Sleep -Milliseconds 500")).toBe(0.5);
		expect(startSleepSeconds("Start-Sleep -Seconds:3")).toBe(3);
	});
	it("is undefined for non-literal or TimeSpan arguments", () => {
		expect(startSleepSeconds("Start-Sleep $delay")).toBeUndefined();
		expect(startSleepSeconds("Start-Sleep -Duration ([TimeSpan]::FromSeconds(3))")).toBeUndefined();
		expect(startSleepSeconds("Start-Sleep")).toBeUndefined();
	});
});

describe("powershellGuardReason", () => {
	const fg = { background: false };
	const shell = requireText("shell");
	const sleep = (shown: string, rest?: string) =>
		shell.blocked({ kind: "sleep", shown, ...(rest ? { rest } : {}), sleepName: "Start-Sleep", untilExample: "while (-not (<check>)) { Start-Sleep 2 }" });
	it("blocks a leading Start-Sleep (and the sleep alias) that is not provably short", () => {
		expect(powershellGuardReason("Start-Sleep -Seconds 30", fg)).toBe(sleep("Start-Sleep -Seconds 30"));
		expect(powershellGuardReason("sleep 10; npm test", fg)).toBe(sleep("sleep 10", "npm test"));
		expect(powershellGuardReason("Start-Sleep 1; Start-Sleep 1; ls", fg)).toBe(sleep("Start-Sleep 1; Start-Sleep 1", "ls"));
		expect(powershellGuardReason("Start-Sleep $n", fg)).toBe(sleep("Start-Sleep $n"));
	});
	it("passes a single short pacing sleep, a sleep deeper in the chain, and background runs", () => {
		expect(powershellGuardReason("Start-Sleep -Milliseconds 500; ls", fg)).toBeUndefined();
		expect(powershellGuardReason("npm run build; Start-Sleep 30", fg)).toBeUndefined();
		expect(powershellGuardReason("Start-Sleep 60", { background: true })).toBeUndefined();
	});
	it("blocks interactive cmdlets and interactive git in either mode", () => {
		expect(powershellGuardReason("Read-Host 'name'", fg)).toBe(shell.blocked({ kind: "consolePrompt", command: "read-host" }));
		expect(powershellGuardReason("ls | Out-GridView", { background: true })).toBe(shell.blocked({ kind: "consolePrompt", command: "out-gridview" }));
		const rebase = shell.blocked({ kind: "rebaseInteractive", shell: "powershell" });
		const add = shell.blocked({ kind: "addInteractive" });
		expect(powershellGuardReason("git rebase -i HEAD~3", fg)).toBe(rebase);
		expect(powershellGuardReason("git add -p", fg)).toBe(add);
		// git's value-taking global flags precede the subcommand (code-review fix).
		expect(powershellGuardReason("git -C C:\\repo rebase -i HEAD~3", fg)).toBe(rebase);
		expect(powershellGuardReason("git -c core.pager=cat add --patch", fg)).toBe(add);
	});
	it("passes ordinary and unparseable lines", () => {
		expect(powershellGuardReason("git status; npm test", fg)).toBeUndefined();
		expect(powershellGuardReason("echo 'open", fg)).toBeUndefined();
	});
});
