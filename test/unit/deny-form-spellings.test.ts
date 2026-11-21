/**
 * Spellings of a command that a deny or ask rule must still meet: the forms
 * may only widen (2026-11-22 shell-analysis review, F6).
 */
import { describe, expect, it } from "vitest";
import { bashMatchForms } from "../../extensions/lib/rules/matcher.ts";

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
		`bash -c '"$@"' _ curl x`,
		"su -c 'curl x'",
		"su root --command='curl x'",
	])("%s", (line) => {
		expect(meets(line, "curl")).toBe(true);
	});

	it("adds no curl form to a line that runs none", () => {
		expect(meets("timeout 5 cat a.txt", "curl")).toBe(false);
		expect(meets("echo {a,b}", "curl")).toBe(false);
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
