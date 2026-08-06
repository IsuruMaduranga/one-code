import { describe, expect, it } from "vitest";
import { resolveWorkflowAgentModel } from "../../extensions/workflow/agent-session.ts";

const model = (id: string, input: number) =>
	({
		provider: "openai-codex",
		id,
		name: id,
		api: "openai-codex-responses",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text"],
		cost: { input, output: input * 6, cacheRead: input / 10, cacheWrite: 0 },
		contextWindow: 272_000,
		maxTokens: 128_000,
	}) as any;

const catalog = [
	model("gpt-5.6-sol", 5),
	model("gpt-5.6-terra", 2),
	model("gpt-5.4-mini", 0.75),
	model("gpt-5.6-luna", 0.2),
];

const resolve = (overrides: Partial<Parameters<typeof resolveWorkflowAgentModel>[0]> = {}) =>
	resolveWorkflowAgentModel({
		opts: {},
		sessionModel: catalog[0],
		available: catalog,
		defaultEffort: "high",
		...overrides,
	});

describe("workflow model defaults", () => {
	it("uses the same automatic smaller default as foreground subagents", () => {
		const result = resolve();
		expect(result.model?.id).toBe("gpt-5.6-luna");
		expect(result.thinkingLevel).toBe("high");
	});

	it("honors /subagent over the automatic profile", () => {
		expect(resolve({ configuredDefaultModel: "openai-codex/gpt-5.4-mini" }).model?.id).toBe("gpt-5.4-mini");
	});

	it("keeps per-call and agent-frontmatter precedence", () => {
		expect(
			resolve({
				opts: { model: "openai-codex/gpt-5.6-terra" },
				agentModel: "openai-codex/gpt-5.4-mini",
				configuredDefaultModel: "openai-codex/gpt-5.6-luna",
			}).model?.id,
		).toBe("gpt-5.6-terra");
		expect(
			resolve({ agentModel: "openai-codex/gpt-5.4-mini", configuredDefaultModel: "openai-codex/gpt-5.6-luna" })
				.model?.id,
		).toBe("gpt-5.4-mini");
	});

	it('treats configured "inherit" as an explicit session-model choice', () => {
		expect(resolve({ configuredDefaultModel: "inherit" }).model?.id).toBe("gpt-5.6-sol");
	});

	it("preserves effort precedence and suffix parsing", () => {
		expect(resolve({ opts: { model: "openai-codex/gpt-5.6-luna:low" } }).thinkingLevel).toBe("low");
		expect(resolve({ opts: { model: "openai-codex/gpt-5.6-luna:low", effort: "medium" } }).thinkingLevel).toBe(
			"medium",
		);
	});

	it("fails an unavailable explicit model with the curated menu", () => {
		expect(() => resolve({ opts: { model: "openai-codex/not-real" } })).toThrow(/not available/);
	});

	it("rejects a per-call model pricier than the session unless allowExpensive", () => {
		// Session on luna ($0.2); the script asks for sol ($5).
		expect(() =>
			resolveWorkflowAgentModel({
				opts: { model: "openai-codex/gpt-5.6-sol" },
				sessionModel: catalog[3],
				available: catalog,
			}),
		).toThrow(/allowExpensive/);
		expect(
			resolveWorkflowAgentModel({
				opts: { model: "openai-codex/gpt-5.6-sol", allowExpensive: true },
				sessionModel: catalog[3],
				available: catalog,
			}).model?.id,
		).toBe("gpt-5.6-sol");
	});

	it("does not gate the configured default or the automatic pick", () => {
		expect(resolve({ configuredDefaultModel: "openai-codex/gpt-5.6-terra", sessionModel: catalog[3] }).model?.id).toBe(
			"gpt-5.6-terra",
		);
	});
});
