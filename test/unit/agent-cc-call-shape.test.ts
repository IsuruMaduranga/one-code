import { describe, expect, it } from "vitest";
import subagentsExtension from "../../extensions/subagents/index.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

/**
 * Claude Code's Agent tool takes `prompt` (the task) and `description` (a short
 * title), and requires the task. One Code's tool was renamed to CC's surface but
 * kept `task`; a CC-trained model's `{subagent_type, description, prompt}` used
 * to pass pi's validation (unknown keys are not rejected) with `task` undefined,
 * so the child was prompted with an empty string and no error surfaced
 * (TOOL-FIDELITY-REVIEW-2026-09-07 H1). These lock the two paths that don't
 * spawn a child: the fail-loud on a missing task, and that `prompt` is accepted
 * as the task (an unknown agent then fails, proving the task was read, not the
 * empty-task path).
 */
function agentTool() {
	const fake = createFakePi();
	subagentsExtension(fake.pi as never);
	const tool = fake.tools.get("Agent");
	if (!tool) throw new Error("Agent tool not registered");
	return tool;
}

const run = (params: Record<string, unknown>) =>
	agentTool().execute("call-1", params, undefined, undefined, createFakeCtx());

const text = (result: unknown) => {
	const content = (result as { content?: Array<{ text?: string }> }).content ?? [];
	return content.map((c) => c.text ?? "").join("");
};

describe("Agent tool, Claude Code call shape (H1)", () => {
	it("fails loud when a run names an agent but has no task", async () => {
		const result = (await run({ subagent_type: "general-purpose" })) as { isError?: boolean };
		expect(result.isError).toBe(true);
		expect(text(result)).toMatch(/`task` is required/);
	});

	it("rejects a blank task rather than spawning an empty child", async () => {
		const result = (await run({ subagent_type: "general-purpose", prompt: "   " })) as { isError?: boolean };
		expect(result.isError).toBe(true);
		expect(text(result)).toMatch(/required/);
	});

	it("accepts `prompt` as the task (CC's name), reaching agent validation", async () => {
		// A CC-shaped call whose agent name is unknown must fail at agent lookup,
		// NOT at the empty-task guard — proving `prompt` was read as the task.
		const result = (await run({
			subagent_type: "does-not-exist",
			description: "Audit auth",
			prompt: "Audit the authentication flow for bypasses.",
		})) as { isError?: boolean };
		expect(result.isError).toBe(true);
		expect(text(result)).toMatch(/Unknown agent/);
		expect(text(result)).not.toMatch(/`task` is required/);
	});
});
