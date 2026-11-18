/**
 * The system prompt's words come from the profile (`text.systemPrompt`) and
 * the base only places them: a profile with marker text gets exactly that
 * text back, with the computed blocks between, and sections other extensions
 * announce land where they ask, given the tools the session can have.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Profile } from "../../extensions/lib/profile/profile-contract.ts";
import { requireText, resolveProfile, setActiveProfileForTest } from "../../extensions/lib/profile/profile.ts";
import { buildClaudeCodeSystemPrompt } from "../../extensions/request/system-prompt/template.ts";
import { profile as shipped } from "./helpers/default-profile.ts";
import { cwdLine, type SectionSession, type SystemPromptSection, type SystemPromptText, toolList } from "../../extensions/request/system-prompt/text.ts";
import { PROMPT_TIERS } from "../../extensions/lib/models/model-tier.ts";
import { envName } from "../../extensions/lib/profile/brand.mjs";
import { deferralChanges } from "./helpers/tool-mentions.ts";

const markers: SystemPromptText = {
	lead: ({ tier, taskTools }) => [`LEAD ${tier} tasks=${taskTools}`],
	tail: () => ["TAIL"],
	memory: (dir) => `MEMORY ${dir}`,
};

const use = (systemPrompt: SystemPromptText) => {
	const profile: Profile = { features: {}, tools: {}, childExtensions: [], text: (options) => ({ ...shipped.text(options), systemPrompt }) };
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
				toolList([{ name: "read", snippet: "Read a file" }, { name: "bash", snippet: "Run a command" }], ["Prefer read", "Quote paths"]),
				"MEMORY /mem",
				"TAIL",
				`APPENDED\n${cwdLine("C:/work/repo")}`,
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
		expect(prompt).toBe(["LEAD workhorse tasks=true", "DOMAIN workhorse", toolList([], []), "TAIL", "CLOSING"].join("\n\n") + `\n${cwdLine("/r")}`);
	});

	it("hands announced sections the tools the session can have, which the profile decides", () => {
		const profile: Profile = { features: { lsp: false }, tools: {}, childExtensions: [], text: (options) => ({ ...shipped.text(options), systemPrompt: markers }) };
		setActiveProfileForTest(resolveProfile(profile, { [envName("TOOLS_OFF")]: "web_fetch" }, "/profile"));
		const seen: SectionSession[] = [];
		const section: SystemPromptSection = { id: "live", place: "tail", render: (session) => void seen.push(session) };
		buildClaudeCodeSystemPrompt({ selectedTools: ["bash"], toolSnippets: {} } as never, { cwd: "/r", memoryDir: undefined }, "cheap", null, true, [section]);
		expect(seen.map(({ tier, taskTools, tools }) => ({ tier, taskTools, tools }))).toEqual([{ tier: "cheap", taskTools: true, tools: ["bash"] }]);
		// Not the active list: web_search was never selected, and is still a tool the session can have.
		expect([seen[0].live.has("web_fetch"), seen[0].live.has("web_search")]).toEqual([false, true]);
		// And the features that run, which the profile turns off whatever tools are selected.
		expect([seen[0].features.has("lsp"), seen[0].features.has("bash")]).toEqual([false, true]);
	});

	it("keeps its own blocks in place when a deferred tool loads", () => {
		// A deferred tool carries no snippet or guidelines (decisions/system-prompt.md), so loading one leaves the tool list as it was.
		use(markers);
		const snippets = { read: "Read a file", bash: "Run a command" };
		const prompt = ({ tools, tier, taskTools }: SectionSession) =>
			buildClaudeCodeSystemPrompt({ selectedTools: tools, toolSnippets: snippets, promptGuidelines: ["Quote paths"] } as never, { cwd: "/r", memoryDir: "/m" }, tier, null, taskTools);
		expect(deferralChanges(prompt)).toEqual([]);
	});

	it("finds a section that names a deferred tool from the active list", () => {
		const keyedOnActive = ({ tools }: SectionSession) => (tools?.includes("SendMessage") ? "Continue an agent with SendMessage." : "");
		expect(deferralChanges(keyedOnActive)).toHaveLength(PROMPT_TIERS.length * 4);
		expect(deferralChanges(({ live }) => (live.has("SendMessage") ? "Continue an agent with SendMessage." : ""))).toEqual([]);
	});

	it("finds a section that names the caller's own deferred tool from the active list", () => {
		const keyedOnActive = ({ tools }: SectionSession) => (tools?.includes("product_tool") ? "Call product_tool." : "");
		expect(deferralChanges(keyedOnActive)).toEqual([]);
		expect(deferralChanges(keyedOnActive, { deferred: ["product_tool"] })).toHaveLength(PROMPT_TIERS.length * 4);
		// A base tool the caller defers is not among the starting tools either.
		const keyedOnBash = ({ tools }: SectionSession) => (tools?.includes("bash") ? "Run it with bash." : "");
		expect(deferralChanges(keyedOnBash)).toEqual([]);
		expect(deferralChanges(keyedOnBash, { deferred: ["bash"] })).toHaveLength(PROMPT_TIERS.length * 4);
	});

	it("the shipped profile renders the same prompt twice (byte-stable), opening with its lead", () => {
		const a = buildClaudeCodeSystemPrompt(options, { cwd: "/r", memoryDir: "/m" }, "frontier");
		const b = buildClaudeCodeSystemPrompt(options, { cwd: "/r", memoryDir: "/m" }, "frontier");
		expect(a).toBe(b);
		const lead = requireText("systemPrompt").lead({ tier: "frontier", taskTools: false, tools: ["bash", "read", "skill"] });
		expect(a.startsWith(`${lead.join("\n\n")}\n\n`)).toBe(true);
	});
});
