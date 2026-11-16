import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-ai", async (importOriginal) => ({
	...(await importOriginal<typeof import("@earendil-works/pi-ai")>()),
	cleanupSessionResources: vi.fn(),
}));
import { cleanupSessionResources } from "@earendil-works/pi-ai";
import btwExtension from "../../extensions/agents/btw/index.ts";
import recapExtension from "../../extensions/agents/recap/index.ts";
import sessionTitleExtension from "../../extensions/agents/session-title/index.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { registryStream } from "./helpers/side-call-registry.ts";

const cleanup = vi.mocked(cleanupSessionResources);
beforeEach(() => cleanup.mockReset());

// pi runs session_shutdown handlers in load order, and the permissions
// extension (which releases every kind) loads before btw, recap and the title.
// A call that finishes between that release and its owner's abort keeps its
// codex socket and 5-minute idle timer (findings §59), so each owner releases
// its own kind after aborting.
describe("side-call owners release their key after aborting at shutdown", () => {
	it("the session title releases `<session>:title` after its in-flight call is aborted", async () => {
		const model = { provider: "openai", id: "gpt-test", api: "openai-responses", contextWindow: 400_000, maxTokens: 32_000, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } };
		let abortedAtRelease: boolean | undefined;
		let signal: AbortSignal | undefined;
		const complete = vi.fn((_model: never, _context: never, options: { signal?: AbortSignal }) => {
			signal = options.signal;
			return new Promise((resolve) => options.signal?.addEventListener("abort", () => resolve({ role: "assistant", content: [], stopReason: "aborted", usage: {} })));
		});
		cleanup.mockImplementation((key?: string) => {
			if (key === "session-7:title") abortedAtRelease = signal?.aborted;
		});
		const fake = createFakePi();
		sessionTitleExtension(fake.pi as never);
		const ctx = createFakeCtx({
			mode: "tui",
			model,
			sessionManager: { getEntries: () => [], getSessionId: () => "session-7" },
			modelRegistry: { getAvailable: () => [model], getApiKeyAndHeaders: async () => ({ ok: true }), streamSimple: registryStream(complete) },
		});
		await fake.fire("before_agent_start", { messageType: "user", prompt: "Fix the login button" }, ctx);
		await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
		await fake.fire("session_shutdown", { type: "session_shutdown" }, ctx);
		expect(cleanup).toHaveBeenCalledWith("session-7:title");
		expect(abortedAtRelease).toBe(true);
	});

	it("btw and recap release their own kind on shutdown", async () => {
		for (const [extension, key] of [
			[btwExtension, "session-8:btw"],
			[recapExtension, "session-8:recap"],
		] as const) {
			cleanup.mockReset();
			const fake = createFakePi();
			extension(fake.pi as never);
			await fake.fire("session_shutdown", { type: "session_shutdown" }, createFakeCtx({ sessionManager: { getEntries: () => [], getSessionId: () => "session-8" } }));
			expect(cleanup).toHaveBeenCalledWith(key);
		}
	});
});
