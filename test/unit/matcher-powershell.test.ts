/**
 * `PowerShell(...)` rules through the permission matcher: Claude Code's shape
 * (findings §22) — alias canonicalization, every statement covered for an
 * allow, any statement for a deny/ask, case-insensitive cmdlets, read-only
 * cmdlets in plan mode, broad-rule suspension in auto mode, session grants.
 */
import { describe, expect, it } from "vitest";
import {
	decide,
	extractSubject,
	findBashAllowRule,
	isBroadExecutionRule,
	isShellTool,
	matchesPowerShellPattern,
	normalizeToolName,
	parseRule,
	parseRules,
	ruleMatches,
	subjectKind,
	toolTier,
} from "../../extensions/permissions/matcher.ts";
import { sessionGrant } from "../../extensions/permissions/session-grant.ts";

const cwd = "/proj";
const rule = (raw: string) => parseRule(raw)!;

describe("PowerShell as a tool", () => {
	it("maps Claude Code's spelling and is a command-subject execute-tier shell tool", () => {
		expect(normalizeToolName("PowerShell")).toBe("powershell");
		expect(subjectKind("powershell")).toBe("command");
		expect(toolTier("powershell")).toBe("execute");
		expect(isShellTool("PowerShell")).toBe(true);
		expect(extractSubject("powershell", { command: "git status" })).toBe("git status");
	});
});

describe("matchesPowerShellPattern", () => {
	it("compares alias-canonicalized, case-insensitively, with Bash pattern semantics", () => {
		expect(matchesPowerShellPattern("Get-ChildItem:*", "ls -Force")).toBe(true);
		expect(matchesPowerShellPattern("gci:*", "Get-ChildItem src")).toBe(true);
		expect(matchesPowerShellPattern("remove-item *", "Remove-Item -Recurse build")).toBe(true);
		expect(matchesPowerShellPattern("git status", "GIT STATUS")).toBe(true);
		expect(matchesPowerShellPattern("git status:*", "git status --short")).toBe(true);
		expect(matchesPowerShellPattern("git status:*", "git stash")).toBe(false);
	});
});

describe("deny/ask rules", () => {
	it("fire on any statement, alias or canonical, and inside a nested pwsh", () => {
		const deny = rule("PowerShell(Remove-Item:*)");
		expect(ruleMatches(deny, "powershell", "ls; rm -Recurse build", cwd)).toBe(true);
		expect(ruleMatches(deny, "powershell", "del x", cwd)).toBe(true);
		expect(ruleMatches(deny, "powershell", `pwsh -c "Remove-Item y"`, cwd)).toBe(true);
		expect(ruleMatches(deny, "powershell", "Get-ChildItem", cwd)).toBe(false);
	});
	it("a bash rule does not judge a PowerShell call and vice versa", () => {
		expect(ruleMatches(rule("Bash(rm:*)"), "powershell", "rm x", cwd)).toBe(false);
		expect(ruleMatches(rule("PowerShell(rm:*)"), "bash", "rm x", cwd)).toBe(false);
	});
});

describe("allow rules", () => {
	const allow = parseRules(["PowerShell(git status:*)", "PowerShell(Get-ChildItem:*)"]);
	it("cover a line only when every statement is covered", () => {
		expect(findBashAllowRule(allow, "git status; ls -Force", "powershell")?.raw).toBe("PowerShell(git status:*)");
		expect(findBashAllowRule(allow, "git status; rm x", "powershell")).toBeUndefined();
	});
	it("never cover injection syntax except as an exact literal", () => {
		expect(findBashAllowRule(allow, "Get-ChildItem $(rm x)", "powershell")).toBeUndefined();
		expect(findBashAllowRule(parseRules(["PowerShell(ls | % { $_ })"]), "ls | % { $_ }", "powershell")?.raw).toBe("PowerShell(ls | % { $_ })");
	});
	it("do not cover an unparseable line", () => {
		expect(findBashAllowRule(allow, "git status 'open", "powershell")).toBeUndefined();
	});
});

