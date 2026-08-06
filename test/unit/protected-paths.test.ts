import { describe, expect, it } from "vitest";
import { decide, isBroadExecutionRule, parseRule, parseRules } from "../../extensions/permissions/matcher.ts";
import { isProtectedPath, isWritingTool } from "../../extensions/permissions/protected-paths.ts";

describe("isProtectedPath", () => {
	it("protects tooling and agent configuration directories", () => {
		for (const path of [
			".git/hooks/pre-commit",
			".git/config",
			".claude/settings.json",
			".vscode/tasks.json",
			".husky/pre-push",
			".mvn/wrapper/maven-wrapper.properties",
			".devcontainer/devcontainer.json",
			".idea/workspace.xml",
			".yarn/releases/yarn.cjs",
			".cargo/config.toml",
		]) {
			expect(isProtectedPath(path), path).toBe(true);
		}
	});

	it("protects shell, package-manager, and hook files by basename", () => {
		for (const path of [
			".zshrc",
			"deep/nested/.bashrc",
			".envrc",
			".npmrc",
			".pre-commit-config.yaml",
			"gradle-wrapper.properties",
			".mcp.json",
			".gitconfig",
			"lefthook.yml",
			"pyrightconfig.json",
		]) {
			expect(isProtectedPath(path), path).toBe(true);
		}
	});

	it("protects nested occurrences, not just top-level ones", () => {
		expect(isProtectedPath("packages/app/.vscode/settings.json")).toBe(true);
		expect(isProtectedPath("/abs/repo/.git/hooks/post-merge")).toBe(true);
	});

	it("leaves ordinary project files alone", () => {
		for (const path of ["src/index.ts", "README.md", "package.json", "docs/.gitkeep", "gitconfig"]) {
			expect(isProtectedPath(path), path).toBe(false);
		}
	});

	it("exempts .claude/worktrees, which is the agent's own working space", () => {
		expect(isProtectedPath(".claude/worktrees/feature/src/a.ts")).toBe(false);
		expect(isProtectedPath(".claude/settings.local.json")).toBe(true);
	});

	it("protects .pincer like .claude, excepting only plan documents", () => {
		expect(isProtectedPath("/home/u/.pincer/settings.json")).toBe(true);
		expect(isProtectedPath("/home/u/.pincer/plans/brisk-otter-map.md")).toBe(false);
	});

	it("treats the directory itself as not-yet-a-write-target", () => {
		// A protected match only counts when something lives under the directory.
		expect(isProtectedPath(".git")).toBe(false);
		expect(isProtectedPath(".git/x")).toBe(true);
	});

	it("matches an absolute in-project path the same as its relative form", () => {
		const cwd = "/repo";
		expect(isProtectedPath("/repo/.claude/settings.json", cwd)).toBe(true);
		expect(isProtectedPath(".claude/settings.json", cwd)).toBe(true);
	});

	it("names the tools this check applies to", () => {
		expect(isWritingTool("edit")).toBe(true);
		expect(isWritingTool("write")).toBe(true);
		expect(isWritingTool("notebook_edit")).toBe(true);
		expect(isWritingTool("read")).toBe(false);
		expect(isWritingTool("bash")).toBe(false);
	});
});

