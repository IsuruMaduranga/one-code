/**
 * `/init` sends Claude Code's classic prompt, with the CLAUDE.md wording
 * named for any compatible agent and AGENTS.md among the rules to fold in.
 */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import initExtension from "../../extensions/init/index.ts";
import { INIT_PROMPT } from "../../extensions/init/prompt.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

describe("/init prompt", () => {
	it("keeps the text", () => {
		expect(INIT_PROMPT.length).toBe(1638);
		expect(createHash("sha256").update(INIT_PROMPT).digest("hex").slice(0, 16)).toBe("d87cf400124e8044");
	});

	it("is Claude Code's classic prompt, adapted only where the file is shared with other agents", () => {
		expect(INIT_PROMPT.startsWith("Please analyze this codebase and create a CLAUDE.md file, which will be given to future AI coding agents (Claude Code and compatible tools) to operate in this repository.\n\nWhat to add:\n1. Commands that will be commonly used")).toBe(true);
		expect(INIT_PROMPT).toContain("- If there are Cursor rules (in .cursor/rules/ or .cursorrules), Copilot rules (in .github/copilot-instructions.md) or an AGENTS.md, make sure to include the important parts.");
		expect(INIT_PROMPT.endsWith("```\n# CLAUDE.md\n\nThis file gives guidance to AI coding agents (Claude Code and compatible tools) working in this repository.\n```")).toBe(true);
		expect(INIT_PROMPT).not.toContain("claude.ai/code");
	});

	it.each(["print", "json"])("waits for the triggered turn in %s mode", async (mode) => {
		const fake = createFakePi();
		initExtension(fake.pi as never);
		let settle!: () => void;
		const idle = new Promise<void>((resolve) => { settle = resolve; });
		const waitForIdle = vi.fn(() => {
			expect(fake.sentUserMessages).toHaveLength(1);
			return idle;
		});
		let returned = false;
		const run = fake.commands.get("init")!.handler("", createFakeCtx({ mode, waitForIdle })).then(() => { returned = true; });
		try {
			await vi.waitFor(() => expect(waitForIdle).toHaveBeenCalledTimes(1));
			expect(returned).toBe(false);
		} finally {
			settle();
			await run;
		}
		expect(returned).toBe(true);
	});

	it.each(["tui", "rpc"])("does not wait for the triggered turn in %s mode", async (mode) => {
		const fake = createFakePi();
		initExtension(fake.pi as never);
		const waitForIdle = vi.fn(async () => {});
		await fake.commands.get("init")!.handler("", createFakeCtx({ mode, waitForIdle }));
		expect(fake.sentUserMessages).toHaveLength(1);
		expect(waitForIdle).not.toHaveBeenCalled();
	});

	it("submits it as a user turn", async () => {
		const fake = createFakePi();
		initExtension(fake.pi as never);
		await fake.commands.get("init")!.handler("", createFakeCtx());
		expect(fake.sentUserMessages).toEqual([{ content: INIT_PROMPT, options: { deliverAs: "followUp" } }]);
	});
});
