import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import modelDefaultExtension, { applyDefaultModel, PERSIST_DEBOUNCE_MS } from "../../extensions/model-default/index.ts";

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
		return { select, read, shutdown: () => handlers.get("session_shutdown")?.({}, ctx), dir, emitted };
	}

	it("announces the settled switch to the model as Claude Code's /model breadcrumb, once", () => {
		vi.useFakeTimers();
		const { select, emitted } = mount();
		select("anthropic", "claude-haiku-4-5", "Claude Haiku 4.5");
		select("anthropic", "claude-sonnet-5", "Claude Sonnet 5");
		vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS);
		expect(emitted.map((e) => e.placement)).toEqual(["user-prepend", "user-prepend", "user-prepend"]);
		expect(emitted[1].text).toBe("<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args></command-args>\n");
		expect(emitted[2].text).toBe(
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

	it("flushes a pending choice on shutdown", () => {
		vi.useFakeTimers();
		const { select, read, shutdown } = mount();
		select("anthropic", "z");
		shutdown();
		expect(read()).toMatchObject({ defaultProvider: "anthropic", defaultModel: "z" });
	});
});
