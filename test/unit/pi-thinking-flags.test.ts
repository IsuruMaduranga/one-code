/**
 * pi's `--thinking`, `--model <pattern>:<level>` and leveled `--models`
 * entries reach the tier default as "the launch set a level"
 * (lib/profile/pi-thinking-flags.ts, lib/profile/profile.ts launchThinkingFlag):
 * the copy reads the arguments as pi's own `parseArgs` does.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { launchSetsThinking, parseThinkingFlags } from "../../extensions/lib/profile/pi-thinking-flags.ts";
import { launchThinkingFlag, setLaunchArgsForTest } from "../../extensions/lib/profile/profile.ts";
import { THINKING_LEVEL_NAMES } from "../../extensions/lib/profile/thinking-defaults.ts";

/** Every flag pi's parser names, read from its source: a flag pi adds is checked without a change here. */
function piFlags(): string[] {
	const source = readFileSync(join(import.meta.dirname, "..", "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli", "args.js"), "utf8");
	const body = source.slice(source.indexOf("export function parseArgs"), source.indexOf("export function printHelp"));
	return [...new Set([...body.matchAll(/arg === "(-[A-Za-z-]+)"/g)].map((match) => match[1]))];
}

/** The thinking-related flags pi's own parser finds in `args`. */
const piParsed = (args: string[]) => {
	const { thinking, model, models } = parseArgs(args);
	return { ...(thinking ? { thinking } : {}), ...(model ? { model } : {}), ...(models ? { models } : {}) };
};

afterEach(() => setLaunchArgsForTest([]));

describe("pi's thinking flags, as the arguments carry them", () => {
	it("are read as pi's parser reads them, after every flag it knows", () => {
		const flags = piFlags();
		expect(flags.length).toBeGreaterThan(40);
		const rests = [["--thinking", "low"], ["--thinking", "lowest"], ["--model", "a/b:high"], ["--models", "a:low, b ,,c"], ["---x", "--model", "m"], ["--", "--thinking", "high"], ["--model", "--thinking"]];
		for (const flag of [...flags, "--unknown", "--unknown=x", "-u", "@file", "word"]) {
			for (const rest of rests) {
				const args = [flag, ...rest];
				expect(parseThinkingFlags(args), args.join(" ")).toEqual(piParsed(args));
			}
		}
	});

	it.each(THINKING_LEVEL_NAMES)("takes --thinking %s, the last one winning", (level) => {
		const args = ["--thinking", "off", "--thinking", level];
		expect(parseThinkingFlags(args)).toEqual(piParsed(args));
		expect(launchSetsThinking(parseThinkingFlags(args))).toBe(true);
	});
});

describe("whether the launch set the level", () => {
	it.each([
		[["--thinking", "high"], true],
		[["--thinking", "lowest"], false],
		[["--model", "openrouter/deepseek/deepseek-v4.1-flash:low"], true],
		[["--model", "anthropic/claude-opus-5-5"], false],
		// A colon that is part of the id, not a level.
		[["--model", "openrouter/qwen/qwen3.8-27b:free"], false],
		[["--model", "openrouter/qwen/qwen3.8-27b:free:max"], true],
		[["--models", "a/b,c/d:minimal"], true],
		[["--models", "a/b,c/d:free"], false],
		[["--provider", "openrouter", "--model", "x"], false],
		[["-p", "--thinking high"], false],
		[["--", "--thinking", "high"], false],
		[[], false],
	])("%j: %s", (args, expected) => {
		expect(launchSetsThinking(parseThinkingFlags(args))).toBe(expected);
	});

	it("reads the process's arguments through the profile's seam", () => {
		expect(launchThinkingFlag()).toBe(false);
		setLaunchArgsForTest(["--model", "a/b:xhigh", "-p", "hi"]);
		expect(launchThinkingFlag()).toBe(true);
		expect(launchThinkingFlag(["-p", "hi"])).toBe(false);
	});
});
