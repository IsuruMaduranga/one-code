import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentDirs, childToolAllowlist, discoverAgents, parseAgentFile, parseToolList, usableAllowlistedTools } from "../../extensions/subagents/agents.ts";

describe("parseAgentFile", () => {
	it("reads name, description, tools and model from frontmatter", () => {
		const agent = parseAgentFile(
			"/x/reviewer.md",
			`---
name: reviewer
description: Reviews code
tools: read, grep
model: anthropic/claude-sonnet-5
---
You review code.`,
		);
		expect(agent).toMatchObject({
			name: "reviewer",
			description: "Reviews code",
			tools: ["read", "grep"],
			model: "anthropic/claude-sonnet-5",
			systemPrompt: "You review code.",
		});
	});

	it("accepts a yaml list for tools and omits an empty list", () => {
		expect(parseAgentFile("/x/a.md", "---\ntools:\n  - read\n  - ls\n---\nbody")?.tools).toEqual(["read", "ls"]);
		expect(parseAgentFile("/x/b.md", "---\ntools:\n---\nbody")?.tools).toBeUndefined();
	});

	it("reads Claude Code's disallowedTools denylist (the all-except grant shape), normalized to pi names", () => {
		const agent = parseAgentFile("/x/e.md", "---\ndisallowedTools: Edit, Write, NotebookEdit, Agent\n---\nbody");
		expect(agent?.excludeTools).toEqual(["edit", "write", "notebook_edit", "Agent"]);
		expect(agent?.tools).toBeUndefined();
		expect(parseAgentFile("/x/f.md", "---\ndisallowedTools:\n---\nbody")?.excludeTools).toBeUndefined();
	});

	it("accepts excludeTools as a synonym and merges both keys", () => {
		const agent = parseAgentFile("/x/e.md", "---\ndisallowedTools: Write\nexcludeTools: edit, Write\n---\nbody");
		expect(agent?.excludeTools).toEqual(["write", "edit"]);
	});

	it("maps Claude Code tool spellings in `tools` to pi names (a real CC agent file gets real tools)", () => {
		const agent = parseAgentFile(
			"/x/scout.md",
			"---\ntools: Read, Grep, Glob, Bash, WebFetch, WebSearch, NotebookEdit, Skill, Task, SendMessage, ToolSearch, mcp__github__get_issue\n---\nbody",
		);
		expect(agent?.tools).toEqual([
			"read",
			"grep",
			"find",
			"bash",
			"web_fetch",
			"web_search",
			"notebook_edit",
			"skill",
			"Agent",
			"SendMessage",
			"tool_search",
			"mcp__github__get_issue",
		]);
	});

	it("parseToolList collapses duplicates across spellings and trims yaml entries", () => {
		expect(parseToolList(["Read", " read ", "Glob", "find"])).toEqual(["read", "find"]);
		expect(parseToolList("")).toBeUndefined();
		expect(parseToolList(42)).toBeUndefined();
	});

	it("falls back to the filename when no name is given", () => {
		expect(parseAgentFile("/x/scout.md", "---\ndescription: d\n---\nbody")?.name).toBe("scout");
	});

	it("rejects a definition with no system prompt", () => {
		expect(parseAgentFile("/x/empty.md", "---\nname: empty\n---\n\n   ")).toBeUndefined();
	});
});

describe("agentDirs", () => {
	it("orders bundled, then user, then project", () => {
		expect(agentDirs("/proj", "/home/u", "/pkg/agents")).toEqual([
			"/pkg/agents",
			join("/home/u", ".claude", "agents"),
			join("/proj", ".claude", "agents"),
		]);
	});

	it("omits the bundled directory when not supplied", () => {
		expect(agentDirs("/proj", "/home/u")).toEqual([join("/home/u", ".claude", "agents"), join("/proj", ".claude", "agents")]);
	});
});

