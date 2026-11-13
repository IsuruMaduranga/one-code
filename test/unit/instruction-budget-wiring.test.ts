/** The instruction budget over the files the base reads itself: one AGENTS.md per directory (helpers/instruction-budget-scenarios.ts). */
import { instructionBudgetScenarios } from "./helpers/instruction-budget-scenarios.ts";

instructionBudgetScenarios({ name: "AGENTS.md", second: ["work", "AGENTS.md"] });