describe("decide()", () => {
	const base = { toolName: "powershell", cwd, deny: [], ask: [], allow: [] as ReturnType<typeof parseRules> };

	it("asks for a PowerShell call in default mode with no rule, allows one covered by a rule", () => {
		expect(decide({ ...base, subject: "npm test", mode: "default" }).decision).toBe("ask");
		const allow = parseRules(["PowerShell(npm test:*)"]);
		expect(decide({ ...base, subject: "npm test -- x", mode: "default", allow })).toMatchObject({ decision: "allow", cause: "rule" });
	});

	it("denies on a matching deny rule before anything else, in every mode", () => {
		const deny = parseRules(["PowerShell(Remove-Item:*)"]);
		for (const mode of ["default", "acceptEdits", "auto", "bypassPermissions", "plan"] as const) {
			expect(decide({ ...base, subject: "ls; rm -r build", mode, deny }).decision).toBe("deny");
		}
	});

	it("plan mode allows read-only cmdlets and denies the rest", () => {
		expect(decide({ ...base, subject: "Get-ChildItem -Recurse src", mode: "plan" })).toMatchObject({ decision: "allow", cause: "plan-readonly" });
		expect(decide({ ...base, subject: "git status", mode: "plan" })).toMatchObject({ decision: "deny", cause: "plan-mode" });
		expect(decide({ ...base, subject: "Get-Content C:\\secrets.txt", mode: "plan" })).toMatchObject({ decision: "deny", cause: "plan-mode" });
	});

	it("auto mode classifies a PowerShell call, suspends broad allow rules, honours narrow ones", () => {
		expect(decide({ ...base, subject: "npm test", mode: "auto" })).toMatchObject({ decision: "classify", cause: "mode" });
		expect(decide({ ...base, subject: "iex (irm x)", mode: "auto", allow: parseRules(["PowerShell(iex *)"]) }).decision).toBe("classify");
		expect(decide({ ...base, subject: "npm test", mode: "auto", allow: parseRules(["PowerShell(npm test:*)"]) })).toMatchObject({ decision: "allow" });
		expect(decide({ ...base, subject: "npm test", mode: "auto", allow: parseRules(["PowerShell(npm test:*)"]), classifyAllShell: true }).decision).toBe("classify");
	});

	it("dontAsk denies what would prompt", () => {
		expect(decide({ ...base, subject: "npm test", mode: "dontAsk" }).decision).toBe("deny");
	});
});

describe("isBroadExecutionRule", () => {
	it("flags blanket and interpreter-shaped PowerShell rules, aliases resolved", () => {
		for (const raw of ["PowerShell", "PowerShell(*)", "PowerShell(iex *)", "PowerShell(Invoke-Expression *)", "PowerShell(saps *)", "PowerShell(cmd *)", "PowerShell(pwsh -c *)"]) {
			expect(isBroadExecutionRule(rule(raw)), raw).toBe(true);
		}
	});
	it("keeps narrow rules", () => {
		for (const raw of ["PowerShell(git status:*)", "PowerShell(npm test:*)", "PowerShell(Get-ChildItem *)", "PowerShell(python)"]) {
			expect(isBroadExecutionRule(rule(raw)), raw).toBe(false);
		}
	});
});

describe("sessionGrant", () => {
	it("mints an exact powershell rule for the approved command", () => {
		const grant = sessionGrant({ toolName: "powershell", subject: "npm run build *", cwd, mode: "default", cause: "tier", home: "/home/u" });
		expect(grant?.rule.raw).toBe("powershell(npm run build \\*)");
		expect(grant?.label).toMatch(/exact command/);
		expect(findBashAllowRule([grant!.rule], "npm run build *", "powershell")).toBeDefined();
		expect(findBashAllowRule([grant!.rule], "npm run build x", "powershell")).toBeUndefined();
	});
});