describe("discoverAgents", () => {
	let root: string;

	const writeAgent = (dir: string, name: string, body: string, description = "d") => {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\ndescription: ${description}\n---\n${body}`);
	};

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "cc-agents-"));
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("collects definitions from every directory, sorted by name", () => {
		writeAgent(join(root, "bundled"), "plan", "bundled plan");
		writeAgent(join(root, "user"), "custom", "user custom");
		const agents = discoverAgents([join(root, "bundled"), join(root, "user")]);
		expect(agents.map((a) => a.name)).toEqual(["custom", "plan"]);
	});

	it("lets a later directory override an earlier one by name", () => {
		writeAgent(join(root, "bundled"), "plan", "bundled version");
		writeAgent(join(root, "project"), "plan", "project version");
		const agents = discoverAgents([join(root, "bundled"), join(root, "project")]);
		expect(agents).toHaveLength(1);
		expect(agents[0].systemPrompt).toBe("project version");
	});

	it("searches subdirectories recursively", () => {
		writeAgent(join(root, "bundled", "nested", "deep"), "buried", "found me");
		expect(discoverAgents([join(root, "bundled")]).map((a) => a.name)).toEqual(["buried"]);
	});

	it("ignores non-markdown files, missing directories, and malformed definitions", () => {
		mkdirSync(join(root, "bundled"), { recursive: true });
		writeFileSync(join(root, "bundled", "notes.txt"), "not an agent");
		writeFileSync(join(root, "bundled", "empty.md"), "---\nname: empty\n---\n");
		expect(discoverAgents([join(root, "bundled"), join(root, "does-not-exist")])).toEqual([]);
	});
});

describe("resilient frontmatter parsing", () => {
	it("still loads a definition whose YAML is invalid (real plugin agents do this)", () => {
		// An unquoted description containing ": " makes pi's YAML parser throw
		// "Nested mappings are not allowed in compact mappings".
		const agent = parseAgentFile(
			"/x/silent-failure-hunter.md",
			`---
name: silent-failure-hunter
description: Use this when reviewing code. Examples: <example>Context: a PR</example>
model: inherit
color: yellow
---
You audit error handling.`,
		);
		expect(agent).toBeDefined();
		expect(agent?.name).toBe("silent-failure-hunter");
		expect(agent?.description).toContain("Examples");
		expect(agent?.systemPrompt).toBe("You audit error handling.");
	});

	it("treats model: inherit as no override", () => {
		const agent = parseAgentFile("/x/a.md", "---\nname: a\nmodel: inherit\n---\nbody");
		expect(agent?.model).toBeUndefined();
	});

	it("keeps a real model id", () => {
		const agent = parseAgentFile("/x/a.md", "---\nname: a\nmodel: anthropic/claude-sonnet-5\n---\nbody");
		expect(agent?.model).toBe("anthropic/claude-sonnet-5");
	});
});

describe("namespaced discovery", () => {
	it("prefixes agents from a namespaced source", () => {
		const dir = mkdtempSync(join(tmpdir(), "cc-ns-"));
		mkdirSync(join(dir, "agents"), { recursive: true });
		writeFileSync(join(dir, "agents", "reviewer.md"), "---\nname: reviewer\n---\nreview things");
		const agents = discoverAgents([{ dir: join(dir, "agents"), namespace: "my-plugin" }]);
		expect(agents.map((a) => a.name)).toEqual(["my-plugin:reviewer"]);
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("child tool allowlist (CC agent files)", () => {
	it("keeps the child's plumbing when an allowlist omits it", () => {
		expect(childToolAllowlist(["read", "grep"])).toEqual(["read", "grep", "SendMessage", "tool_search", "structured_output"]);
		expect(childToolAllowlist(["read", "SendMessage"])).toEqual(["read", "SendMessage", "tool_search", "structured_output"]);
		expect(childToolAllowlist(undefined)).toBeUndefined();
	});

	it("reports an allowlist as unusable only when none of the agent's own names was registered", () => {
		const registered = ["read", "bash", "SendMessage", "tool_search", "structured_output"];
		expect(usableAllowlistedTools(registered, ["foo", "bar"])).toEqual([]);
		expect(usableAllowlistedTools(registered, ["read", "foo"])).toEqual(["read"]);
		// A deliberately narrow agent that lists only the plumbing is narrow, not broken.
		expect(usableAllowlistedTools(registered, ["SendMessage"])).toEqual(["SendMessage"]);
	});
});

describe("forkTaskMessage", () => {
	it("frames the task with do-only-this and not-the-inherited-topic instructions", async () => {
		const { forkTaskMessage } = await import("../../extensions/subagents/outcome.ts");
		const framed = forkTaskMessage("report exactly: DONE");
		expect(framed).toContain("forked subagent");
		expect(framed).toContain("inherited context");
		expect(framed).toContain("Do ONLY the task below");
		expect(framed).toContain("cannot see the parent's background tasks");
		expect(framed).not.toContain("worktree");
		expect(framed.endsWith("Task:\nreport exactly: DONE")).toBe(true);
	});

	it("tells a worktree-isolated fork that its paths moved, and where to write instead", async () => {
		const { forkTaskMessage } = await import("../../extensions/subagents/outcome.ts");
		const framed = forkTaskMessage("fix the bug", { worktreePath: "/tmp/cc-wt-x/tree", parentCwd: "/Users/me/repo" });
		expect(framed).toContain("your working directory is now /tmp/cc-wt-x/tree");
		expect(framed).toContain("Every path under /Users/me/repo in the inherited context refers to the shared checkout");
		expect(framed).toContain("must NOT modify");
		expect(framed.endsWith("Task:\nfix the bug")).toBe(true);
	});
});

describe("finishOutcome", () => {
	it("surfaces a provider error instead of 'produced no output'", async () => {
		const { finishOutcome } = await import("../../extensions/subagents/session-turns.ts");
		const { emptyUsage } = await import("../../extensions/subagents/usage.ts");
		const outcome = finishOutcome("", "OpenAI API error (401): CreditsError", 0, emptyUsage(), []);
		expect(outcome.failed).toBe(true);
		expect(outcome.output).toContain("provider error");
		expect(outcome.output).toContain("CreditsError");
		expect(outcome.output).toContain("not a task failure");
	});

	it("appends the error when partial text exists, and stays clean without one", async () => {
		const { finishOutcome } = await import("../../extensions/subagents/session-turns.ts");
		const { emptyUsage } = await import("../../extensions/subagents/usage.ts");
		const partial = finishOutcome("halfway report", "rate limited", 2, emptyUsage(), []);
		expect(partial.failed).toBe(true);
		expect(partial.output).toContain("halfway report");
		expect(partial.output).toContain("rate limited");
		const ok = finishOutcome("all done", undefined, 2, emptyUsage(), []);
		expect(ok.failed).toBeUndefined();
		expect(ok.output).toBe("all done");
		const empty = finishOutcome("", undefined, 2, emptyUsage(), []);
		expect(empty.failed).toBe(true);
		expect(empty.output).toContain("Subagent produced no output.");
	});

	it("an abort reason wins over partial text and over a provider error (M3)", async () => {
		const { finishOutcome } = await import("../../extensions/subagents/session-turns.ts");
		const { emptyUsage } = await import("../../extensions/subagents/usage.ts");
		const cut = finishOutcome("halfway", undefined, 1, emptyUsage(), [], "terminated before the turn finished");
		expect(cut).toMatchObject({ failed: true, output: "halfway\n\n[terminated before the turn finished]" });
		const both = finishOutcome("", "rate limited", 0, emptyUsage(), [], "terminated before the turn finished");
		expect(both.output).toBe("Subagent terminated before the turn finished.");
	});
});
