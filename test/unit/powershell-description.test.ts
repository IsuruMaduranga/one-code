/**
 * The powershell tool's description is Claude Code's captured text
 * (tools/powershell-tool-2.1.276-macos-pwsh7.json, pwsh-7 edition) byte for
 * byte, followed by One Code's addendum. The capture lives in the internal
 * repo; where it is absent (public checkout) the fidelity assertion is skipped
 * and the structural checks still run.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	CC_CWD_SENTENCE,
	CC_SEARCH_LINES,
	claudeCodePowerShellDescription,
	EDITION_SECTIONS,
	ONE_CODE_ADDENDUM,
	ONE_CODE_CWD_SENTENCE,
	powerShellToolDescription,
} from "../../extensions/powershell/description.ts";

const CAPTURE = "tools/powershell-tool-2.1.276-macos-pwsh7.json";

describe("powerShellToolDescription", () => {
	it.skipIf(!existsSync(CAPTURE))("reproduces the 2.1.276 capture byte for byte for the pwsh-7 edition", () => {
		const captured = JSON.parse(readFileSync(CAPTURE, "utf8")) as { description: string };
		expect(claudeCodePowerShellDescription("core")).toBe(captured.description);
		expect(powerShellToolDescription("core")).toBe(
			`${captured.description.replace(CC_CWD_SENTENCE, ONE_CODE_CWD_SENTENCE).replace(CC_SEARCH_LINES, "")}${ONE_CODE_ADDENDUM}`,
		);
	});

	it("drops the Glob/Grep lines, which name tools One Code does not ship", () => {
		for (const edition of ["core", "desktop", "unknown"] as const) {
			expect(claudeCodePowerShellDescription(edition)).toContain(CC_SEARCH_LINES);
			const text = powerShellToolDescription(edition);
			expect(text).not.toMatch(/\bGlob\b|\bGrep\b/);
			expect(text).toContain("    - Read files: Use Read (NOT Get-Content)");
		}
	});

	it("never tells the model the working directory persists (each call is a fresh process)", () => {
		for (const edition of ["core", "desktop", "unknown"] as const) {
			expect(claudeCodePowerShellDescription(edition)).toContain(CC_CWD_SENTENCE);
			const text = powerShellToolDescription(edition);
			expect(text).not.toContain("persists");
			expect(text).toContain(ONE_CODE_CWD_SENTENCE);
		}
	});

	it("swaps only the edition section", () => {
		const core = claudeCodePowerShellDescription("core");
		const desktop = claudeCodePowerShellDescription("desktop");
		const unknown = claudeCodePowerShellDescription("unknown");
		expect(core.replace(EDITION_SECTIONS.core, "")).toBe(desktop.replace(EDITION_SECTIONS.desktop, ""));
		expect(core.replace(EDITION_SECTIONS.core, "")).toBe(unknown.replace(EDITION_SECTIONS.unknown, ""));
		expect(desktop).toContain("Windows PowerShell 5.1 (powershell.exe)");
		expect(desktop).toContain("UTF-16 LE");
		expect(unknown).toContain("assume Windows PowerShell 5.1");
	});

	it("carries the harness notes after Claude Code's text", () => {
		const text = powerShellToolDescription("core");
		expect(text.endsWith(ONE_CODE_ADDENDUM)).toBe(true);
		expect(text).toContain("task_output");
		expect(text).toContain("Start-Sleep");
	});
});
