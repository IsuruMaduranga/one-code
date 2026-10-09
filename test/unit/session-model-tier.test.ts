import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capabilityCachePath, clearCapabilitySnapshotForTest, setCapabilitySnapshotForTest, type CapabilitySnapshot } from "../../extensions/lib/capability-index.ts";
import { writeJsonAtomic } from "../../extensions/lib/atomic-write.ts";
import { setModelFactsForTest } from "../../extensions/lib/model-facts.ts";
import { resolveModelTier } from "../../extensions/lib/model-tier.ts";
import { requestSystemPrompt } from "../../extensions/lib/prompt-options.ts";
import { registerFormTool } from "../../extensions/lib/tool-variants.ts";
import { sessionModelTier } from "../../extensions/lib/session-model-tier.ts";
import searchToolsExtension from "../../extensions/search-tools/index.ts";
import systemPromptExtension from "../../extensions/system-prompt/index.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const model = { provider: "openai", id: "gpt-5", cost: { input: 2 } } as Model<Api>;
const otherModel = { ...model, id: "gpt-5.1" };
const baseTools = ["read", "bash", "edit", "write"];
const searchTools = ["grep", "find", "ls"];
const releaseDate = "2026-08-01";

function snapshot(coding: number): CapabilitySnapshot {
	const value: CapabilitySnapshot = {
		fetchedAt: "2026-10-05T00:00:00Z",
		source: "test",
		rows: [
			{ id: "reference", slug: "claude-sonnet-5", creator: "anthropic", releaseDate, coding: 80 },
			...[["main", "gpt-5"], ["other", "gpt-5-1"]].map(([id, slug]) => ({ id, slug, creator: "openai", releaseDate, coding })),
		],
	};
	setCapabilitySnapshotForTest(value);
	return value;
}

function setup(betweenConsumers?: () => void) {
	const fake = createFakePi();
	fake.setActiveTools(baseTools);
	searchToolsExtension(fake.pi as never);
	if (betweenConsumers) (fake.pi.on as (event: string, handler: () => void) => void)("session_start", betweenConsumers);
	registerFormTool(fake.pi as never, { name: "probe", description: "", execute: vi.fn() } as never, (form) => form);
	systemPromptExtension(fake.pi as never);
	const ctx = createFakeCtx({ model });
	const request = async () => {
		const results = await fake.fire<{ systemPrompt?: string } | undefined>("before_agent_start", {
			systemPromptOptions: { cwd: ctx.cwd, selectedTools: fake.getActiveTools() },
		}, ctx);
		return {
			prompt: results.find((result) => result?.systemPrompt)?.systemPrompt,
			tools: [...fake.getActiveTools()],
			description: fake.tools.get("probe")?.description,
		};
	};
	const idlePrompt = async () => {
		const results = await fake.fire<{ messages: Array<{ content: string }> }>("context_with_system", {
			messages: [{ role: "system", content: "pi default", timestamp: 1 }],
		}, ctx);
		return results[0]?.messages[0].content;
	};
	return { fake, ctx, request, idlePrompt };
}

