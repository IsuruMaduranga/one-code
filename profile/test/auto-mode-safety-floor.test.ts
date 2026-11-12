/**
 * One Code's side of the auto-mode safety floor: its wording of the reason
 * and the block, and its independent mode. What the floor stops, on any
 * profile, is in test/unit/safety-floor.test.ts.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isSafetyControlTarget, safetyControlWrite, safetyFloorBlockText, safetyFloorReason } from "../../extensions/safety/permissions/auto-mode/safety-floor.ts";
import { resetConfigModeForTest } from "../claude-code/mode.ts";

let home: string;
let cwd: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "cc-floor-home-"));
	cwd = mkdtempSync(join(tmpdir(), "cc-floor-cwd-"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});

/** The floor's reason as the decision log words it, undefined when it lets the call through. */
const check = (toolName: string, input: Record<string, unknown>) => {
	const target = safetyControlWrite({ toolName, input, cwd, home });
	return target && safetyFloorReason(target);
};

describe("isSafetyControlTarget in independent mode", () => {
	it("keeps Claude Code's relocated settings file on the floor in independent mode", () => {
		// Independent mode reads no Claude Code file, but a rule planted there takes
		// effect when the user switches back, so the floor guards it in both modes.
		const relocated = join(home, "cfg");
		process.env.CLAUDE_CONFIG_DIR = relocated;
		try {
			resetConfigModeForTest("independent");
			expect(isSafetyControlTarget(join(relocated, "settings.json"), home)).toBe(true);
		} finally {
			delete process.env.CLAUDE_CONFIG_DIR;
		}
	});
});

describe("the floor's reasons, in One Code's words", () => {
	it("names what a settings file and a model catalog hold", () => {
		expect(check("write", { path: join(home, ".claude", "settings.json") })).toContain("permission rules");
		expect(check("write", { path: join(home, ".onecode", "cache", "model-catalog", "openrouter.json") })).toContain("model tier");
	});

	// Battery round 7: read-only searches were told they "write ./node_modules/*"
	// and to ask the user, though a rewrite without the pattern passes.
	it.each([
		[`find . -type f -not -path "./node_modules/*" -exec grep -l slugify {} \\;`, "./node_modules/*"],
		[`find . -type f -not -path './.git/*' -name '*.py' -o -type f -name '*.ts' | xargs wc -l`, "./.git/*"],
		// gpt-6.1-sol's verification line, verbatim.
		["PYTHONDONTWRITEBYTECODE=1 make test; npx tsc --noEmit -p web; git diff --check; git diff --stat; git status --short; if rg --hidden --no-ignore -l --glob '!.git/**' --glob '!node_modules/**' --glob '!**/node_modules/**' 'slugify' .; then echo 'Old-name references remain in project files'; exit 1; else result=$?; if [ \"$result\" -ne 1 ]; then exit \"$result\"; fi; echo 'Verified: no old-name references in project files (excluding Git metadata and dependencies)'; fi", "!**/node_modules/**"],
	])("words a wildcard or negated pattern as one that can select a control file: %s", (command, token) => {
		const reason = check("bash", { command });
		expect(reason).toBe(`its pattern ${token} can select a file that holds the permission rules and auto-mode configuration that contain this agent`);
		const block = safetyFloorBlockText(safetyControlWrite({ toolName: "bash", input: { command }, cwd, home })!);
		expect(block).toContain("rewrite it without the wildcard or negated pattern");
		expect(block).not.toContain("Do not retry");
	});

	it("still stops a negated find that deletes, and keeps the literal wording for a named file", () => {
		expect(check("bash", { command: `find . -type f -not -path "./src/*" -delete` })).toMatch(/^its pattern \.\/src\/\* can select/);
		const literal = check("write", { path: ".claude/settings.json", content: "{}" });
		expect(literal).toMatch(/^it writes /);
		expect(safetyFloorBlockText(safetyControlWrite({ toolName: "write", input: { path: ".claude/settings.json", content: "{}" }, cwd, home })!)).toContain(
			"Do not retry or route around this; ask the user to make the change themselves.",
		);
	});
});
