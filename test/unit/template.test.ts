import { describe, expect, it } from "vitest";
import type { EnvironmentInfo } from "../../extensions/system-prompt/environment.ts";
import { buildClaudeCodeSystemPrompt } from "../../extensions/system-prompt/template.ts";

const env: EnvironmentInfo = {
	cwd: "/tmp/project",
	isGitRepo: true,
	platform: "darwin",
	osVersion: "Darwin 24.2.0",
	shell: "zsh",
	date: "2026-08-05",
	modelLine: "claude-opus-5 (anthropic)",
	memoryDir: "/home/u/.claude/projects/-tmp-project/memory",
};

const baseOptions = { cwd: "/tmp/project" };

describe("buildClaudeCodeSystemPrompt", () => {
	it("contains the adapted identity and core sections", () => {
		const prompt = buildClaudeCodeSystemPrompt(baseOptions, env);
		expect(prompt).toContain("You are pincer");
		expect(prompt).toContain("# Harness");
		expect(prompt).toContain("<system-reminder>");
		expect(prompt).toContain("# Delivering work");
		expect(prompt).toContain("# Corrections");
		expect(prompt).toContain("Current working directory: /tmp/project");
	});

	it("renders the environment block", () => {
		const prompt = buildClaudeCodeSystemPrompt(baseOptions, env);
		expect(prompt).toContain("Working directory: /tmp/project");
		expect(prompt).toContain("Is a git repository: yes");
		expect(prompt).toContain("Model: claude-opus-5 (anthropic)");
	});

	it("includes the scratchpad section after the environment block, only when a dir exists", () => {
		const scratchpad = "/private/tmp/claude-501/-tmp-project/abc-123/scratchpad";
		const prompt = buildClaudeCodeSystemPrompt(baseOptions, env, scratchpad);
		expect(prompt).toContain("# Scratchpad Directory");
		expect(prompt).toContain(scratchpad);
		expect(prompt.indexOf("# Environment")).toBeLessThan(prompt.indexOf("# Scratchpad Directory"));
		// An unwritable /tmp drops the section rather than promising a dead dir.
		expect(buildClaudeCodeSystemPrompt(baseOptions, env)).not.toContain("# Scratchpad Directory");
	});

	it("includes the memory section just before the environment block", () => {
		const prompt = buildClaudeCodeSystemPrompt(baseOptions, env);
		expect(prompt).toContain("# Memory");
		expect(prompt).toContain("/home/u/.claude/projects/-tmp-project/memory/");
		expect(prompt.indexOf("# Memory")).toBeLessThan(prompt.indexOf("# Environment"));
	});

	it("lists tools that have snippets and appends guidelines", () => {
		const prompt = buildClaudeCodeSystemPrompt(
			{
				...baseOptions,
				selectedTools: ["read", "bash", "secret"],
				toolSnippets: { read: "Read files", bash: "Run commands" },
				promptGuidelines: ["Use read before edit", "Use read before edit", "  "],
			},
			env,
		);
		expect(prompt).toContain("- read: Read files");
		expect(prompt).toContain("- bash: Run commands");
		expect(prompt).not.toContain("- secret");
		// deduped + trimmed guidelines
		expect(prompt.match(/Use read before edit/g)).toHaveLength(1);
	});

	it("appends project context files", () => {
		const prompt = buildClaudeCodeSystemPrompt(
			{ ...baseOptions, contextFiles: [{ path: "/tmp/project/CLAUDE.md", content: "Always use tabs." }] },
			env,
		);
		expect(prompt).toContain('<project_instructions path="/tmp/project/CLAUDE.md">');
		expect(prompt).toContain("Always use tabs.");
	});

	it("is byte-stable across calls with identical inputs", () => {
		const a = buildClaudeCodeSystemPrompt(baseOptions, env);
		const b = buildClaudeCodeSystemPrompt({ ...baseOptions }, { ...env });
		expect(a).toBe(b);
	});
});
