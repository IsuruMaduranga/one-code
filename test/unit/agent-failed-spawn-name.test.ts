import { describe, expect, it } from "vitest";
import subagentsExtension from "../../extensions/subagents/index.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

/**
 * A spawn that fails validation reserves its run name before the agent type is
 * checked. SendMessage's "Known runs" used to list that reservation, offering a
 * recipient that never existed (2026-10-04 Codex self-test, x-agents F1).
 */
describe("Agent: a failed spawn leaves no addressable name", () => {
	it("does not list the failed run's name as a known recipient", async () => {
		const fake = createFakePi();
		subagentsExtension(fake.pi as never);
		const ctx = createFakeCtx();
		const agent = fake.tools.get("Agent");
		const send = fake.tools.get("SendMessage");
		if (!agent || !send) throw new Error("Agent or SendMessage not registered");

		const spawn = (await agent.execute("c1", { subagent_type: "no-such-agent", name: "ghost-run", prompt: "probe" }, undefined, undefined, ctx)) as { isError?: boolean };
		expect(spawn.isError).toBe(true);

		const result = (await send.execute("c2", { to: "ghost-run", message: "hi", summary: "probe" }, undefined, undefined, ctx)) as {
			content: { text?: string }[];
		};
		const text = result.content.map((c) => c.text ?? "").join("");
		expect(text).toContain('No run named "ghost-run"');
		expect(text).toContain("Known runs: (none).");
	});
});
