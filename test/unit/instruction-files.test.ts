import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { instructionRule } from "../../extensions/lib/claude-context.ts";
import { readInstructionFiles } from "../../extensions/lib/claude-settings.ts";
import { resetConfigModeForTest } from "../../extensions/lib/config-mode.ts";

/** A temp home whose ~/.claude/settings.json holds `settings` (CLAUDE_CONFIG_DIR unset in tests). */
function homeWith(settings: Record<string, unknown> | undefined): string {
	const home = mkdtempSync(join(tmpdir(), "instruction-files-"));
	if (settings) {
		mkdirSync(join(home, ".claude"), { recursive: true });
		writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(settings));
	}
	return home;
}

describe("readInstructionFiles (findings §57)", () => {
	it("defaults to claude-md-or-agents-md", () => {
		expect(readInstructionFiles(homeWith(undefined))).toBe("claude-md-or-agents-md");
	});

	it("reads the AGENTS.md plugin's option from pluginConfigs", () => {
		const home = homeWith({ pluginConfigs: { "cc-plugin-agents-md@builtin": { options: { instructionFiles: "claude-md-and-agents-md" } } } });
		expect(readInstructionFiles(home)).toBe("claude-md-and-agents-md");
	});

	it("maps the legacy projectInstructions, which yields to instructionFiles", () => {
		expect(readInstructionFiles(homeWith({ projectInstructions: "none" }))).toBe("managed-only");
		expect(readInstructionFiles(homeWith({ projectInstructions: "both" }))).toBe("claude-md-and-agents-md");
		expect(readInstructionFiles(homeWith({ projectInstructions: "whatever" }))).toBe("claude-md");
		const both = homeWith({ projectInstructions: "none", pluginConfigs: { "cc-plugin-agents-md": { options: { instructionFiles: "claude-md" } } } });
		expect(readInstructionFiles(both)).toBe("claude-md");
	});

	it("ignores an unknown instructionFiles value", () => {
		const home = homeWith({ pluginConfigs: { "cc-plugin-agents-md@builtin": { options: { instructionFiles: "everything" } } } });
		expect(readInstructionFiles(home)).toBe("claude-md-or-agents-md");
	});
});

describe("instructionRule", () => {
	it("is agents-md in independent mode, whatever Claude Code's settings say", () => {
		const home = homeWith({ projectInstructions: "claude" });
		expect(instructionRule(home)).toBe("claude-md");
		resetConfigModeForTest("independent");
		expect(instructionRule(home)).toBe("agents-md");
	});
});
