/**
 * Every entry a child session loads reads the profile through its session's
 * view (lib/agents/child-extensions.ts `sessionView`). A child shares its
 * module copies with the main session, so `toolLive`, `requireText`,
 * `profileText` and the word helpers called without a live set answer for the
 * main session's tools there, and a child would be told about tools it lacks.
 * The check follows every module a child entry imports.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CHILD_EXTENSIONS, LAST_CHILD_EXTENSION } from "../../extensions/lib/agents/child-extensions.ts";
import { EXTENSIONS_DIR } from "../../extensions/lib/core/package-root.ts";

const posix = (path: string) => path.replaceAll("\\", "/");

/** Every `.ts` file under `dir`. */
function sources(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? sources(path) : name.endsWith(".ts") ? [path] : [];
	});
}

/** The modules `entry` loads: itself and everything it imports as a value, through relative imports. */
function closure(entries: string[]): Set<string> {
	const seen = new Set<string>();
	const walk = (file: string) => {
		if (seen.has(file) || !existsSync(file)) return;
		seen.add(file);
		for (const [, specifier] of readFileSync(file, "utf8").matchAll(/^(?:import|export)\s+(?!type\b)[^;]*?from\s+"(\.[^"]+)"/gms)) walk(resolve(dirname(file), specifier));
	};
	for (const entry of entries) walk(join(EXTENSIONS_DIR, entry));
	return seen;
}

/** The word helpers built for a live set: `export const x = forLive(…)` or `wordsInForce(…)`, anywhere in the base. */
const WORD_HELPERS = sources(EXTENSIONS_DIR).flatMap((file) => [...readFileSync(file, "utf8").matchAll(/export const (\w+)(?::[^\n]*?)? = (?:forLive|wordsInForce)\(/g)].map(([, name]) => name));

/**
 * Calls that take the main session's words on purpose, with the reason. A
 * helper whose builder never asks the live set is the same for every session.
 */
const ALLOWED: Readonly<Record<string, string>> = {
	"notificationWords()": "its builder never reads the live set (lib/notify/notification-words.ts)",
	"contextWords()": "its builder never reads the live set (lib/context/context-words.ts)",
	"lib/shell-run/shell-tool.ts shellResultText()": "the failure detail of a finished command names no tool",
	"lib/shell-run/shell-result.ts shellResultText()": "the exit-code line names no tool",
	"lib/shell/bash-guards.ts shellResultText()": "the worded wrapper for callers outside a session; the tool calls bashGuardBlock",
	"tools/powershell/guards.ts shellResultText()": "the worded wrapper for callers outside a session; the tool calls powershellGuardBlock",
	"tools/web-fetch/summarize.ts webFetchResultText()": "the page frame names no tool",
};

describe("the modules a child session loads", () => {
	it("finds the word helpers it checks", () => {
		for (const name of ["shellResultText", "webFetchResultText", "notebookResultText", "contextWords"]) expect(WORD_HELPERS).toContain(name);
	});

	it("never read the main session's tools or text", () => {
		const reads = new RegExp(`\\b(?:toolLive|requireText|profileText)\\(|\\b(?:${WORD_HELPERS.join("|")})\\(\\)|activeProfile\\(\\)\\.(?:live|text)\\b`, "g");
		const offenders: string[] = [];
		for (const file of closure([...CHILD_EXTENSIONS, LAST_CHILD_EXTENSION])) {
			const rel = posix(relative(EXTENSIONS_DIR, file));
			// The profile's own modules and the view itself are where the two sets are told apart.
			if (rel.startsWith("lib/profile/") || rel === "lib/agents/child-extensions.ts") continue;
			for (const call of new Set(readFileSync(file, "utf8").match(reads) ?? [])) {
				if (!(call in ALLOWED) && !(`${rel} ${call}` in ALLOWED)) offenders.push(`${rel}: ${call}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("keeps no allowance that nothing uses", () => {
		const files = [...closure([...CHILD_EXTENSIONS, LAST_CHILD_EXTENSION])];
		for (const key of Object.keys(ALLOWED)) {
			const [file, call] = key.includes(" ") ? key.split(" ") : [undefined, key];
			const used = files.some((path) => (file === undefined || posix(relative(EXTENSIONS_DIR, path)) === file) && readFileSync(path, "utf8").includes(call));
			expect(used, key).toBe(true);
		}
	});
});
