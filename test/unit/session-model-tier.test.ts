import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeJsonAtomic } from "../../extensions/lib/atomic-write.ts";
import { type CatalogSources, catalogCacheDir, setCatalogSourcesForTest } from "../../extensions/lib/model-catalog-data.ts";
import { resolveModelTier } from "../../extensions/lib/model-tier.ts";
import { requestSystemPrompt } from "../../extensions/lib/prompt-options.ts";
import { registerFormTool } from "../../extensions/lib/tool-variants.ts";
import { sessionModelTier } from "../../extensions/lib/session-model-tier.ts";
import searchToolsExtension from "../../extensions/search-tools/index.ts";
import systemPromptExtension from "../../extensions/system-prompt/index.ts";
import { catalogSources } from "./catalog-fixture.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const model = { provider: "openai", id: "gpt-5", cost: { input: 2 } } as Model<Api>;
const otherModel = { ...model, id: "gpt-5.1" };
const baseTools = ["read", "bash", "edit", "write"];
const searchTools = ["grep", "find", "ls"];
const released = "2026-08-01";

/**
 * Pin a catalog in which gpt-5 and gpt-5.1 are workhorse (as large as the
 * vendor's largest model), cheap (under half of it) or tiny (under 40B): a
 * catalog refresh is what moves a tier.
 */
function catalog(tier: "workhorse" | "cheap" | "tiny"): CatalogSources {
	const params = tier === "workhorse" ? 1e12 : tier === "cheap" ? 3e11 : 2e10;
	const sources = catalogSources([
		{ id: "openai/gpt-5", released, price: [2, 8], params },
		{ id: "openai/gpt-5.1", released, price: [2, 8], params },
		{ id: "openai/gpt-big", released, price: [4, 16], params: 1e12 },
	]);
	setCatalogSourcesForTest(sources);
	return sources;
}

