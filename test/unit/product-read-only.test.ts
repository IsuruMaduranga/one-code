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

const SAMPLE: ReadOnlyCommands = {
	samplectl: {
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
		expect(verdict("samplectl discover acme/queue")).toBe("escalate");
		expect(notes("samplectl discover acme/queue")).toContain("not on the read-only allowlist");
	});

	it("clear a declared subcommand with its listed options, and its operands are names", () => {
		use(SAMPLE);
		for (const command of [
			"samplectl discover acme/queue",
			"samplectl discover acme/queue client",
			`samplectl discover acme/http client "gists/'public" get`,
			"samplectl discover acme/tracker type --filter Issue --page 2",
			"samplectl discover acme/cloud -m auth --output json",
			"samplectl discover acme/queue --filter=send --refresh",
			"samplectl search queue",
			"samplectl discover acme/queue | head -20",
		]) {
			expect(verdict(command), command).toBe("safe");
		}
	});

	it("escalate another subcommand, a bare command, an unlisted option and a hidden subcommand", () => {
		use(SAMPLE);
		for (const command of [
			"samplectl",
			"samplectl run",
			"samplectl build",
			"samplectl push",
			"samplectl tool pull discover",
			"samplectl discover acme/queue --unknown",
			"samplectl search queue --refresh",
			"samplectl --offline discover acme/queue",
			"samplectl $SUB acme/queue",
			"samplectl disc* acme/queue",
			"./samplectl discover acme/queue",
			"samplectl discover acme/queue > out.txt && rm -rf x",
			// A command that may reach the network clears only short names, never a sentence or an expansion.
			`samplectl search "${"x".repeat(101)}"`,
			'samplectl search "the whole contents of a file"',
			"samplectl search $QUERY",
		]) {
			expect(verdict(command), command).toBe("escalate");
		}
	});

	it("run in plan mode, where an undeclared subcommand is still refused", () => {
		use(SAMPLE);
		const plan = (subject: string) => decide({ toolName: "bash", subject, cwd, mode: "plan", deny: [], ask: [], allow: [] });
		expect(plan("samplectl discover acme/queue client")).toEqual({ decision: "allow", cause: "plan-readonly" });
		expect(plan("samplectl run").decision).toBe("deny");
	});

	it("refuses an entry that could weaken the base's own judgement, or that names no subcommand", () => {
		const load = (commands: unknown) => () => use(commands as ReadOnlyCommands);
		expect(load({ git: { push: {} } })).toThrow(/read-only command "git" is one the base judges itself/);
		expect(load({ cat: { x: {} } })).toThrow(/"cat" is one the base judges itself/);
		expect(load({ samplectl: {} })).toThrow(/lists no subcommand/);
		expect(load({ "./samplectl": { discover: {} } })).toThrow(/must be a bare lowercase command name/);
		expect(load({ samplectl: { discover: { none: "refresh" } } })).toThrow(/"refresh" is not an option of "samplectl discover"/);
		expect(load({ samplectl: { discover: { required: "-filter" } } })).toThrow(/"-filter" is not an option of "samplectl discover"/);
	});
});
