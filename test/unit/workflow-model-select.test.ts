import { beforeEach, describe, expect, it } from "vitest";
import { pinCatalog } from "./catalog-fixture.ts";
import { resolveWorkflowAgentModel } from "../../extensions/agents/workflow/agent-session.ts";
import { supportsImageInput } from "../../extensions/lib/models/model-policy.ts";
import { requireText } from "../../extensions/lib/profile/profile.ts";
import { resolveSubagentModel, subagentModelMenu } from "../../extensions/lib/models/subagent-model.ts";

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

/**
 * The refusal of a model the resolver could not resolve, in the profile's
 * words: the resolver's reason and the retry menu around the session's
 * default, as the base builds them.
 */
function unavailable(requested: string, sessionModel: ReturnType<typeof model>, available: ReturnType<typeof model>[]) {
	const requireImageInput = supportsImageInput(sessionModel);
	const { unresolvedReason: reason } = resolveSubagentModel({ requested, sessionModel, available, requireImageInput });
	const fallback = resolveSubagentModel({ sessionModel, available, requireImageInput });
	const menu = subagentModelMenu({ available, sessionModel, defaultModel: fallback.model, defaultSource: fallback.source, requireImageInput });
	const message = requireText("workflow").callProblem({ kind: "modelUnavailable", model: requested, ...(reason ? { reason } : {}), menu });
	return { message, menu, reason };
}

const resolve = (overrides: Partial<Parameters<typeof resolveWorkflowAgentModel>[0]> = {}) =>
	resolveWorkflowAgentModel({
		opts: {},
		sessionModel: catalog[0],
		available: catalog,
		defaultEffort: "high",
		...overrides,
	});

describe("workflow model defaults", () => {
	beforeEach(() =>
		pinCatalog([
			{ id: "openai/gpt-5.6-sol", released: "2026-07-09", price: [5, 20] },
			{ id: "openai/gpt-5.6-terra", released: "2026-07-09", price: [2, 8] },
			{ id: "openai/gpt-5.6-astra", released: "2026-07-09", price: [10, 40] },
			{ id: "openai/gpt-5.6-luna", released: "2026-07-09", price: [0.2, 0.8] },
			{ id: "openai/gpt-5.4-mini", released: "2026-07-09", price: [0.3, 1.2] },
		]),
	);

	it("uses the same automatic same-tier default as foreground subagents", () => {
		// A Sol session delegates to Terra (its own workhorse tier), not the cheap-line Luna.
		const result = resolve();
		expect(result.model?.id).toBe("gpt-5.6-terra");
		expect(result.thinkingLevel).toBe("high");
	});

	it("honors /subagent over the automatic profile", () => {
		expect(resolve({ configuredDefault: { spec: "openai-codex/gpt-5.4-mini", source: "subagentModel setting" } }).model?.id).toBe("gpt-5.4-mini");
	});

	it("keeps per-call and agent-frontmatter precedence", () => {
		expect(
			resolve({
				opts: { model: "openai-codex/gpt-5.6-terra" },
				agentModel: "openai-codex/gpt-5.4-mini",
				configuredDefault: { spec: "openai-codex/gpt-5.6-luna", source: "subagentModel setting" },
			}).model?.id,
		).toBe("gpt-5.6-terra");
		expect(
			resolve({ agentModel: "openai-codex/gpt-5.4-mini", configuredDefault: { spec: "openai-codex/gpt-5.6-luna", source: "subagentModel setting" } })
				.model?.id,
		).toBe("gpt-5.4-mini");
	});

	it('treats configured "inherit" as an explicit session-model choice', () => {
		expect(resolve({ configuredDefault: { spec: "inherit", source: "subagentModel setting" } }).model?.id).toBe("gpt-5.6-sol");
	});

	it("preserves effort precedence and suffix parsing", () => {
		expect(resolve({ opts: { model: "openai-codex/gpt-5.6-luna:low" } }).thinkingLevel).toBe("low");
		expect(resolve({ opts: { model: "openai-codex/gpt-5.6-luna:low", effort: "medium" } }).thinkingLevel).toBe(
			"medium",
		);
	});

	it("fails an unavailable explicit model with the curated menu", () => {
		const { message, menu } = unavailable("openai-codex/not-real", catalog[0], catalog);
		expect(menu.length).toBeGreaterThan(0);
		expect(() => resolve({ opts: { model: "openai-codex/not-real" } })).toThrow(message);
	});

	it("recommends only an image-capable default on an image-capable session, even in the retry menu", () => {
		// Session sees images; the script names a text-only model, which is refused —
		// and the menu's "current default" line must not point back at a text-only one.
		// Terra (the ungated automatic pick, see the first test) is text-only here;
		// only mini can see images among the cheaper models.
		const imageSession = { ...model("gpt-5.6-sol", 5), input: ["text", "image"] };
		const imageMini = { ...model("gpt-5.4-mini", 0.75), input: ["text", "image"] };
		const available = [imageSession, model("gpt-5.6-terra", 2), imageMini, model("gpt-5.6-luna", 0.2)];
		let message = "";
		try {
			resolveWorkflowAgentModel({ opts: { model: "openai-codex/gpt-5.6-luna" }, sessionModel: imageSession, available });
		} catch (error) {
			message = (error as Error).message;
		}
		const expected = unavailable("openai-codex/gpt-5.6-luna", imageSession, available);
		// The resolver says why (the model cannot see images), and the message carries it.
		expect(expected.reason).toBeDefined();
		expect(message).toBe(expected.message);
		// Every menu entry, the default line first, must be image-capable: a
		// text-only suggestion would only be refused again on retry.
		expect(expected.menu.length).toBeGreaterThan(0);
		expect(expected.menu.some((line) => line.includes("gpt-5.4-mini"))).toBe(true);
		for (const line of expected.menu) expect(line).not.toMatch(/terra|luna/);
	});

	it("rejects a per-call model pricier than the session unless allowExpensive", () => {
		// Session on luna ($0.2); the script asks for sol ($5).
		expect(() =>
			resolveWorkflowAgentModel({
				opts: { model: "openai-codex/gpt-5.6-sol" },
				sessionModel: catalog[3],
				available: catalog,
			}),
		).toThrow(
			requireText("workflow").callProblem({
				kind: "expensiveModel",
				gate: requireText("subagentModels").costsMore({ model: "openai-codex/gpt-5.6-sol", price: 5, session: "openai-codex/gpt-5.6-luna", sessionPrice: 0.2 }),
			}),
		);
		expect(
			resolveWorkflowAgentModel({
				opts: { model: "openai-codex/gpt-5.6-sol", allowExpensive: true },
				sessionModel: catalog[3],
				available: catalog,
			}).model?.id,
		).toBe("gpt-5.6-sol");
	});

	it("does not gate the configured default or the automatic pick", () => {
		expect(resolve({ configuredDefault: { spec: "openai-codex/gpt-5.6-terra", source: "subagentModel setting" }, sessionModel: catalog[3] }).model?.id).toBe(
			"gpt-5.6-terra",
		);
	});
});