/** A refreshed copy of the catalogs on disk, newer than the bundled one. */
function writeCatalogCache(stateDir: string, sources: CatalogSources, mtime: number): void {
	const dir = catalogCacheDir(stateDir);
	const fetchedAt = "2099-01-01T00:00:00.000Z";
	for (const [file, part] of [["models-dev.json", sources.modelsDev], ["openrouter.json", sources.openRouter], ["huggingface.json", sources.huggingFace]] as const) {
		writeJsonAtomic(join(dir, file), { ...part, fetchedAt });
		utimesSync(join(dir, file), mtime, mtime);
	}
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
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("sessionModelTier ownership", () => {
	it("installs one owner for distinct extension APIs sharing an event bus", async () => {
		catalog("workhorse");
		const fake = createFakePi();
		const first = sessionModelTier(fake.pi as never);
		const second = sessionModelTier({ ...fake.pi, events: { ...fake.events } } as never);
		expect(fake.handlers.get("session_start")).toHaveLength(1);
		expect(fake.handlers.get("model_select")).toHaveLength(1);
		expect(first).toThrow("emit session_start");
		await fake.fire("session_start", {}, createFakeCtx({ model }));
		expect(first()).toBe("workhorse");
		catalog("tiny");
		expect(second()).toBe("workhorse");
		await fake.fire("model_select", { model: otherModel });
		expect(first()).toBe("tiny");
		expect(second()).toBe("tiny");
	});

	it("keeps separate sessions independent, including a newly mounted resume", async () => {
		catalog("workhorse");
		const initial = createFakePi();
		const first = sessionModelTier(initial.pi as never);
		await initial.fire("session_start", {}, createFakeCtx({ model }));
		catalog("tiny");
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
		["workhorse", "tiny", "short"],
		["tiny", "workhorse", "long"],
		["workhorse", "cheap", "short"],
	] as const)("keeps prompt and tools fixed when a catalog refresh moves %s to %s", async (beforeTier, afterTier, form) => {
		catalog(beforeTier);
		expect(resolveModelTier(model)).toBe(beforeTier);
		const t = setup();
		await t.fake.fire("session_start", { reason: "startup" }, t.ctx);
		const before = await t.request();
		expect(before.prompt).toContain("You are One Code");
		expect(before.description).toBe(form);
		expect(before.tools).toEqual(beforeTier === "tiny" ? [...baseTools, ...searchTools] : baseTools);

		catalog(afterTier);
		expect(resolveModelTier(model)).toBe(afterTier); // The live classifier sees the new catalog.
		expect(await t.idlePrompt()).toBe(before.prompt);
		expect(requestSystemPrompt(t.fake.events, t.ctx)).toBe(before.prompt);
		expect(await t.request()).toEqual(before);
	});

	it("re-resolves the prompt, descriptions and search tools together on model_select", async () => {
		catalog("workhorse");
		const t = setup();
		await t.fake.fire("session_start", { reason: "startup" }, t.ctx);
		const before = await t.request();
		catalog("tiny");
		t.ctx.model = otherModel;
		await t.fake.fire("model_select", { model: otherModel, previousModel: model, source: "set" }, t.ctx);
		const after = await t.request();
		expect(after.prompt).not.toBe(before.prompt);
		expect(after.description).toBe("long");
		expect(after.tools).toEqual([...baseTools, ...searchTools]);
		expect(await t.idlePrompt()).toBe(after.prompt);
		catalog("workhorse");
		expect(await t.request()).toEqual(after);
		t.ctx.model = model;
		await t.fake.fire("model_select", { model, previousModel: otherModel, source: "set" }, t.ctx);
		expect(await t.request()).toEqual(before);
	});

	it.each(["resume", "new", "fork"])("resolves fresh on a %s session_start with the same model", async (reason) => {
		catalog("workhorse");
		const t = setup();
		await t.fake.fire("session_start", { reason: "startup" }, t.ctx);
		const before = await t.request();
		catalog("tiny");
		await t.fake.fire("session_start", { reason }, t.ctx);
		const after = await t.request();
		expect(after.prompt).not.toBe(before.prompt);
		expect(after.description).toBe("long");
		expect(after.tools).toEqual([...baseTools, ...searchTools]);
		catalog("workhorse");
		expect(await t.request()).toEqual(after);
	});

	it("sees another extension's disk refresh on the next model change within the stat throttle", async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "session-tier-"));
		vi.stubEnv("ONECODE_STATE_DIR", stateDir);
		vi.spyOn(Date, "now").mockReturnValue(10_000);
		const initial = catalog("workhorse");
		const refreshed = catalog("tiny");
		setCatalogSourcesForTest(undefined);
		try {
			writeCatalogCache(stateDir, initial, 1);
			const t = setup();
			await t.fake.fire("session_start", { reason: "startup" }, t.ctx);
			const before = await t.request();
			expect(before.description).toBe("short");
			// Another jiti instance writes the files, without clearing this one's memo.
			writeCatalogCache(stateDir, refreshed, 2);
			expect(await t.request()).toEqual(before);
			t.ctx.model = otherModel;
			await t.fake.fire("model_select", { model: otherModel, previousModel: model, source: "set" }, t.ctx);
			const after = await t.request();
			expect(after.description).toBe("long");
			expect(after.tools).toEqual([...baseTools, ...searchTools]);
			expect(after.prompt).not.toBe(before.prompt);
		} finally {
			rmSync(stateDir, { recursive: true, force: true });
		}
	});

	it("uses one resolution even if the catalog changes between lifecycle consumers", async () => {
		catalog("workhorse");
		const t = setup(() => catalog("tiny"));
		await t.fake.fire("session_start", { reason: "startup" }, t.ctx);
		const first = await t.request();
		expect(first.tools).toEqual(baseTools);
		expect(first.description).toBe("short");
		catalog("workhorse");
		const reference = setup();
		await reference.fake.fire("session_start", { reason: "startup" }, reference.ctx);
		expect(first).toEqual(await reference.request());
	});
});
