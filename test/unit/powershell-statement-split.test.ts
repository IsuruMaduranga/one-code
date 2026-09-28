/**
 * The PowerShell statement split and its three consumers: the read-only
 * check, allow-rule coverage and deny/ask match forms. Every split expectation
 * here is what pwsh 7.6's own parser (`[Parser]::ParseInput`) returns for the
 * same line: a single `&` is the background operator and the next statement
 * runs at once, a lone carriage return ends a statement (and starts a line for
 * a here-string closer), the typographic quotes are quotes, and `<# … #>` at a
 * token start is a comment.
 */
import { describe, expect, it } from "vitest";
import { decide, findBashAllowRule, parseRules, ruleMatches } from "../../extensions/permissions/matcher.ts";
import {
	powershellInjectionSyntax,
	powershellMatchForms,
	powershellStatements,
} from "../../extensions/permissions/powershell-rules.ts";
import { HAVE_POWERSHELL, psParse, psReadOnly, POWERSHELL_TEST_TIMEOUT } from "./helpers/powershell-parse.ts";

const cwd = "/proj";

/** Lines pwsh runs as a read-only cmdlet followed by `Remove-Item`. */
const HIDDEN_WRITES: Array<[string, string]> = [
	["a background &", "Get-ChildItem & Remove-Item x"],
	["& inside a word", "Write-Output a&Remove-Item x"],
	["& after a redirection", "Get-ChildItem x 2>&1 & Remove-Item y"],
	["a lone carriage return", "Get-ChildItem x\rRemove-Item y"],
	["a here-string closed after a lone CR", "Write-Output @'\r x\r'@\rRemove-Item y"],
	["typographic single quotes", "Get-Content 'x’ ; Remove-Item y ; ‘z'"],
	["typographic double quotes", 'Get-Content "x” ; Remove-Item y ; “z"'],
	["a block comment hiding a quote", "Get-ChildItem <# ' #> ; Remove-Item x ; <# ' #>"],
];

describe("powershellStatements", () => {
	it.each(HIDDEN_WRITES)("splits off the hidden statement after %s", (_label, line) => {
		const statements = powershellStatements(line) ?? [];
		expect(statements.some((s) => /^Remove-Item\b/.test(s))).toBe(true);
	});

	it("keeps the call operator, redirections and doubled quotes whole", () => {
		expect(powershellStatements("& foo bar")).toEqual(["& foo bar"]);
		expect(powershellStatements("Get-ChildItem | & foo")).toEqual(["Get-ChildItem", "& foo"]);
		expect(powershellStatements("git status 2>&1")).toEqual(["git status 2>&1"]);
		expect(powershellStatements("Get-ChildItem x *>&1")).toEqual(["Get-ChildItem x *>&1"]);
		expect(powershellStatements("Write-Output 'a''; Remove-Item y'")).toEqual(["Write-Output 'a''; Remove-Item y'"]);
		expect(powershellStatements("Write-Output 'a’’; Remove-Item y'")).toHaveLength(1);
		expect(powershellStatements('Write-Output "a`"; Remove-Item y"')).toHaveLength(1);
		expect(powershellStatements("Write-Output a<#b#>c")).toEqual(["Write-Output a<#b#>c"]);
	});

	it("splits CRLF lines once per line", () => {
		expect(powershellStatements("Get-ChildItem\r\nRemove-Item y")).toEqual(["Get-ChildItem", "Remove-Item y"]);
		expect(powershellStatements("Write-Output @'\r\nx\r\n'@\r\nRemove-Item y")).toEqual(["Write-Output @'\r\nx\r\n'@", "Remove-Item y"]);
	});

	it("fails on an unterminated block comment or here-string", () => {
		expect(powershellStatements("Get-ChildItem <# x")).toBeUndefined();
		expect(powershellStatements("Write-Output @'\nx\n")).toBeUndefined();
	});
});

