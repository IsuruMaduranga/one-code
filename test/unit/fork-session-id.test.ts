/**
 * lib/agents/agent-loader.ts codexRoutingId: a fork sends its requests under
 * its parent's session id on Codex only (findings §75); every other provider,
 * and a session with no parent, keeps its own id.
 */
import { describe, expect, it } from "vitest";
import { codexRoutingId } from "../../extensions/lib/agents/agent-loader.ts";

describe("codexRoutingId", () => {
	it("is the parent's session id for a Codex fork", () => {
		expect(codexRoutingId("openai-codex-responses", "parent-session")).toBe("parent-session");
	});

	it("leaves every other provider on the fork's own id", () => {
		for (const api of ["anthropic-messages", "openai-responses", "openai-completions", "bedrock-converse-stream", undefined]) {
			expect(codexRoutingId(api, "parent-session")).toBeUndefined();
		}
	});

	it("is nothing for a session with no parent", () => {
		expect(codexRoutingId("openai-codex-responses", undefined)).toBeUndefined();
	});
});
