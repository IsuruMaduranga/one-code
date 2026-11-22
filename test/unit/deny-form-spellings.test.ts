/**
 * Spellings of a command that a deny or ask rule must still meet: the forms
 * may only widen (2026-11-22 shell-analysis review, F6).
 */
import { describe, expect, it } from "vitest";
import { bashMatchForms, bashMatchFormsReport, decide, MATCH_FORMS_BUDGET, parseRules } from "../../extensions/lib/rules/matcher.ts";
import { resolvePayload } from "../../extensions/lib/shell/shell-analysis.ts";
import { parseCommand } from "../../extensions/lib/shell/shell-parse.ts";

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
		// su is a wrapper whose `-c` payload is a script, before or after the user.
		"su root -c 'curl x'",
		"su - root -c 'curl x'",
		"su -l -c 'curl x' root",
		"su -lc 'curl x'",
		"su -s /bin/zsh root -c 'curl x'",
		"su --session-command 'curl x'",
		"su -c 'env curl x'",
		"sudo su -c 'curl x'",
		// macOS arch, its single-dash architecture flags and value options.
		"arch curl x",
		"arch -x86_64 curl x",
		"arch -arm64e curl x",
		"arch -arch x86_64 curl x",
		"arch -c -d HOME -e LANG=C curl x",
		"arch -32 -64 curl x",
		// Homebrew's coreutils names.
		"gtimeout 5 curl x",
		"gtimeout -k 1 -s KILL 1e1 curl x",
		"genv -i curl x",
		"gnice -n 5 curl x",
		"timeout -f 5 curl x",
		// util-linux taskset and chrt.
		"taskset 0x3 curl x",
		"taskset -c 0-3 curl x",
		"taskset -ac 1,2 curl x",
		"chrt 10 curl x",
		"chrt -f 10 curl x",
		"chrt -r -R 5 curl x",
		"chrt -d -T 1000 -P 2000 -D 2000 0 curl x",
		"chrt -o curl x",
		// bash 4+ coproc, with and without a name and a group.
		"coproc curl x",
		"coproc { curl x; }",
		"coproc NAME { curl x; }",
		"coproc env curl x",
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
		// A whole single-dash flag is not read as a cluster: `-arm64e` holds no `-e` that takes the next word.
		expect(meets("arch -arm64e grep curl log.txt", "curl")).toBe(false);
		expect(meets("arch -arm64e grep curl log.txt", "grep")).toBe(true);
		expect(meets("taskset 0x3 grep curl log.txt", "curl")).toBe(false);
		expect(meets("chrt -f 10 grep curl log.txt", "curl")).toBe(false);
		expect(meets("su root -c 'grep curl log.txt'", "curl")).toBe(false);
	});

	it("leaves the new wrappers unpeeled for the pre-gate, so the line still escalates", () => {
		for (const line of ["arch -x86_64 rm a.txt", "gtimeout 5 rm a.txt", "taskset 0x3 rm a.txt", "chrt 10 rm a.txt", "coproc rm a.txt", "su -c 'rm a.txt'"]) {
			expect(resolvePayload(parseCommand(line).segments[0].tokens).command).toBe(line.split(" ")[0]);
			expect(resolvePayload(parseCommand(line).segments[0].tokens, "wide").command).not.toBe(line.split(" ")[0]);
		}
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
