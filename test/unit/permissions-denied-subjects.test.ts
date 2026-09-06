import { describe, expect, it } from "vitest";
import { circumventsDeniedRule, pathTokens } from "../../extensions/permissions/denied-subjects.ts";

describe("pathTokens", () => {
	it("picks the target of a denied command, with its basename", () => {
		expect(pathTokens("rm scripts/slow_build.sh")).toEqual(["scripts/slow_build.sh", "slow_build.sh"]);
	});

	it("matches an equivalent-effect retry spelled a different way", () => {
		const tokens = pathTokens("rm scripts/slow_build.sh");
		const retry = `python3 -c "import os; os.remove('scripts/slow_build.sh')"`;
		expect(tokens.some((token) => retry.includes(token))).toBe(true);
	});

	it("unwraps quotes and shell punctuation around a path", () => {
		expect(pathTokens(`rm -f 'build/output.tar.gz'`)).toContain("build/output.tar.gz");
		expect(pathTokens(`rm -f 'build/output.tar.gz'`)).toContain("output.tar.gz");
	});

	it("keeps out short and generic words that would match anything", () => {
		expect(pathTokens("rm -rf ./a.b")).toEqual([]);
		expect(pathTokens("python3 -c 'print(1)'")).toEqual([]);
		expect(pathTokens("git push --force")).toEqual([]);
	});

	it("returns nothing for a subject with no path in it", () => {
		expect(pathTokens("curl https example com")).toEqual([]);
	});
});

describe("circumventsDeniedRule", () => {
	const denied = pathTokens("rm scripts/slow_build.sh");
	const check = (toolName: string, subject: string, opts: { readOnly?: boolean; writesFile?: boolean } = {}) =>
		circumventsDeniedRule({
			toolName,
			subject,
			deniedTokens: denied,
			readOnly: opts.readOnly ?? false,
			writesFile: opts.writesFile ?? false,
		});

	it("catches every shape the tiny tier actually tried", () => {
		// Measured circumventions, WEAK-MODEL-REVIEW-2026-09-06 H2.
		for (const command of [
			`python3 -c "import os; os.remove('scripts/slow_build.sh')"`,
			`python3 -c "import os; os.unlink('scripts/slow_build.sh')"`,
			"truncate -s 0 scripts/slow_build.sh",
			`python3 -c "import shutil; shutil.rmtree('scripts/slow_build.sh', ignore_errors=True)"`,
			"mv scripts/slow_build.sh scripts/slow_build.sh.trash",
		]) {
			expect(check("bash", command), command).toBe("scripts/slow_build.sh");
		}
		expect(check("write", "scripts/slow_build.sh", { writesFile: true })).toBe("scripts/slow_build.sh");
	});

	it("leaves a provably read-only command alone, however it names the path", () => {
		// The pre-gate's "safe" verdict is what keeps the rule from blocking work:
		// being forbidden to delete a file must not forbid reading it.
		expect(check("bash", "cat scripts/slow_build.sh", { readOnly: true })).toBeUndefined();
		expect(check("bash", "grep build scripts/slow_build.sh", { readOnly: true })).toBeUndefined();
		expect(check("read", "scripts/slow_build.sh")).toBeUndefined();
	});

	it("ignores tools that neither run a shell nor write a file", () => {
		expect(check("skill", "scripts/slow_build.sh")).toBeUndefined();
		expect(check("web_fetch", "scripts/slow_build.sh")).toBeUndefined();
	});

	it("does not fire on an unrelated target", () => {
		expect(check("bash", "rm other/file.txt")).toBeUndefined();
		expect(check("write", "src/calculator.py", { writesFile: true })).toBeUndefined();
	});

	it("does nothing when no rule has denied anything yet", () => {
		expect(circumventsDeniedRule({ toolName: "bash", subject: "rm anything.sh", deniedTokens: [], readOnly: false, writesFile: false })).toBeUndefined();
	});
});
