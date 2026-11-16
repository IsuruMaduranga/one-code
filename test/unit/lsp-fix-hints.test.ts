/**
 * Fix hints a profile declares for its own language server
 * (tools/lsp/fix-hints.ts): looked up by code, then by plain message
 * substring; shown once each, after the diagnostics' own caps and cut, in the
 * profile's words; and with none declared, the text is exactly what it was.
 */
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { type FixHints, fixHintFor, MAX_FIX_HINTS, withFixHints } from "../../extensions/tools/lsp/fix-hints.ts";
import { formatDiagnostics, type LspDiagnostic } from "../../extensions/tools/lsp/format.ts";
import { lspResultText, type LspText } from "../../extensions/tools/lsp/text.ts";
import { formatNewDiagnostics, MAX_CHARS } from "../../extensions/tools/lsp/watcher.ts";
import { languageServerProblems, MAX_FIX_HINT_LENGTH } from "../../extensions/lib/profile/language-servers.ts";
import { activeProfile, setActiveProfileForTest } from "../../extensions/lib/profile/profile.ts";
import type { TextEnv } from "../../extensions/lib/profile/profile-contract.ts";
import { useProfile } from "./helpers/profile.ts";

// Captured before any test puts its own profile in force.
const shipped = activeProfile();
afterEach(() => setActiveProfileForTest(undefined));

const PROJECT = resolve("/project");
const uri = (name: string) => pathToFileURL(join(PROJECT, name)).href;
const diag = (message: string, extra: Partial<LspDiagnostic> = {}): LspDiagnostic => ({ message, severity: 1, range: { start: { line: 0, character: 0 } }, ...extra });

const HINTS: FixHints = {
	byCode: new Map([
		["BCE2066", "Declare the variable before use."],
		["42", "A numeric code, matched by its decimal spelling."],
	]),
	byMessage: [
		["undefined module", "Add the import for the module."],
		["a.b", "Never a pattern: matches the literal text only."],
		["module", "Second substring: never reached when the first matched."],
	],
};
const WORDS: NonNullable<LspText["fixHints"]> = { heading: "Fix hints:", line: ({ key, hint }) => `${key}: ${hint}` };

describe("a fix hint", () => {
	it("is looked up by the code, stringified, then by the first message substring", () => {
		expect(fixHintFor(diag("x", { code: "BCE2066" }), HINTS)).toEqual({ key: "BCE2066", hint: "Declare the variable before use." });
		expect(fixHintFor(diag("x", { code: 42 }), HINTS)?.key).toBe("42");
		// A code without a hint falls back to the message.
		expect(fixHintFor(diag("undefined module 'http'", { code: "OTHER" }), HINTS)).toEqual({ key: "undefined module", hint: "Add the import for the module." });
		expect(fixHintFor(diag("value axb"), HINTS)).toBeUndefined();
		expect(fixHintFor(diag("value a.b"), HINTS)?.key).toBe("a.b");
		expect(fixHintFor(diag("nothing to match"), HINTS)).toBeUndefined();
	});

	it("leaves the diagnostics as they were when the server declares none, or none matches", () => {
		const list = [diag("plain")];
		expect(withFixHints(list, undefined)).toBe(list);
		expect(withFixHints(list, HINTS)).toBe(list);
		expect(withFixHints([diag("x", { code: "BCE2066" })], HINTS)[0].fixHint?.key).toBe("BCE2066");
	});
});

