/**
 * Auto-mode setup drafting sends through pi's model runtime, keyed to the
 * session like every side call, and steps past a model pi cannot send to
 * with pi's own error.
 */
import { describe, expect, it, vi } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import { draftSetup } from "../../extensions/safety/permissions/auto-mode/setup-run.ts";
import { loadAutoModeConfig } from "../../extensions/lib/rules/auto-mode-config.ts";
import { registryStream } from "./helpers/side-call-registry.ts";

const model = { provider: "openai", id: "gpt-test", api: "openai-responses", contextWindow: 400_000, maxTokens: 32_000, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } } as Model<Api>;
const facts = { cwd: "/project", username: "tester", usage: "A web app.", remotes: [], permissionsAllow: [], gatherNotes: [] };

describe("draftSetup", () => {
	it("keys the call to the session and fails naming the refused credential when the runtime cannot send", async () => {
		const complete = vi.fn(async () => ({ role: "assistant", content: [], stopReason: "error", errorMessage: "Provider is not configured: openai", usage: {} }));
		const registry = {
			getAvailable: () => [model],
			getApiKeyAndHeaders: async () => ({ ok: true }),
			streamSimple: registryStream(complete),
		};
		await expect(
			draftSetup(facts, {
				registry: registry as never,
				sessionModel: model,
				sessionId: "session-1",
				config: loadAutoModeConfig("/nonexistent-home-for-tests"),
				defaultEnvironment: [],
			}),
		).rejects.toThrow("no model could draft the setup (last error: No usable credentials for openai/gpt-test: Provider is not configured: openai. Log in with /login or set the provider's API key.)");
		expect(complete).toHaveBeenCalled();
		const options = (complete.mock.calls[0] as unknown[])[2] as { sessionId?: string; apiKey?: string };
		expect(options.sessionId).toBe("session-1:setup");
	});
});
