import { describe, expect, it } from "vitest";
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
	it("blocks a leading Start-Sleep (and the sleep alias) that is not provably short", () => {
		expect(powershellGuardReason("Start-Sleep -Seconds 30", fg)).toMatch(/Blocked: standalone `Start-Sleep -Seconds 30`/);
		expect(powershellGuardReason("sleep 10; npm test", fg)).toMatch(/followed by: npm test/);
		expect(powershellGuardReason("Start-Sleep 1; Start-Sleep 1; ls", fg)).toMatch(/Blocked/);
		expect(powershellGuardReason("Start-Sleep $n", fg)).toMatch(/Blocked/);
	});
	it("passes a single short pacing sleep, a sleep deeper in the chain, and background runs", () => {
		expect(powershellGuardReason("Start-Sleep -Milliseconds 500; ls", fg)).toBeUndefined();
		expect(powershellGuardReason("npm run build; Start-Sleep 30", fg)).toBeUndefined();
		expect(powershellGuardReason("Start-Sleep 60", { background: true })).toBeUndefined();
	});
	it("blocks interactive cmdlets and interactive git in either mode", () => {
		expect(powershellGuardReason("Read-Host 'name'", fg)).toMatch(/read-host/);
		expect(powershellGuardReason("ls | Out-GridView", { background: true })).toMatch(/out-gridview/);
		expect(powershellGuardReason("git rebase -i HEAD~3", fg)).toMatch(/git rebase -i/);
		expect(powershellGuardReason("git add -p", fg)).toMatch(/interactive `git add`/);
		// git's value-taking global flags precede the subcommand (code-review fix).
		expect(powershellGuardReason("git -C C:\\repo rebase -i HEAD~3", fg)).toMatch(/git rebase -i/);
		expect(powershellGuardReason("git -c core.pager=cat add --patch", fg)).toMatch(/interactive `git add`/);
	});
	it("passes ordinary and unparseable lines", () => {
		expect(powershellGuardReason("git status; npm test", fg)).toBeUndefined();
		expect(powershellGuardReason("echo 'open", fg)).toBeUndefined();
	});
});