describe("the fix hints trailer", () => {
	const hinted = (message: string, code?: string) => withFixHints([diag(message, code ? { code } : {})], HINTS)[0];

	it("adds nothing when no diagnostic carries a hint: the block and the result are byte for byte what they were", () => {
		const delta = new Map([[uri("a.bal"), [diag("e", { code: 1, source: "ballerina" }), diag("w", { severity: 2 })]]]);
		const block = lspResultText.newDiagnostics.block(
			lspResultText.newDiagnostics.section({ path: "a.bal", entries: ["  ✘ [Line 1:1] e [1] (ballerina)", "  ⚠ [Line 1:1] w"] }),
		);
		expect(formatNewDiagnostics(delta, PROJECT)).toBe(block);
		expect(formatNewDiagnostics(delta, PROJECT, WORDS)).toBe(block);
		const list = [diag("e", { code: 1 })];
		expect(formatDiagnostics("a.bal", list, undefined, WORDS)).toBe(formatDiagnostics("a.bal", list));
		expect(formatDiagnostics("a.bal", list)).toBe("1 error\n\na.bal:1:1 error: e (1)");
	});

	it("follows the block's body, one line per distinct hint, beside its code or substring", () => {
		const delta = new Map([[uri("a.bal"), [hinted("x is undefined", "BCE2066"), hinted("y is undefined", "BCE2066"), hinted("undefined module 'io'")]]]);
		const text = formatNewDiagnostics(delta, PROJECT, WORDS)!;
		expect(text.endsWith("\n\nFix hints:\nBCE2066: Declare the variable before use.\nundefined module: Add the import for the module.\n</new-diagnostics>")).toBe(true);
		expect(text.match(/BCE2066: /g)).toHaveLength(1);
	});

	it("comes after the block's cut, so a hint is never cut and the caps stay as they are", () => {
		const long = Array.from({ length: 10 }, (_, i) => hinted(`${"x".repeat(600)} ${i}`, "BCE2066"));
		const text = formatNewDiagnostics(new Map([[uri("a.bal"), long]]), PROJECT, WORDS)!;
		expect(text).toContain("…[truncated]");
		expect(text.indexOf("…[truncated]")).toBeLessThan(text.indexOf("Fix hints:"));
		expect(text.indexOf("…[truncated]")).toBeLessThanOrEqual(MAX_CHARS + 200);
		expect(text).toContain("BCE2066: Declare the variable before use.");
	});

	it(`keeps at most ${MAX_FIX_HINTS} hints, the first seen in the order the diagnostics are shown`, () => {
		const hints: FixHints = { byCode: new Map(Array.from({ length: 15 }, (_, i) => [`C${i}`, `hint ${i}`] as const)), byMessage: [] };
		const list = withFixHints(Array.from({ length: 15 }, (_, i) => diag(`m${i}`, { code: `C${i}` })), hints);
		const result = formatDiagnostics("a.bal", list, 20, WORDS);
		const lines = result.slice(result.indexOf("Fix hints:")).split("\n").slice(1);
		expect(lines).toEqual(Array.from({ length: MAX_FIX_HINTS }, (_, i) => `C${i}: hint ${i}`));
	});

	it("names only the diagnostics a result shows", () => {
		const list = withFixHints([diag("a", { code: "BCE2066" }), diag("undefined module 'x'")], HINTS);
		expect(formatDiagnostics("a.bal", list, 1, WORDS)).toBe("2 errors\n\na.bal:1:1 error: a (BCE2066)\n… 1 more\n\nFix hints:\nBCE2066: Declare the variable before use.");
	});
});

describe("a profile's fix hints", () => {
	const server = (fixHints: unknown) => ({ ls: { command: "ls-cmd", extensions: { ".x": "x" }, fixHints: fixHints as never } });

	it("are refused at load with an empty key, or a hint that is empty, spans lines or is too long", () => {
		expect(languageServerProblems(server({ byCode: { OK: "Fine." }, byMessage: [["fine", "Fine."]] }))).toEqual([]);
		expect(languageServerProblems(server({ byCode: { "": "x" } })).join()).toMatch(/fix hint by code with an empty key/);
		expect(languageServerProblems(server({ byMessage: [["", "x"]] })).join()).toMatch(/fix hint by message with an empty key/);
		expect(languageServerProblems(server({ byCode: { A: " " } })).join()).toMatch(/empty fix hint by code for "A"/);
		expect(languageServerProblems(server({ byCode: { A: "one\ntwo" } })).join()).toMatch(/on more than one line/);
		expect(languageServerProblems(server({ byCode: { A: "x".repeat(MAX_FIX_HINT_LENGTH + 1) } })).join()).toMatch(/longer than 200 characters/);
	});

	it("need the profile's words for the trailer", () => {
		const languageServers = server({ byCode: { A: "Fix it." } });
		expect(() => useProfile({ languageServers, text: noHintWords })).toThrow(/declares fix hints, but its text "lsp.fixHints" does not word them/);
	});
});

/** The shipped profile's text with an lsp group that words no trailer. */
function noHintWords({ live }: TextEnv) {
	return { ...shipped.textFor(live), lsp: { description: "d", params: { path: "p", severity: "s" } } };
}
