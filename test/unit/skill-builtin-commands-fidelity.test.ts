/**
 * `PI_BUILTIN_COMMANDS` is hand-maintained: pi's `BUILTIN_SLASH_COMMANDS` lives
 * in `dist/core/slash-commands.js`, which the package's `exports` map does not
 * expose, so the extension cannot import it at runtime. A relative path
 * bypasses `exports`, so the test can — and locks our list to pi's: every pi
 * built-in must be in ours (a skill of that name can never be invoked bare),
 * and every extra we list must be a name interactive mode matches literally.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PI_BUILTIN_COMMANDS } from "../../extensions/skill/invoke.ts";

// The package's `exports` map hides dist/, so resolve it by path, not by specifier.
const piDist = fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/", import.meta.url));

describe("PI_BUILTIN_COMMANDS tracks pi", () => {
	it("contains every name in pi's BUILTIN_SLASH_COMMANDS", async () => {
		const mod = (await import(`${piDist}core/slash-commands.js`)) as { BUILTIN_SLASH_COMMANDS: Array<{ name: string }> };
		const missing = mod.BUILTIN_SLASH_COMMANDS.map((c) => c.name).filter((name) => !PI_BUILTIN_COMMANDS.has(name));
		expect(missing).toEqual([]);
	});

	it("lists only names interactive mode matches literally", () => {
		const source = readFileSync(`${piDist}modes/interactive/interactive-mode.js`, "utf-8");
		const literal = new Set([...source.matchAll(/text === "\/([a-z-]+)"/g)].map((m) => m[1]));
		const stale = [...PI_BUILTIN_COMMANDS].filter((name) => !literal.has(name));
		expect(stale).toEqual([]);
	});
});
