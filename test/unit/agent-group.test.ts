import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type AgentDefinition, agentGroup } from "../../extensions/lib/agents/agent-catalog.ts";
import { projectConfigDir, userConfigDir } from "../../extensions/lib/profile/sources.ts";

const cwd = join("/", "work", "proj");
const home = join("/", "home", "u");
const bundled = join("/", "pkg", "profile", "agents");
const agent = (name: string, source: string): AgentDefinition => ({ name, description: "", systemPrompt: "x", source });

describe("agentGroup", () => {
	it("names the group /context shows a custom agent under, and none for a built-in one", () => {
		expect(agentGroup(agent("reviewer", join(projectConfigDir(cwd), "agents", "reviewer.md")), cwd, home, bundled)).toBe("Project");
		expect(agentGroup(agent("mine", join(userConfigDir(home), "agents", "sub", "mine.md")), cwd, home, bundled)).toBe("User");
		// Started in the home directory, the project folder is the user's: its agents stay User.
		expect(agentGroup(agent("mine", join(userConfigDir(home), "agents", "mine.md")), home, home, bundled)).toBe("User");
		expect(agentGroup(agent("pr:checker", join("/", "plugins", "pr", "agents", "checker.md")), cwd, home, bundled)).toBe("Plugin (pr)");
		expect(agentGroup(agent("explore", join(bundled, "explore.md")), cwd, home, bundled)).toBeUndefined();
		expect(agentGroup(agent("guide", "built-in"), cwd, home, bundled)).toBeUndefined();
	});
});