describe("decide: protected paths", () => {
	const base = { subject: "", cwd: "/repo", deny: [], ask: [], allow: [] };

	it("prompts for a protected write even when an allow rule matches", () => {
		// The whole point: `Edit(.claude/**)` must not pre-approve reconfiguring
		// the agent's own permissions.
		const d = decide({
			...base,
			mode: "default",
			toolName: "edit",
			subject: ".claude/settings.json",
			allow: parseRules(["Edit(.claude/**)"]),
		});
		expect(d.decision).toBe("ask");
		expect(d.cause).toBe("protected-path");
	});

	it("prompts in acceptEdits, which would otherwise auto-approve the edit", () => {
		const d = decide({ ...base, mode: "acceptEdits", toolName: "write", subject: ".git/hooks/pre-commit" });
		expect(d.decision).toBe("ask");
	});

	it("routes to the classifier in auto mode", () => {
		const d = decide({ ...base, mode: "auto", toolName: "edit", subject: ".zshrc" });
		expect(d.decision).toBe("classify");
		expect(d.cause).toBe("protected-path");
	});

	it("denies in dontAsk and allows in bypassPermissions", () => {
		expect(decide({ ...base, mode: "dontAsk", toolName: "edit", subject: ".npmrc" }).decision).toBe("deny");
		expect(decide({ ...base, mode: "bypassPermissions", toolName: "edit", subject: ".npmrc" }).decision).toBe("allow");
	});

	it("checks the resolved subject too, so a symlinked spelling is as protected as the real one", () => {
		// `ln -s .git/hooks build` then writing build/pre-commit: the literal
		// subject looks innocent; the resolved one is what the write lands on.
		const d = decide({
			...base,
			mode: "acceptEdits",
			toolName: "write",
			subject: "build/pre-commit",
			resolvedSubject: "/repo/.git/hooks/pre-commit",
		});
		expect(d.decision).toBe("ask");
		expect(d.cause).toBe("protected-path");
		// And an unresolvable or ordinary resolved subject changes nothing.
		expect(
			decide({ ...base, mode: "acceptEdits", toolName: "write", subject: "src/a.ts", resolvedSubject: "/repo/src/a.ts" })
				.decision,
		).toBe("allow");
	});

	it("still lets deny rules and ask rules take precedence", () => {
		expect(
			decide({ ...base, mode: "default", toolName: "edit", subject: ".npmrc", deny: parseRules(["Edit"]) }).decision,
		).toBe("deny");
	});

	it("does not gate reads of protected paths", () => {
		expect(decide({ ...base, mode: "default", toolName: "read", subject: ".claude/settings.json" }).decision).toBe(
			"allow",
		);
	});
});

describe("isBroadExecutionRule", () => {
	const rule = (raw: string) => {
		const parsed = parseRule(raw);
		if (!parsed) throw new Error(`unparseable: ${raw}`);
		return parsed;
	};

	it("treats blanket and wildcard-only shell rules as broad", () => {
		for (const raw of ["Bash", "Bash(*)", "Bash(:*)", "Bash(**)"]) {
			expect(isBroadExecutionRule(rule(raw)), raw).toBe(true);
		}
	});

	it("treats wildcarded interpreters and runners as broad", () => {
		// These grant arbitrary execution just as surely as Bash(*) does.
		for (const raw of [
			"Bash(python*)",
			"Bash(python3 *)",
			"Bash(node *)",
			"Bash(npm *)",
			"Bash(npm run *)",
			"Bash(npx *)",
			"Bash(make *)",
			"Bash(env *)",
			"Bash(docker run *)",
			"Bash(xargs *)",
		]) {
			expect(isBroadExecutionRule(rule(raw)), raw).toBe(true);
		}
	});

	it("keeps genuinely narrow rules narrow", () => {
		for (const raw of [
			"Bash(npm test)",
			"Bash(npm test:*)",
			"Bash(npm run build)",
			"Bash(git push:*)",
			"Bash(ls:*)",
			"Bash(cargo test)",
			"Read",
			"Edit(src/**)",
		]) {
			expect(isBroadExecutionRule(rule(raw)), raw).toBe(false);
		}
	});

	it("drops delegation rules outright", () => {
		// A subagent is a fresh agent loop, so pre-approving one pre-approves
		// whatever it decides to do.
		for (const raw of ["Task", "Task(explore)", "Agent", "Workflow"]) {
			expect(isBroadExecutionRule(rule(raw)), raw).toBe(true);
		}
	});
});

describe("decide: delegation in auto mode", () => {
	const base = { subject: "", cwd: "/repo", deny: [], ask: [], allow: [] };

	it("classifies a subagent spawn instead of auto-allowing it", () => {
		// The delegated task is judged before the child starts; a child cannot be
		// relied on to refuse a task its parent should not have handed it.
		expect(decide({ ...base, mode: "auto", toolName: "subagent" }).decision).toBe("classify");
		expect(decide({ ...base, mode: "auto", toolName: "workflow" }).decision).toBe("classify");
	});

	it("still auto-allows delegation outside auto mode", () => {
		expect(decide({ ...base, mode: "default", toolName: "subagent" }).decision).toBe("allow");
	});
});
