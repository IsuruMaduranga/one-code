/**
 * How the environment block lists workspace directories. Which directories
 * reach it: permissions-workspace.test.ts.
 */
import { describe, expect, it } from "vitest";
import { environmentBlock } from "../../extensions/lib/context/environment-block.ts";

describe("the environment block", () => {
	const env = { cwd: "/p", isGitRepo: true, platform: "darwin", osVersion: "x", shell: "zsh" };
	it("lists workspace directories the way Claude Code's environment block does, and nothing when there are none", () => {
		const withDirs = environmentBlock({ ...env, workspaceDirs: ["/a", "/b"] });
		expect(withDirs).toContain(" - Primary working directory: /p\n - Is a git repository: true\n - Additional working directories:\n  - /a\n  - /b\n - Platform: darwin");
		expect(environmentBlock(env)).toContain(" - Is a git repository: true\n - Platform: darwin");
	});
});
