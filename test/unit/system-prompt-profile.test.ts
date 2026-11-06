/**
 * The system prompt's words come from the profile (`text.systemPrompt`) and
 * the base only places them: a profile with marker text gets exactly that
 * text back, with the computed blocks between, and sections other extensions
 * announce land where they ask.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Profile } from "../../extensions/lib/profile-contract.ts";
import { resolveProfile, setActiveProfileForTest } from "../../extensions/lib/profile.ts";
import { buildClaudeCodeSystemPrompt } from "../../extensions/system-prompt/template.ts";
import type { SystemPromptSection, SystemPromptText } from "../../extensions/system-prompt/text.ts";

const markers: SystemPromptText = {
	lead: ({ tier, taskTools }) => [`LEAD ${tier} tasks=${taskTools}`],
	tail: () => ["TAIL"],
	memory: (dir) => `MEMORY ${dir}`,
	toolList: (tools, guidelines) => `TOOLS ${tools.map((t) => `${t.name}=${t.snippet}`).join(",")} | ${guidelines.join(",")}`,
	cwdLine: (cwd) => `CWD ${cwd}`,
	scratchpadMoved: ({ dir }) => `SCRATCHPAD ${dir}`,
};

const use = (systemPrompt: SystemPromptText) => {
	const profile: Profile = { features: {}, tools: {}, childExtensions: [], text: () => ({ systemPrompt }) };
	setActiveProfileForTest(resolveProfile(profile, {}, "/profile"));
};

afterEach(() => setActiveProfileForTest(undefined));

const options = {
	selectedTools: ["bash", "read", "skill"],
	toolSnippets: { read: "Read a file", bash: "Run a command" },
	promptGuidelines: [" Prefer read ", "Prefer read", "Quote paths"],
	appendSystemPrompt: "APPENDED",
} as never;

describe("system prompt from the profile", () => {
	it("is the profile's text with the computed blocks placed between", () => {
		use(markers);
		const prompt = buildClaudeCodeSystemPrompt(options, { cwd: "C:\\work\\repo", memoryDir: "/mem" }, "cheap", "<total_tokens>5 tokens left</total_tokens>", false);
		expect(prompt).toBe(
			[
				"LEAD cheap tasks=false",
				// Registration order (the snippets' order), deduplicated guidelines, tools without a snippet left out.
				"TOOLS read=Read a file,bash=Run a command | Prefer read,Quote paths",
				"MEMORY /mem",
				"TAIL",
				"APPENDED\nCWD C:/work/repo",
				"<total_tokens>5 tokens left</total_tokens>",
			].join("\n\n"),
		);
	});

	it("has no memory section while auto-memory is off", () => {
		use(markers);
		expect(buildClaudeCodeSystemPrompt(options, { cwd: "/r", memoryDir: undefined }, "tiny")).not.toContain("MEMORY");
	});

	it("places announced sections after the lead and at the end of the tail, leaving out undefined ones", () => {
		use(markers);
		const sections: SystemPromptSection[] = [
			{ id: "domain", place: "lead", render: ({ tier }) => `DOMAIN ${tier}` },
			{ id: "frontier-only", place: "lead", render: ({ tier }) => (tier === "frontier" ? "FRONTIER ONLY" : undefined) },
			{ id: "closing", place: "tail", render: () => "CLOSING" },
		];
		const prompt = buildClaudeCodeSystemPrompt({ selectedTools: [], toolSnippets: {} } as never, { cwd: "/r", memoryDir: undefined }, "workhorse", null, true, sections);
		expect(prompt).toBe(["LEAD workhorse tasks=true", "DOMAIN workhorse", "TOOLS  | ", "TAIL", "CLOSING"].join("\n\n") + "\nCWD /r");
	});

	it("One Code's shipped profile renders the same prompt twice (byte-stable)", () => {
		const a = buildClaudeCodeSystemPrompt(options, { cwd: "/r", memoryDir: "/m" }, "frontier");
		const b = buildClaudeCodeSystemPrompt(options, { cwd: "/r", memoryDir: "/m" }, "frontier");
		expect(a).toBe(b);
		expect(a.startsWith("You are One Code")).toBe(true);
	});
});
