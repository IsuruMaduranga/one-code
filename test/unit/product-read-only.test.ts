/**
 * Read-only commands a profile declares (lib/shell/product-read-only.ts):
 * the pre-gate treats a declared subcommand with only its listed options as
 * a read, and everything else about the command escalates as before.
 */
import { homedir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { setActiveProfileForTest } from "../../extensions/lib/profile/profile.ts";
import { decide } from "../../extensions/lib/rules/matcher.ts";
import type { ReadOnlyCommands } from "../../extensions/lib/shell/product-read-only.ts";
import { analyzeShellCommand } from "../../extensions/lib/shell/shell-analysis.ts";
import { useProfile } from "./helpers/profile.ts";

const BAL: ReadOnlyCommands = {
	bal: {
		discover: { none: "--refresh", required: "--output --filter --page -m --module --version" },
		search: {},
	},
};
const use = (readOnlyCommands: ReadOnlyCommands) => useProfile({ readOnlyCommands });
const cwd = process.cwd();
const verdict = (command: string) => analyzeShellCommand({ command, cwd, home: homedir() }).verdict;
const notes = (command: string) => analyzeShellCommand({ command, cwd, home: homedir() }).notes.join("; ");

afterEach(() => setActiveProfileForTest(undefined));

describe("a profile's read-only commands", () => {
	it("are not read-only until declared", () => {
		expect(verdict("bal discover ballerinax/kafka")).toBe("escalate");
		expect(notes("bal discover ballerinax/kafka")).toContain("not on the read-only allowlist");
	});

	it("clear a declared subcommand with its listed options, and its operands are names", () => {
		use(BAL);
		for (const command of [
			"bal discover ballerinax/kafka",
			"bal discover ballerinax/kafka client",
			`bal discover ballerina/http client "gists/'public" get`,
			"bal discover ballerinax/github type --filter Issue --page 2",
			"bal discover ballerinax/aws -m auth --output json",
			"bal discover ballerinax/kafka --filter=send --refresh",
			"bal search kafka",
			"bal discover ballerinax/kafka | head -20",
		]) {
			expect(verdict(command), command).toBe("safe");
		}
	});

	it("escalate another subcommand, a bare command, an unlisted option and a hidden subcommand", () => {
		use(BAL);
		for (const command of [
			"bal",
			"bal run",
			"bal build",
			"bal push",
			"bal tool pull discover",
			"bal discover ballerinax/kafka --unknown",
			"bal search kafka --refresh",
			"bal --offline discover ballerinax/kafka",
			"bal $SUB ballerinax/kafka",
			"bal disc* ballerinax/kafka",
			"./bal discover ballerinax/kafka",
			"bal discover ballerinax/kafka > out.txt && rm -rf x",
		]) {
			expect(verdict(command), command).toBe("escalate");
		}
	});

	it("run in plan mode, where an undeclared subcommand is still refused", () => {
		use(BAL);
		const plan = (subject: string) => decide({ toolName: "bash", subject, cwd, mode: "plan", deny: [], ask: [], allow: [] });
		expect(plan("bal discover ballerinax/kafka client")).toEqual({ decision: "allow", cause: "plan-readonly" });
		expect(plan("bal run").decision).toBe("deny");
	});

	it("refuses an entry that could weaken the base's own judgement, or that names no subcommand", () => {
		const load = (commands: unknown) => () => use(commands as ReadOnlyCommands);
		expect(load({ git: { push: {} } })).toThrow(/read-only command "git" is one the base judges itself/);
		expect(load({ cat: { x: {} } })).toThrow(/"cat" is one the base judges itself/);
		expect(load({ bal: {} })).toThrow(/lists no subcommand/);
		expect(load({ "./bal": { discover: {} } })).toThrow(/must be a bare lowercase command name/);
		expect(load({ bal: { discover: { none: "refresh" } } })).toThrow(/"refresh" is not an option of "bal discover"/);
	});
});
