import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { foldBranch } from "../../extensions/lib/ledger/fold.ts";
import modelDefaultExtension, { applyDefaultModel, PERSIST_DEBOUNCE_MS } from "../../extensions/model-default/index.ts";
import systemReminderExtension from "../../extensions/system-reminder/index.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

describe("applyDefaultModel", () => {
	it("sets the default model while preserving every other key", () => {
		const file = { theme: "onecode", defaultProvider: "anthropic", defaultModel: "claude-opus-5", nested: { a: 1 } };
		expect(applyDefaultModel(file, "openrouter", "qwen/qwen3.6-27b")).toEqual({
			theme: "onecode",
			defaultProvider: "openrouter",
			defaultModel: "qwen/qwen3.6-27b",
			nested: { a: 1 },
		});
		// Input is not mutated.
		expect(file.defaultProvider).toBe("anthropic");
	});

	it("works on an empty settings object", () => {
		expect(applyDefaultModel({}, "openai-codex", "gpt-5.6-sol")).toEqual({
			defaultProvider: "openai-codex",
			defaultModel: "gpt-5.6-sol",
		});
	});
});

describe("modelDefaultExtension", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	function mount() {
		const dir = mkdtempSync(join(tmpdir(), "onecode-model-default-"));
		vi.stubEnv("PI_CODING_AGENT_DIR", dir);
		const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
		const emitted: Array<{ text?: string; placement?: string }> = [];
		modelDefaultExtension({
			on: (name: string, fn: (event: unknown, ctx: unknown) => void) => handlers.set(name, fn),
			events: { emit: (_channel: string, data: unknown) => emitted.push(data as { text?: string }) },
		} as never);
		const ctx = { hasUI: false };
		const select = (provider: string, id: string, name?: string) => handlers.get("model_select")?.({ model: { provider, id, name } }, ctx);
		const read = () => JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as Record<string, unknown>;
		return { select, read, shutdown: () => handlers.get("session_shutdown")?.({}, ctx), startRun: () => handlers.get("before_agent_start")?.({}, ctx), dir, emitted };
	}

	it("announces each switch as Claude Code's /model breadcrumb, keyed so the next switch replaces it", () => {
		vi.useFakeTimers();
		const { select, emitted } = mount();
		select("anthropic", "claude-haiku-4-5", "Claude Haiku 4.5");
		select("anthropic", "claude-sonnet-5", "Claude Sonnet 5");
		vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS);
		const keys = ["local-command:model:caveat", "local-command:model:command", "local-command:model:stdout"];
		expect(emitted.map((e) => (e as { key?: string }).key)).toEqual([...keys, ...keys]);
		expect(emitted.map((e) => e.placement)).toEqual(Array(6).fill("user-prepend"));
		expect(emitted[4].text).toBe("<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args></command-args>\n");
		expect(emitted[5].text).toBe(
			"<local-command-stdout>Set model to `Claude Sonnet 5` and saved as your default for new sessions</local-command-stdout>\n",
		);
	});

	it("writes only the model a ctrl+p cycle settles on, after the quiet period", () => {
		vi.useFakeTimers();
		const { select, read, dir } = mount();
		select("anthropic", "a");
		select("anthropic", "b");
		select("openai", "c");
		vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS - 1);
		expect(() => readFileSync(join(dir, "settings.json"))).toThrow();
		vi.advanceTimersByTime(1);
		expect(read()).toMatchObject({ defaultProvider: "openai", defaultModel: "c" });
	});

	it("announces a switch on the prompt sent inside the quiet period, not the request after it", () => {
		vi.useFakeTimers();
		const { select, startRun, emitted } = mount();
		select("anthropic", "claude-haiku-4-5", "Claude Haiku 4.5");
		startRun();
		expect(emitted.at(-1)?.text).toContain("Set model to `Claude Haiku 4.5`");
		vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS);
		expect(emitted.filter((e) => e.text?.includes("Set model to"))).toHaveLength(1);
	});

	it("flushes a pending choice on shutdown", () => {
		vi.useFakeTimers();
		const { select, read, shutdown } = mount();
		select("anthropic", "z");
		shutdown();
		expect(read()).toMatchObject({ defaultProvider: "anthropic", defaultModel: "z" });
	});
});

describe("modelDefaultExtension with system-reminder (the breadcrumb reaches the branch)", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	/** Both extensions in package.json's order (system-reminder loads first), on one branch. */
	async function mountWired() {
		const dir = mkdtempSync(join(tmpdir(), "onecode-model-default-wired-"));
		vi.stubEnv("PI_CODING_AGENT_DIR", dir);
		const fake = createFakePi();
		systemReminderExtension(fake.pi as never);
		modelDefaultExtension(fake.pi as never);
		const ctx = createFakeCtx({ sessionManager: { getSessionId: () => "s", getBranch: () => fake.branch } });
		await fake.fire("session_start", {}, ctx);
		const select = (provider: string, id: string, name?: string) => fake.fire("model_select", { model: { provider, id, name } }, ctx);
		const pendingTexts = () => foldBranch(fake.branch as never).pending.map((item) => item.text);
		return { fake, ctx, select, pendingTexts, dir };
	}

	it("keeps a switch chosen right before a quit or /reload: system-reminder stops persisting first", async () => {
		vi.useFakeTimers();
		const { fake, ctx, select, pendingTexts } = await mountWired();
		await select("anthropic", "claude-sonnet-5", "Claude Sonnet 5");
		await fake.fire("session_shutdown", { reason: "reload" }, ctx);
		vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS);
		expect(pendingTexts().filter((text) => text.includes("Set model to"))).toEqual([
			"<local-command-stdout>Set model to `Claude Sonnet 5` and saved as your default for new sessions</local-command-stdout>\n",
		]);
	});

	it("leaves one breadcrumb on the branch for a ctrl+p cycle, naming the model it settled on", async () => {
		vi.useFakeTimers();
		const { select, pendingTexts } = await mountWired();
		await select("anthropic", "a", "Model A");
		await select("anthropic", "b", "Model B");
		await select("openai", "c", "Model C");
		vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS);
		const texts = pendingTexts();
		expect(texts.filter((text) => text.startsWith("<local-command-caveat>"))).toHaveLength(1);
		expect(texts.filter((text) => text.startsWith("<command-name>/model"))).toHaveLength(1);
		expect(texts.filter((text) => text.includes("Set model to"))).toEqual([
			"<local-command-stdout>Set model to `Model C` and saved as your default for new sessions</local-command-stdout>\n",
		]);
	});

	it("drops the saved claim when the settings file cannot take the write", async () => {
		vi.useFakeTimers();
		const { select, pendingTexts, dir } = await mountWired();
		writeFileSync(join(dir, "settings.json"), "{ not json");
		await select("anthropic", "a", "Model A");
		vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS);
		expect(pendingTexts().filter((text) => text.includes("Set model to"))).toEqual(["<local-command-stdout>Set model to `Model A`</local-command-stdout>\n"]);
	});
});
