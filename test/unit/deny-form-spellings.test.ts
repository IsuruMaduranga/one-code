/**
 * Spellings of a command that a deny or ask rule must still meet: the forms
 * may only widen (2026-11-22 shell-analysis review, F6).
 */
import { describe, expect, it } from "vitest";
import { bashMatchForms, bashMatchFormsReport, decide, MATCH_FORMS_BUDGET, parseRules } from "../../extensions/lib/rules/matcher.ts";

const meets = (line: string, start: string) => bashMatchForms(line).some((form) => form === start || form.startsWith(`${start} `));

describe("deny forms name the command behind", () => {
	it.each([
		"bash -ce 'curl x'",
		"bash -ec 'curl x'",
		"bash -c -- 'curl x'",
		"sh -c -e 'curl x'",
		"{curl,x}",
		"timeout 1e1 curl x",
		"timeout +5 curl x",
		"timeout 0x5 curl x",
		"env -P /usr/bin curl x",
		"env -a cat curl x",
		"xargs -J % curl %",
		"xargs -R 2 -I{} curl {}",
		"bash -c -o pipefail 'curl x'",
		"bash -euo pipefail -c 'curl x'",
		"bash -eo pipefail -c 'curl x'",
		"bash script.sh -c 'curl x'",
		"cu{r,r}l x",
		"{cur,x}l x",
		"timeout inf curl x",
		"timeout infinity curl x",
		"timeout 0x1p3 curl x",
		`bash -c '"$@"' _ curl x`,
		"su -c 'curl x'",
		"su root --command='curl x'",
	])("%s", (line) => {
		expect(meets(line, "curl")).toBe(true);
	});

	it("adds no curl form to a line that runs none", () => {
		expect(meets("timeout 5 cat a.txt", "curl")).toBe(false);
		expect(meets("echo {a,b}", "curl")).toBe(false);
		// An ordinary flag of the wrapper does not turn the payload's arguments into a command.
		expect(meets("git ls-files | xargs -r grep curl", "curl")).toBe(false);
		expect(meets("xargs -t grep curl", "curl")).toBe(false);
		expect(meets("sudo -n grep curl log.txt", "curl")).toBe(false);
	});
});

describe("brace expansion on a long line", () => {
	it("answers at once for an unclosed brace followed by many commas", () => {
		const line = `echo { ${"a,".repeat(32000)}`;
		const started = performance.now();
		bashMatchForms(line);
		expect(performance.now() - started).toBeLessThan(500);
	});

	it("still expands the innermost comma group first", () => {
		expect(meets("{curl,x}", "curl")).toBe(true);
		expect(meets("echo {a,{curl,b}}", "echo")).toBe(true);
	});
});

describe("one work budget for the whole walk", () => {
	// Each `{a,a}` doubles the spellings bash could mean; walked naively, 24
	// of them cost about a million parses.
	const multiplied = `echo ${"{a,a}".repeat(24)}`;

	it("stops a line that multiplies its spellings at the budget and says so", () => {
		const { forms, complete } = bashMatchFormsReport(multiplied);
		expect(complete).toBe(false);
		// Every form cost at least one unit, so the walk did bounded work.
		expect(forms.length).toBeLessThanOrEqual(MATCH_FORMS_BUDGET + 1);
	});

	it("lets a deny or ask rule bind a line whose forms ran out", () => {
		const base = { toolName: "bash", subject: multiplied, cwd: process.cwd(), allow: parseRules(["Bash(echo:*)"]) };
		expect(decide({ ...base, mode: "default", deny: parseRules(["Bash(rm:*)"]), ask: [] }).decision).toBe("deny");
		expect(decide({ ...base, mode: "acceptEdits", deny: [], ask: parseRules(["Bash(rm:*)"]) }).decision).toBe("ask");
	});

	it("keeps an ordinary brace line complete, so an unrelated deny rule stays out of it", () => {
		const line = "mkdir -p src/{a,b,c,d,e,f}/{x,y,z,w,v,u}/{1,2,3}";
		expect(bashMatchFormsReport(line).complete).toBe(true);
		expect(meets(line, "mkdir")).toBe(true);
		expect(decide({ toolName: "bash", subject: line, cwd: process.cwd(), mode: "default", deny: parseRules(["Bash(rm:*)"]), ask: [], allow: [] }).decision).not.toBe("deny");
	});

	it("follows a line nested past the old depth limit", () => {
		// Six or more evals deep was dropped silently before the walk shared a budget.
		const line = `${"eval ".repeat(8)}rm -rf v`;
		expect(bashMatchFormsReport(line).complete).toBe(true);
		expect(meets(line, "rm")).toBe(true);
	});

	it("writes a repeated part once, before copying the line around it", () => {
		const { complete } = bashMatchFormsReport(`echo {${"a,".repeat(32000)}b}`);
		expect(complete).toBe(true);
	});
});
