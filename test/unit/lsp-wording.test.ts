/**
 * The language-server text: the start-failure messages, the tool's
 * diagnostics result, and the block new diagnostics ride in after a tool round
 * (Claude Code's layout and severity symbols). What the base decides (which
 * failure, which diagnostics, the caps): lsp.test.ts and lsp-watcher.test.ts.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatDiagnostics, type LspDiagnostic, shownDiagnostic } from "../../extensions/tools/lsp/format.ts";
import { describeStartFailure } from "../../extensions/tools/lsp/install-hints.ts";
import { formatNewDiagnostics, MAX_CHARS } from "../../extensions/tools/lsp/watcher.ts";
import { diag, PROJECT, uri } from "./helpers/lsp-diagnostics.ts";
import { lspResultText } from "../../extensions/tools/lsp/text.ts";

describe("start-failure messages", () => {
	const enoent = (command: string) => ({ kind: "spawnFailed" as const, command, osMessage: `spawn ${command} ENOENT` });
	const worded = (...args: Parameters<typeof describeStartFailure>) => lspResultText.failure(describeStartFailure(...args));

	it("names the install command for a missing built-in server", () => {
		expect(worded(enoent("pyright-langserver"), "pyright-langserver")).toBe("pyright-langserver is not installed. Install it with: npm install -g pyright");
	});

	it("names the plugin when a plugin configured a known command", () => {
		expect(worded(enoent("pyright-langserver"), "pyright-langserver", "pyright")).toBe(
			"pyright-langserver is not installed (configured by the pyright plugin). Install it with: npm install -g pyright",
		);
	});

	it("gives PATH guidance for a plugin command it has no hint for", () => {
		expect(worded(enoent("mi-lemminx"), "mi-lemminx", "mi-ls")).toBe(
			"mi-lemminx is not installed (configured by the mi-ls plugin). Install it and make sure it is on your PATH (the plugin's documentation should say how).",
		);
	});

	it("reports a vendored absolute path as missing, not uninstalled", () => {
		const command = "/plugins/mi-ls/bin/server";
		expect(worded(enoent(command), command, "mi-ls")).toBe(
			"/plugins/mi-ls/bin/server does not exist (configured by the mi-ls plugin). Check the plugin's installation.",
		);
	});
});

describe("the tool's diagnostics result", () => {
	it("formats one diagnostic with 1-indexed position, code and source", () => {
		const d: LspDiagnostic = {
			range: { start: { line: 4, character: 29 } },
			severity: 1,
			code: 2345,
			source: "typescript",
			message: "Argument of type 'number' is not assignable to parameter of type 'string'.",
		};
		expect(lspResultText.diagnostics.line({ path: "src/index.ts", diagnostic: shownDiagnostic(d) })).toBe(
			"src/index.ts:5:30 error: Argument of type 'number' is not assignable to parameter of type 'string'. (2345) [typescript]",
		);
	});

	it("summarises counts and truncates long lists", () => {
		const many = Array.from({ length: 25 }, (_, i) => diag(`e${i}`, 1, i));
		const out = formatDiagnostics("a.ts", many, 10);
		expect(out).toContain("25 errors");
		expect(out).toContain("… 15 more");
		expect(out.split("\n").filter((l) => l.startsWith("a.ts:"))).toHaveLength(10);
	});

	it("reports a clean file", () => {
		expect(formatDiagnostics("a.ts", [])).toBe("No diagnostics.");
	});

	it("counts errors and warnings separately", () => {
		expect(formatDiagnostics("a.ts", [diag("e", 1), diag("w", 2), diag("w2", 2)])).toContain("1 error, 2 warnings");
	});
});

describe("the new-diagnostics block", () => {
	it("matches the exact block layout: tag into preamble, blank lines between files, two-space indent", () => {
		const delta = new Map([
			[uri("guards.ts"), [diag("Cannot find name 'Token'.", 1, 50, 28, { code: 2304, source: "typescript" })]],
			[uri("index.ts"), [diag("'ctx' is declared but its value is never read.", 4, 203, 57, { code: 6133, source: "typescript" })]],
		]);
		expect(formatNewDiagnostics(delta, PROJECT)).toBe(
			"<new-diagnostics>The following new diagnostic issues were detected:\n\n" +
				"guards.ts:\n" +
				"  ✘ [Line 51:29] Cannot find name 'Token'. [2304] (typescript)\n" +
				"\n" +
				"index.ts:\n" +
				"  ★ [Line 204:58] 'ctx' is declared but its value is never read. [6133] (typescript)\n" +
				"</new-diagnostics>",
		);
	});

	it("uses cwd-relative headers, not basenames (deliberate divergence)", () => {
		const delta = new Map([[uri("src/deep/index.ts"), [diag("x", 1)]]]);
		expect(formatNewDiagnostics(delta, PROJECT)).toContain(`\n${join("src", "deep", "index.ts")}:\n`);
	});

	it("maps severities to ✘ ⚠ ℹ ★ and treats missing severity as error", () => {
		const delta = new Map([
			[uri("a.ts"), [diag("e", 1), diag("w", 2), diag("i", 3), diag("h", 4), diag("u", undefined)]],
		]);
		const text = formatNewDiagnostics(delta, PROJECT)!;
		for (const sym of ["✘ [Line 1:1] e", "⚠ [Line 1:1] w", "ℹ [Line 1:1] i", "★ [Line 1:1] h", "✘ [Line 1:1] u"]) {
			expect(text).toContain(sym);
		}
	});

	it("caps at 10 per file, errors surviving first", () => {
		const list = [
			...Array.from({ length: 8 }, (_, i) => diag(`warn-${i}`, 2, i)),
			...Array.from({ length: 8 }, (_, i) => diag(`err-${i}`, 1, i)),
		];
		const text = formatNewDiagnostics(new Map([[uri("a.ts"), list]]), PROJECT)!;
		for (let i = 0; i < 8; i++) expect(text).toContain(`err-${i}`);
		expect(text).toContain("warn-0");
		expect(text).toContain("warn-1");
		expect(text).not.toContain("warn-2");
		expect(text).toContain("… 6 more");
	});

	it("caps at 30 total across files, worst-severity files first, with a remainder note", () => {
		const delta = new Map(
			Array.from({ length: 5 }, (_, f) => [
				uri(`f${f}.ts`),
				Array.from({ length: 10 }, (_, i) => diag(`f${f}-d${i}`, f === 4 ? 1 : 2, i)),
			] as const),
		);
		const text = formatNewDiagnostics(delta, PROJECT)!;
		// f4 is all errors → sorted first; then f0, f1 fill the 30-cap.
		expect(text).toContain("f4.ts:");
		expect(text).toContain("f0.ts:");
		expect(text).toContain("f1.ts:");
		expect(text).not.toContain("f2.ts:");
		expect(text).toContain("… 20 more");
	});

	it("caps the body at 4000 chars with a truncation marker", () => {
		const delta = new Map([[uri("a.ts"), Array.from({ length: 10 }, (_, i) => diag("x".repeat(600), 1, i))]]);
		const text = formatNewDiagnostics(delta, PROJECT)!;
		expect(text.length).toBeLessThan(MAX_CHARS + 200);
		expect(text).toContain("…[truncated]");
		expect(text.endsWith("</new-diagnostics>")).toBe(true);
	});
});
