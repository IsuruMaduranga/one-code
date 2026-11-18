/**
 * One Code's Agent, Bash, PowerShell and Monitor descriptions name yield only
 * for a model it is offered to (extensions/lib/models/model-family.ts
 * yieldOffered); a Claude model's text has no passage naming it.
 */
import { describe, expect, it } from "vitest";
import { textForModel } from "../../extensions/lib/agents/child-extensions.ts";
import { projectConfigDirName } from "../../extensions/lib/profile/sources.ts";

function descriptions(yieldOn: boolean): Record<string, string> {
	const shell = textForModel("shell", yieldOn);
	const out: Record<string, string> = {
		"Monitor": textForModel("background", yieldOn).monitor.description,
		"PowerShell": shell.powershellDescription({ edition: "core" }),
	};
	for (const form of ["short", "long"] as const) {
		out[`Agent ${form}`] = textForModel("subagents", yieldOn).agentDescription({ form, configDir: projectConfigDirName() });
		for (const autoMode of [true, false]) out[`Bash ${form}${autoMode ? ", auto mode" : ""}`] = shell.bashDescription({ form, autoMode, searchTools: false });
	}
	return out;
}

describe("the passages naming yield", () => {
	it("are in every description for a model yield is offered to (Claude Code's long Agent text has none)", () => {
		for (const [name, text] of Object.entries(descriptions(true))) if (name !== "Agent long") expect(text, name).toMatch(/\byield\b/);
	});

	it("are in none for a Claude model", () => {
		for (const [name, text] of Object.entries(descriptions(false))) {
			expect(text, name).not.toMatch(/\byield\b/);
			// A cut bullet goes whole, never leaving its dash behind.
			expect(text, name).not.toMatch(/^\s*-\s*$/m);
		}
	});
});
