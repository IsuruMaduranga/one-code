import { describe, expect, it } from "vitest";
import { decide, extractSubject, parseRules, type PermissionMode } from "../../extensions/permissions/matcher.ts";

const request = { subagent_type: "explore", prompt: "Inspect the repository", description: "Inspect files" };
const rules = (mode: PermissionMode, toolName: string, input: Record<string, unknown>, deny: string[], ask: string[] = []) => decide({
	toolName,
	subject: extractSubject(toolName, input),
	cwd: process.cwd(),
	mode,
	deny: parseRules(deny),
	ask: parseRules(ask),
	allow: [],
});

describe("Agent(type) permission rules", () => {
	it.each(["default", "plan", "auto", "bypassPermissions"] as PermissionMode[])("honors type-specific denial before auto-allowing Agent in %s", (mode) => {
		expect(rules(mode, "Agent", request, ["Agent(explore)"])).toMatchObject({ decision: "deny", cause: "rule" });
	});

	it.each(["explore", "Explore", "EXPLORE"])("matches catalog case-insensitive agent spelling %s and the Task alias", (subagent_type) => {
		expect(rules("default", "Agent", { ...request, subagent_type }, ["Task(Explore)"])).toMatchObject({ decision: "deny", cause: "rule" });
	});

	it("does not allow a path argument to hide the selected agent type", () => {
		expect(rules("default", "Agent", { ...request, path: "innocent" }, ["Agent(explore)"])).toMatchObject({ decision: "deny" });
	});

	it("honors a type-specific ask rule without affecting another type or a catalog listing", () => {
		expect(rules("default", "Agent", request, [], ["Agent(explore)"])).toMatchObject({ decision: "ask", cause: "rule" });
		expect(rules("default", "Agent", { ...request, subagent_type: "plan" }, ["Agent(explore)"])).toMatchObject({ decision: "allow" });
		expect(rules("default", "Agent", { action: "list" }, ["Agent(explore)"])).toMatchObject({ decision: "allow" });
	});

	it("keeps a bare Agent denial applicable to catalog listings", () => {
		expect(rules("default", "Agent", { action: "list" }, ["Agent"])).toMatchObject({ decision: "deny" });
	});
});