describe("the read-only check", { timeout: POWERSHELL_TEST_TIMEOUT }, () => {
	it.skipIf(!HAVE_POWERSHELL).each(HIDDEN_WRITES)("is not read-only with %s", async (_label, line) => {
		expect((await psReadOnly(line, { cwd, home: "/home/u" })).readOnly).toBe(false);
	});

	it.skipIf(!HAVE_POWERSHELL)("reads a control character as PowerShell does: never read-only with a writer behind it", { timeout: POWERSHELL_TEST_TIMEOUT }, async () => {
		// PowerShell's parse is exact: a character it reads as whitespace leaves
		// one command, and one it reads as a separator makes `Remove-Item` a
		// command of its own, which is not read-only.
		for (const ch of ["\u000b", "\u000c", "\u001b", "\u007f", "\u0085", "\u2028", "\u2029", "\u00a0"]) {
			const line = `Get-ChildItem${ch}Remove-Item x`;
			const commands = (await psParse(line)).nodes.filter((n) => n.type === "CommandAst").map((n) => n.name);
			const { readOnly } = await psReadOnly(line, { cwd, home: "/home/u" });
			expect(readOnly && commands.includes("Remove-Item"), JSON.stringify(ch)).toBe(false);
		}
		expect((await psReadOnly("Get-ChildItem\tsrc", { cwd, home: "/home/u" })).readOnly).toBe(true);
	});

	it.skipIf(!HAVE_POWERSHELL)("judges the path inside typographic quotes, which PowerShell unquotes", { timeout: POWERSHELL_TEST_TIMEOUT }, async () => {
		expect(await psReadOnly("Get-Content ‘~/.ssh/id_rsa’", { cwd, home: "/home/u" })).toMatchObject({ readOnly: false, reason: "a credential or secret path" });
	});

	it.skipIf(!HAVE_POWERSHELL)("reads a typographic dash as a parameter dash", { timeout: POWERSHELL_TEST_TIMEOUT }, async () => {
		expect((await psReadOnly("Get-Process –ComputerName h", { cwd, home: "/home/u" })).readOnly).toBe(false);
		expect((await psReadOnly("Get-Process —cn h", { cwd, home: "/home/u" })).readOnly).toBe(false);
	});

	it("does not approve the line in any mode through decide()", () => {
		const base = { toolName: "powershell", cwd, deny: [], ask: [], allow: [] };
		expect(decide({ ...base, subject: "Get-ChildItem & Remove-Item x", mode: "default" }).decision).toBe("ask");
		expect(decide({ ...base, subject: "Get-ChildItem & Remove-Item x", mode: "plan" }).decision).toBe("deny");
		expect(decide({ ...base, subject: "Get-ChildItem\rRemove-Item x", mode: "auto" }).decision).toBe("classify");
	});
});

describe("allow rules", () => {
	const allow = parseRules(["PowerShell(Get-ChildItem:*)", "PowerShell(Get-Content:*)", "PowerShell(Write-Output:*)"]);
	it.each(HIDDEN_WRITES)("do not cover the hidden statement after %s", (_label, line) => {
		expect(findBashAllowRule(allow, line, "powershell")).toBeUndefined();
	});
	it("do not cover a line with a control character", () => {
		expect(powershellInjectionSyntax("Get-ChildItem\u0085x")).toBe("a control character");
		expect(findBashAllowRule(allow, "Get-ChildItem x", "powershell")).toBeUndefined();
	});
	it("still cover the call-free and redirected forms", () => {
		expect(findBashAllowRule(parseRules(["PowerShell(git status:*)"]), "git status 2>&1", "powershell")?.raw).toBe("PowerShell(git status:*)");
	});
});

describe("deny rules", () => {
	const deny = parseRules(["PowerShell(Remove-Item:*)"])[0];
	it.each(HIDDEN_WRITES)("fire on the hidden statement after %s", (_label, line) => {
		expect(ruleMatches(deny, "powershell", line, cwd)).toBe(true);
	});
	it("fire inside a subexpression, a script block and a line the lexer cannot read", () => {
		expect(ruleMatches(deny, "powershell", 'Write-Output "$(Remove-Item x)"', cwd)).toBe(true);
		expect(ruleMatches(deny, "powershell", "Get-ChildItem | ForEach-Object { rm $_ }", cwd)).toBe(true);
		expect(ruleMatches(deny, "powershell", "Get-ChildItem ; Remove-Item x <# open", cwd)).toBe(true);
		expect(powershellMatchForms("Get-ChildItem ; Remove-Item x <# open")).toContain("Remove-Item x <# open");
	});
	it("do not fire on an unrelated line", () => {
		expect(ruleMatches(deny, "powershell", "Get-ChildItem & Get-Content x", cwd)).toBe(false);
	});
});
