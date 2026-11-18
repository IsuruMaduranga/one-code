/**
 * lib/agents/agent-loader.ts withParentSessionId: a fork's runtime sends its
 * own Codex requests under the parent's session id (findings §75) and leaves
 * every other request (a side call's own key included) and member alone.
 */
import { describe, expect, it } from "vitest";
import { withParentSessionId } from "../../extensions/lib/agents/agent-loader.ts";

class FakeRuntime {
	calls: Array<{ api: string; sessionId?: string }> = [];
	cached = 0;
	streamSimple(model: { api: string }, _context: unknown, options?: { sessionId?: string }) {
		this.calls.push({ api: model.api, sessionId: options?.sessionId });
		return "stream" as never;
	}
	remember() {
		this.cached += 1;
		return this.cached;
	}
}

describe("withParentSessionId", () => {
	it("puts the parent's session id on the fork's own Codex requests only", () => {
		const shared = new FakeRuntime();
		const fork = withParentSessionId(shared as never, "parent-session", () => "fork-session") as unknown as FakeRuntime;
		fork.streamSimple({ api: "openai-codex-responses" }, {}, { sessionId: "fork-session" });
		fork.streamSimple({ api: "openai-codex-responses" }, {}, { sessionId: "fork-session:reader" });
		fork.streamSimple({ api: "anthropic-messages" }, {}, { sessionId: "fork-session" });
		fork.streamSimple({ api: "openai-responses" }, {}, { sessionId: "fork-session" });
		expect(shared.calls).toEqual([
			{ api: "openai-codex-responses", sessionId: "parent-session" },
			{ api: "openai-codex-responses", sessionId: "fork-session:reader" },
			{ api: "anthropic-messages", sessionId: "fork-session" },
			{ api: "openai-responses", sessionId: "fork-session" },
		]);
	});

	it("reads and writes every other member on the shared runtime, each method bound once", () => {
		const shared = new FakeRuntime();
		const fork = withParentSessionId(shared as never, "parent-session", () => "fork-session") as unknown as FakeRuntime;
		expect(fork.remember).toBe(fork.remember);
		expect(fork.remember()).toBe(1);
		expect(shared.cached).toBe(1);
		expect(fork.cached).toBe(1);
	});
});
