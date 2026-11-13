/** The instruction budget over Claude Code's instruction files, which One Code's source provider adds (test/unit/helpers/instruction-budget-scenarios.ts). */
import { join } from "node:path";
import { vi } from "vitest";
import { instructionBudgetScenarios } from "../../test/unit/helpers/instruction-budget-scenarios.ts";

instructionBudgetScenarios({
	name: "CLAUDE.md",
	second: ["CLAUDE.local.md"],
	setup: (dir) => void vi.stubEnv("CLAUDE_CONFIG_DIR", join(dir, ".claude")),
});
