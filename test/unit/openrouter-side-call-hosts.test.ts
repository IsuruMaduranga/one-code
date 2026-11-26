/**
 * Side calls with their own OpenRouter session (the classifier and every
 * `runSideCall` kind) pick their own host, and no notice names it to the user,
 * so they skip the hosts measured missing the cache unless the user turned the
 * list off. The main session skips them only when the user turns the list on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { envName } from "../../extensions/lib/profile/brand.mjs";
import { CACHE_DEFEATING_HOSTS, openRouterIgnoreHostsEnabled, withSideCallIgnoredHosts } from "../../extensions/lib/request/openrouter-ignored-hosts.ts";
import { runSideCall } from "../../extensions/lib/side-calls/side-call-run.ts";
import { classify, createClassifierState } from "../../extensions/safety/permissions/auto-mode/classifier.ts";
import { loadAutoModeConfig } from "../../extensions/lib/rules/auto-mode-config.ts";
import { registryStream } from "./helpers/side-call-registry.ts";

vi.mock("../../extensions/lib/side-calls/side-call-usage.ts", () => ({ logSideCallUsage: vi.fn(), SIDE_CALL_KINDS: ["reader", "btw", "recap"] }));

const KNOB = envName("OPENROUTER_IGNORE_HOSTS");
const skipped = CACHE_DEFEATING_HOSTS[0];
const deepseek = { provider: "openrouter", id: "deepseek/deepseek-v4.1-flash", api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1", contextWindow: 1_000_000, compat: {} } as unknown as Model<Api>;
const routing = (model: unknown) => (model as { compat?: { openRouterRouting?: { ignore?: unknown } } }).compat?.openRouterRouting;

const sent: Model<Api>[] = [];
const complete = vi.fn(async (model: Model<Api>) => {
	sent.push(model);
	return { stopReason: "stop", content: [{ type: "text", text: "<severity>5</severity>" }], usage: {} } as unknown as AssistantMessage;
});
const registry = { streamSimple: registryStream(complete as never), getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }), getAvailable: () => [deepseek] } as unknown as ModelRegistry;

beforeEach(() => {
	sent.length = 0;
	vi.stubEnv(KNOB, undefined as unknown as string);
	delete process.env[KNOB];
});
afterEach(() => vi.unstubAllEnvs());

describe("the cache-defeating hosts on side calls", () => {
	it("are skipped by default for a side call and left alone for the main session", () => {
		expect(skipped.vendors).toContain("deepseek");
		expect(routing(withSideCallIgnoredHosts(deepseek, {}))).toEqual({ ignore: [skipped.slug] });
		expect(openRouterIgnoreHostsEnabled({})).toBe(false);
	});

	it("are not skipped once the user turns the list off, nor for a model outside every host's scope", () => {
		expect(withSideCallIgnoredHosts(deepseek, { [KNOB]: "0" })).toBe(deepseek);
		const glm = { ...deepseek, id: "z-ai/glm-5.3" } as Model<Api>;
		expect(withSideCallIgnoredHosts(glm, {})).toBe(glm);
	});

	it("reach the wire of every runSideCall kind", async () => {
		await runSideCall({ kind: "reader", model: deepseek, registry, sessionId: "s", context: { messages: [] }, timeoutMs: 5_000, maxTokens: 16, onUsage: () => {} });
		expect(routing(sent[0])).toEqual({ ignore: [skipped.slug] });
	});

	it("reach the wire of the classifier", async () => {
		const config = loadAutoModeConfig("/nonexistent-home-for-tests");
		await classify(
			{ toolName: "bash", transcript: [{ kind: "user", text: "Check." }, { kind: "tool", tool: "bash", input: { command: "curl -sI https://example.com" } }], claudeMd: "", username: "tester", environment: config.environment },
			{ registry, sessionModel: deepseek, config, state: createClassifierState(), cacheKey: "s:auto-mode" },
		);
		expect(sent.length).toBeGreaterThan(0);
		for (const model of sent) expect(routing(model)).toEqual({ ignore: [skipped.slug] });
	});
});