beforeEach(() => {
	vi.stubEnv("CC_PROMPT_TIER", "auto");
	setModelFactsForTest({
		"openai/gpt-5": { releaseDate },
		"openai/gpt-5.1": { releaseDate },
	});
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("sessionModelTier ownership", () => {
	it("installs one owner for distinct extension APIs sharing an event bus", async () => {
		snapshot(80);
		const fake = createFakePi();
		const first = sessionModelTier(fake.pi as never);
		const second = sessionModelTier({ ...fake.pi, events: { ...fake.events } } as never);
		expect(fake.handlers.get("session_start")).toHaveLength(1);
		expect(fake.handlers.get("model_select")).toHaveLength(1);
		expect(first).toThrow("emit session_start");
		await fake.fire("session_start", {}, createFakeCtx({ model }));
		expect(first()).toBe("workhorse");
		snapshot(20);
		expect(second()).toBe("workhorse");
		await fake.fire("model_select", { model: otherModel });
		expect(first()).toBe("tiny");
		expect(second()).toBe("tiny");
	});

	it("keeps separate sessions independent, including a newly mounted resume", async () => {
		snapshot(80);
		const initial = createFakePi();
		const first = sessionModelTier(initial.pi as never);
		await initial.fire("session_start", {}, createFakeCtx({ model }));
		snapshot(20);
		const resumed = createFakePi();
		const second = sessionModelTier(resumed.pi as never);
		await resumed.fire("session_start", { reason: "resume" }, createFakeCtx({ model }));
		expect(second()).toBe("tiny");
		expect(first()).toBe("workhorse");
	});

	it("applies a changed environment override only at a lifecycle boundary", async () => {
		vi.stubEnv("CC_PROMPT_TIER", "frontier");
		const fake = createFakePi();
		const tier = sessionModelTier(fake.pi as never);
		await fake.fire("session_start", {}, createFakeCtx({ model }));
		vi.stubEnv("CC_PROMPT_TIER", "tiny");
		expect(tier()).toBe("frontier");
		await fake.fire("model_select", { model: otherModel });
		expect(tier()).toBe("tiny");
	});
});

describe("the session's request-surface tier", () => {
	it.each([
		[80, 20, "workhorse", "tiny", "short"],
		[20, 80, "tiny", "workhorse", "long"],
		[80, 50, "workhorse", "cheap", "short"],
	] as const)("keeps prompt and tools fixed when a snapshot changes %s to %s", async (beforeScore, afterScore, beforeTier, afterTier, form) => {
		snapshot(beforeScore);
		expect(resolveModelTier(model)).toBe(beforeTier);
		const t = setup();
		await t.fake.fire("session_start", { reason: "startup" }, t.ctx);
		const before = await t.request();
		expect(before.prompt).toContain("You are One Code");
		expect(before.description).toBe(form);
		expect(before.tools).toEqual(beforeTier === "tiny" ? [...baseTools, ...searchTools] : baseTools);

		snapshot(afterScore);
		expect(resolveModelTier(model)).toBe(afterTier); // The live classifier sees the new score.
		expect(await t.idlePrompt()).toBe(before.prompt);
		expect(requestSystemPrompt(t.fake.events, t.ctx)).toBe(before.prompt);
		expect(await t.request()).toEqual(before);
	});

	it("re-resolves the prompt, descriptions and search tools together on model_select", async () => {
		snapshot(80);
		const t = setup();
		await t.fake.fire("session_start", { reason: "startup" }, t.ctx);
		const before = await t.request();
		snapshot(20);
		t.ctx.model = otherModel;
		await t.fake.fire("model_select", { model: otherModel, previousModel: model, source: "set" }, t.ctx);
		const after = await t.request();
		expect(after.prompt).not.toBe(before.prompt);
		expect(after.description).toBe("long");
		expect(after.tools).toEqual([...baseTools, ...searchTools]);
		expect(await t.idlePrompt()).toBe(after.prompt);
		snapshot(80);
		expect(await t.request()).toEqual(after);
		t.ctx.model = model;
		await t.fake.fire("model_select", { model, previousModel: otherModel, source: "set" }, t.ctx);
		expect(await t.request()).toEqual(before);
	});

	it.each(["resume", "new", "fork"])("resolves fresh on a %s session_start with the same model", async (reason) => {
		snapshot(80);
		const t = setup();
		await t.fake.fire("session_start", { reason: "startup" }, t.ctx);
		const before = await t.request();
		snapshot(20);
		await t.fake.fire("session_start", { reason }, t.ctx);
		const after = await t.request();
		expect(after.prompt).not.toBe(before.prompt);
		expect(after.description).toBe("long");
		expect(after.tools).toEqual([...baseTools, ...searchTools]);
		snapshot(80);
		expect(await t.request()).toEqual(after);
	});

	it("sees another extension's disk refresh on the next model change within the stat throttle", async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "session-tier-"));
		vi.stubEnv("ONECODE_STATE_DIR", stateDir);
		vi.spyOn(Date, "now").mockReturnValue(10_000);
		const initial = snapshot(80);
		const refreshed = snapshot(20);
		clearCapabilitySnapshotForTest();
		const path = capabilityCachePath(stateDir);
		try {
			writeJsonAtomic(path, initial);
			utimesSync(path, 1, 1);
			const t = setup();
			await t.fake.fire("session_start", { reason: "startup" }, t.ctx);
			const before = await t.request();
			expect(before.description).toBe("short");
			// Another jiti instance writes the file, without clearing this one's memo.
			writeJsonAtomic(path, refreshed);
			utimesSync(path, 2, 2);
			expect(await t.request()).toEqual(before);
			t.ctx.model = otherModel;
			await t.fake.fire("model_select", { model: otherModel, previousModel: model, source: "set" }, t.ctx);
			const after = await t.request();
			expect(after.description).toBe("long");
			expect(after.tools).toEqual([...baseTools, ...searchTools]);
			expect(after.prompt).not.toBe(before.prompt);
		} finally {
			rmSync(stateDir, { recursive: true, force: true });
			setCapabilitySnapshotForTest(undefined);
		}
	});

	it("uses one resolution even if the snapshot changes between lifecycle consumers", async () => {
		snapshot(80);
		const t = setup(() => snapshot(20));
		await t.fake.fire("session_start", { reason: "startup" }, t.ctx);
		const first = await t.request();
		expect(first.tools).toEqual(baseTools);
		expect(first.description).toBe("short");
		snapshot(80);
		const reference = setup();
		await reference.fake.fire("session_start", { reason: "startup" }, reference.ctx);
		expect(first).toEqual(await reference.request());
	});
});
