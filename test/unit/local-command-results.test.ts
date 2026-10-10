import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import effortExtension from "../../extensions/effort/index.ts";
import skillExtension from "../../extensions/skill/index.ts";
import workflowExtension from "../../extensions/workflow/index.ts";
import memoryExtension from "../../extensions/memory/index.ts";
import { editorHint } from "../../extensions/memory/open-external.ts";

vi.mock("../../extensions/memory/open-external.ts", async (importOriginal) => ({
	...await importOriginal<typeof import("../../extensions/memory/open-external.ts")>(),
	openPath: vi.fn(async () => ({ ok: true })),
}));
import { localCommandBlocks } from "../../extensions/lib/local-command.ts";
import { REMINDER_CHANNEL, type ReminderPayload } from "../../extensions/lib/reminders.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { stubHome } from "./helpers/home.ts";

let home: string;
let cwd: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "command-results-"));
	cwd = join(home, "project");
	mkdirSync(cwd);
	stubHome(home);
	vi.stubEnv("PI_CODING_AGENT_DIR", join(home, "agent"));
	vi.stubEnv("ONECODE_STATE_DIR", join(home, ".onecode"));
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(home, { recursive: true, force: true });
});

function mount(extension: (pi: never) => void) {
	const fake = createFakePi();
	const blocks: string[] = [];
	fake.events.on(REMINDER_CHANNEL, (data) => {
		const payload = data as ReminderPayload;
		if (payload.placement === "user-prepend" && payload.text !== undefined) blocks.push(payload.text);
	});
	extension(fake.pi as never);
	return { fake, blocks, ctx: createFakeCtx({ cwd, hasUI: true, mode: "tui" }) };
}

describe("Claude Code 2.1.296 local-command results", () => {
	it("records dynamic workflows dialog dismissal", async () => {
		const { fake, ctx, blocks } = mount(workflowExtension);
		await fake.commands.get("workflows")!.handler("", ctx);
		expect(blocks).toEqual(localCommandBlocks({ name: "workflows", stdout: "Dynamic workflows dialog dismissed" }));
		await fake.fire("session_shutdown", {}, ctx);
	});

	it("records the opened memory file with one newline before the editor hint", async () => {
		const { fake, ctx, blocks } = mount(memoryExtension);
		(ctx.ui as { custom: ReturnType<typeof vi.fn> }).custom.mockResolvedValue({ path: join(cwd, "CLAUDE.md"), kind: "file" });
		await fake.commands.get("memory")!.handler("", ctx);
		expect(blocks).toEqual(localCommandBlocks({ name: "memory", stdout: `Opened ./CLAUDE.md\n${editorHint()}` }));
	});

	it("records the skills dismissal after the panel closes", async () => {
		const { fake, ctx, blocks } = mount(skillExtension);
		let close!: () => void;
		(ctx.ui as { custom: ReturnType<typeof vi.fn> }).custom.mockImplementation(() => new Promise<void>((resolve) => { close = resolve; }));
		const pending = fake.commands.get("skills")!.handler("", ctx);
		expect(blocks).toEqual([]);
		close();
		await pending;
		expect(blocks).toEqual(localCommandBlocks({ name: "skills", stdout: "Skills dialog dismissed" }));
		expect(fake.sentUserMessages).toEqual([]);
	});

	it.each([
		["low", "Quick, straightforward implementation with minimal overhead"],
		["medium", "Balanced approach with standard implementation and testing"],
		["high", "Comprehensive implementation with extensive testing and documentation"],
		["xhigh", "Deeper reasoning than high, just below maximum (on supported models)"],
		["max", "Maximum capability with deepest reasoning. May use excessive tokens resulting in long response times or overthinking. Use sparingly for the hardest tasks."],
	])("records the actual session-only effort result for %s", async (level, description) => {
		// No model in the context, so nothing is saved (effort-persistence.test.ts covers saving).
		const { fake, ctx, blocks } = mount(effortExtension);
		fake.pi.getThinkingLevel = () => level;
		await fake.commands.get("effort")!.handler(level, ctx);
		expect(blocks).toEqual(localCommandBlocks({ name: "effort", args: level, stdout: `Set effort level to ${level} (this session only): ${description}` }));
		await fake.fire("session_shutdown", {}, ctx);
	});

	it("says ultracode is off when a plain level replaces it", async () => {
		const { fake, ctx, blocks } = mount(effortExtension);
		await fake.commands.get("effort")!.handler("ultracode", ctx);
		blocks.length = 0;
		fake.pi.getThinkingLevel = () => "high";
		await fake.commands.get("effort")!.handler("high", ctx);
		expect(blocks).toEqual(localCommandBlocks({ name: "effort", args: "high", stdout: "Set effort level to high (this session only): Comprehensive implementation with extensive testing and documentation · Ultracode off" }));
		await fake.fire("session_shutdown", {}, ctx);
	});

	it("records effort slider cancellation without claiming a change", async () => {
		const { fake, ctx, blocks } = mount(effortExtension);
		(ctx.ui as { custom: ReturnType<typeof vi.fn> }).custom.mockResolvedValue(null);
		await fake.commands.get("effort")!.handler("", ctx);
		expect(fake.pi.setThinkingLevel).not.toHaveBeenCalled();
		expect(blocks).toEqual(localCommandBlocks({ name: "effort", stdout: "Cancelled" }));
	});
});
