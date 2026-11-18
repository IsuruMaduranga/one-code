/**
 * yield is offered only to models outside the Claude family
 * (lib/models/model-family.ts yieldOffered): a Claude model waits the way
 * Claude Code's default does, by ending its turn. The tool leaves the active
 * set on a Claude model, and the Agent, bash and monitor descriptions leave out
 * the passages naming it, switching at session and model boundaries. The TUI
 * draws no row for a yield call unless it fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { envName } from "../../extensions/lib/profile/brand.mjs";
import backgroundExtension from "../../extensions/tools/background/index.ts";
import bashExtension from "../../extensions/tools/bash/index.ts";
import subagentsExtension from "../../extensions/agents/subagents/index.ts";
import { textForModel } from "../../extensions/lib/agents/child-extensions.ts";
import { yieldOffered } from "../../extensions/lib/models/model-family.ts";
import { projectConfigDirName } from "../../extensions/lib/profile/sources.ts";
import { withYield } from "../../extensions/tools/background/yield-wait.ts";
import { hiddenToolRenderers } from "../../extensions/lib/ui/tui-render.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const claude = { provider: "anthropic", id: "claude-sonnet-5-5", input: ["text"], cost: { input: 3, output: 15 } };
const gpt = { provider: "openai", id: "gpt-6.1-terra", input: ["text"], cost: { input: 3, output: 15 } };

describe("yieldOffered", () => {
	it("offers yield to every model outside the Claude family, on any provider", () => {
		expect(yieldOffered({ provider: "anthropic", id: "claude-opus-5-5" })).toBe(false);
		expect(yieldOffered({ provider: "openrouter", id: "anthropic/claude-sonnet-5-5" })).toBe(false);
		expect(yieldOffered({ provider: "amazon-bedrock", id: "us.anthropic.claude-haiku-5-5" })).toBe(false);
		expect(yieldOffered({ provider: "openai", id: "gpt-6.1-terra" })).toBe(true);
		expect(yieldOffered({ provider: "openrouter", id: "deepseek/deepseek-v4.1-flash" })).toBe(true);
		expect(yieldOffered(undefined)).toBe(true);
	});
});

describe("withYield", () => {
	it("adds or removes yield, keeps the other names in order, and returns the same list when nothing changes", () => {
		const active = ["read", "bash", "Agent"];
		expect(withYield(active, false)).toBe(active);
		expect(withYield(active, true)).toEqual(["read", "bash", "Agent", "yield"]);
		const withIt = ["read", "yield", "bash"];
		expect(withYield(withIt, true)).toBe(withIt);
		expect(withYield(withIt, false)).toEqual(["read", "bash"]);
	});
});

describe("the session's model decides yield", () => {
	// Both models on one tier, so only yield tells the descriptions apart.
	beforeEach(() => vi.stubEnv(envName("PROMPT_TIER"), "frontier"));
	afterEach(() => vi.unstubAllEnvs());

	function mount() {
		const fake = createFakePi();
		for (const extension of [bashExtension, backgroundExtension, subagentsExtension]) extension(fake.pi as never);
		fake.setActiveTools([...fake.tools.keys()]);
		const descriptions = () => ({
			Agent: fake.tools.get("Agent")!.description,
			bash: fake.tools.get("bash")!.description,
			monitor: fake.tools.get("monitor")!.description,
		});
		const expected = (yieldOn: boolean) => ({
			Agent: textForModel("subagents", yieldOn).agentDescription({ form: "short", configDir: projectConfigDirName() }),
			monitor: textForModel("background", yieldOn).monitor.description,
		});
		return { fake, descriptions, expected };
	}

	it("takes yield out of the tools and the descriptions on a Claude model, and brings both back on another model", async () => {
		const { fake, descriptions, expected } = mount();
		await fake.fire("session_start", { type: "session_start", reason: "startup" }, createFakeCtx({ model: claude, modelRegistry: { getAvailable: () => [claude] } }));
		expect(fake.getActiveTools()).not.toContain("yield");
		expect(descriptions()).toMatchObject(expected(false));

		await fake.fire("model_select", { type: "model_select", model: gpt, source: "set" }, createFakeCtx({ model: gpt, modelRegistry: { getAvailable: () => [gpt] } }));
		expect(fake.getActiveTools()).toContain("yield");
		expect(descriptions()).toMatchObject(expected(true));

		await fake.fire("model_select", { type: "model_select", model: claude, source: "set" }, createFakeCtx({ model: claude, modelRegistry: { getAvailable: () => [claude] } }));
		expect(fake.getActiveTools()).not.toContain("yield");
		expect(descriptions()).toMatchObject(expected(false));
	});

	it("restores the model's choice after a /tree switch restores another loadout", async () => {
		const { fake } = mount();
		const ctx = createFakeCtx({ model: claude, modelRegistry: { getAvailable: () => [claude] } });
		await fake.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
		fake.setActiveTools([...fake.getActiveTools(), "yield"]);
		await fake.fire("session_tree", { type: "session_tree" }, ctx);
		expect(fake.getActiveTools()).not.toContain("yield");
	});
});

describe("hiddenToolRenderers", () => {
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text, bg: (_color: string, text: string) => text };

	it("draws nothing for a call that runs or succeeds", () => {
		const renderers = hiddenToolRenderers("Wait for background work");
		expect(renderers.renderCall({}, theme, { isPartial: true, isError: false }).render(80)).toEqual([]);
		const result = { content: [{ type: "text", text: "The wait has ended." }] };
		expect(renderers.renderResult(result, { expanded: false, isPartial: false }, theme, { isError: false }).render(80)).toEqual([]);
	});

	it("still shows a call that failed", () => {
		const renderers = hiddenToolRenderers("Wait for background work");
		expect(renderers.renderCall({}, theme, { isPartial: false, isError: true }).render(80).join("\n")).toContain("Wait for background work");
	});
});
