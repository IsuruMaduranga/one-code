/** Regression probes from the claude-context independent-mode audit. */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import claudeContextExtension from "../../extensions/claude-context/index.ts";
import systemReminderExtension from "../../extensions/system-reminder/index.ts";
import { discoverContextFiles, discoverOneCodeFiles, nestedInstructionFiles } from "../../extensions/lib/claude-context.ts";
import { resetConfigModeForTest } from "../../extensions/lib/config-mode.ts";
import { REMINDER_CHANNEL } from "../../extensions/lib/reminders.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { stubHome } from "./helpers/home.ts";

let root: string;
beforeEach(() => {
	mkdirSync(join(process.cwd(), ".scratch"), { recursive: true });
	root = mkdtempSync(join(process.cwd(), ".scratch", "claude-context-audit-"));
	stubHome(join(root, "home"));
	vi.stubEnv("ONECODE_STATE_DIR", join(root, "onecode-state"));
	resetConfigModeForTest("independent");
});
afterEach(() => {
	vi.unstubAllEnvs();
	resetConfigModeForTest();
	rmSync(root, { recursive: true, force: true });
});

describe("claude-context audit", () => {
	it("honors CLAUDE_CONFIG_DIR for startup and conditional user rules, but not in independent mode", async () => {
		const config = join(root, "relocated-config");
		mkdirSync(join(config, "rules"), { recursive: true });
		writeFileSync(join(config, "rules", "always.md"), "RELOCATED STARTUP RULE\n");
		writeFileSync(join(config, "rules", "conditional.md"), "---\npaths: '*.ts'\n---\nRELOCATED CONDITIONAL RULE\n");
		writeFileSync(join(root, "source.ts"), "export {};\n");
		vi.stubEnv("CLAUDE_CONFIG_DIR", config);
		for (const mode of ["claude-compatible", "independent"] as const) {
			resetConfigModeForTest(mode);
			const fake = createFakePi();
			const text: string[] = [];
			fake.events.on(REMINDER_CHANNEL, (data) => {
				const payload = data as { text?: string };
				if (payload.text) text.push(payload.text);
			});
			claudeContextExtension(fake.pi as never);
			const ctx = createFakeCtx({ cwd: root });
			await fake.fireOne("session_start", {}, ctx);
			expect(text.join("\n").includes("RELOCATED STARTUP RULE")).toBe(mode === "claude-compatible");
			expect(text.join("\n")).not.toContain("RELOCATED CONDITIONAL RULE");
			await fake.fire("tool_result", { toolName: "bash", input: { command: "cat source.ts" }, isError: false, content: [] }, ctx);
			expect(text.join("\n")).not.toContain("RELOCATED CONDITIONAL RULE");
			await fake.fire("tool_result", { toolName: "read", input: { path: "source.ts" }, isError: false, content: [] }, ctx);
			expect(text.join("\n").includes("RELOCATED CONDITIONAL RULE")).toBe(mode === "claude-compatible");
		}
	});
	it("puts a symlinked ancestor's AGENTS.md in startup context only once", async () => {
		mkdirSync(join(root, "child"), { recursive: true });
		writeFileSync(join(root, "AGENTS.md"), "UNIQUE AGENT INSTRUCTION\n");
		writeFileSync(join(root, "ONECODE.md"), "UNIQUE ONECODE INSTRUCTION\n");
		symlinkSync(root, join(root, "alias"));

		const fake = createFakePi();
		const reminders: Array<{ key?: string; text?: string }> = [];
		fake.events.on(REMINDER_CHANNEL, (data) => reminders.push(data as never));
		claudeContextExtension(fake.pi as never);
		await fake.fireOne("session_start", {}, createFakeCtx({ cwd: join(root, "alias", "child") }));

		const startup = reminders.find((reminder) => reminder.key === "claude-context")?.text ?? "";
		const oneCode = reminders.find((reminder) => reminder.key === "one-code-context")?.text ?? "";
		expect([startup.match(/UNIQUE AGENT INSTRUCTION/g)?.length, oneCode.match(/UNIQUE ONECODE INSTRUCTION/g)?.length]).toEqual([1, 1]);
	});

	it.each([
		{ input: { limit: 1 }, details: undefined },
		{ input: { offset: 2 }, details: undefined },
		{ input: {}, details: { truncation: { truncated: true } } },
	])("does not treat a partial instruction read as the entire file: %j", async ({ input, details }) => {
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "src", "AGENTS.md"), "Title\nUNSEEN INSTRUCTION\n");
		writeFileSync(join(root, "src", "source.ts"), "export {};\n");
		const fake = createFakePi();
		const attached: string[] = [];
		fake.events.on(REMINDER_CHANNEL, (data) => {
			const payload = data as { text?: string; placement?: string };
			if (!payload.placement && payload.text) attached.push(payload.text);
		});
		claudeContextExtension(fake.pi as never);
		const ctx = createFakeCtx({ cwd: root });
		await fake.fireOne("session_start", {}, ctx);
		await fake.fire("tool_result", { toolName: "read", toolCallId: "partial", input: { path: "src/AGENTS.md", ...input }, details, content: [{ type: "text", text: "Title" }], isError: false }, ctx);
		await fake.fire("tool_result", { toolName: "read", toolCallId: "source", input: { path: "src/source.ts" }, isError: false, content: [] }, ctx);
		expect(attached.filter((text) => text.includes("UNSEEN INSTRUCTION"))).toHaveLength(1);
	});

	it("does not attach an AGENTS.md already expanded from startup ONECODE.md", async () => {
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "ONECODE.md"), "@src/AGENTS.md\n");
		writeFileSync(join(root, "src", "AGENTS.md"), "ONECODE-IMPORTED AGENT RULE\n");
		writeFileSync(join(root, "src", "source.ts"), "export {};\n");

		const fake = createFakePi();
		const attached: string[] = [];
		fake.events.on(REMINDER_CHANNEL, (data) => {
			const payload = data as { text?: string; placement?: string };
			if (!payload.placement && payload.text) attached.push(payload.text);
		});
		claudeContextExtension(fake.pi as never);
		const ctx = createFakeCtx({ cwd: root });
		await fake.fireOne("session_start", {}, ctx);
		await fake.fire("tool_result", { toolName: "read", input: { path: "src/source.ts" }, isError: false, content: [] }, ctx);

		expect(attached).toEqual([]);
	});

	it.each([false, true])("keeps retained nested attachments deduped (persisted into next result: %s)", async (persisted) => {
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "src", "AGENTS.md"), "RETAINED NESTED RULE\n");
		writeFileSync(join(root, "src", "source.ts"), "export {};\n");
		const fake = createFakePi();
		const attached: string[] = [];
		fake.events.on(REMINDER_CHANNEL, (data) => {
			const payload = data as { text?: string; placement?: string };
			if (!payload.placement && payload.text?.includes("RETAINED NESTED RULE")) attached.push(payload.text);
		});
		systemReminderExtension(fake.pi as never);
		claudeContextExtension(fake.pi as never);
		const ctx = createFakeCtx({ cwd: root });
		const read = (toolCallId = "read-1") => fake.fire("tool_result", { toolName: "read", toolCallId, input: { path: "src/source.ts" }, isError: false, content: [] }, ctx);
		await fake.fireOne("session_start", {}, ctx);
		await read();
		if (persisted) await fake.fire("tool_result", { toolName: "bash", toolCallId: "parallel-result", input: { command: "true" }, isError: false, content: [] }, ctx);
		// The later system-reminder hook either persisted the one-shot into the
		// parallel result above, or pins it on the next request below.
		await fake.fireOne("context", {
			messages: [
				{ role: "user", content: [{ type: "text", text: "read it" }], timestamp: 1 },
				{ role: "assistant", content: [], timestamp: 2 },
				{ role: "toolResult", toolCallId: "read-1", content: [], timestamp: 3 },
			],
		}, ctx);
		const branch = [
			{ type: "message", id: "a1", message: { role: "assistant", content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/source.ts" } }] } },
			{ type: "message", id: "r1", message: { role: "toolResult", toolCallId: "read-1", isError: false } },
			...(persisted ? [{ type: "message", id: "r2", message: { role: "toolResult", toolCallId: "parallel-result", isError: false } }] : []),
			{ type: "compaction", id: "c1", firstKeptEntryId: "a1", timestamp: new Date().toISOString() },
		];
		await fake.fire("session_compact", { compactionEntry: branch.at(-1), fromExtension: false, reason: "manual", willRetry: false }, createFakeCtx({ cwd: root, sessionManager: { getBranch: () => branch } }));
		await read("read-2");

		expect(attached).toHaveLength(1);
		// Once the carrier is really discarded, a subsequent read must restore the instruction.
		await fake.fire("session_compact", {}, createFakeCtx({ cwd: root, sessionManager: { getBranch: () => [] } }));
		await read("read-3");
		expect(attached).toHaveLength(2);
	});

	it("removes deleted startup instructions when session_start runs again", async () => {
		// Use global locations and / as cwd so the second startup has no ancestor
		// project file that happens to replace the stale key.
		resetConfigModeForTest("claude-compatible");
		const claudeConfig = join(root, "claude-config");
		const oneCodeState = join(root, "onecode-state");
		mkdirSync(claudeConfig, { recursive: true });
		mkdirSync(oneCodeState, { recursive: true });
		const claude = join(claudeConfig, "CLAUDE.md");
		const oneCode = join(oneCodeState, "ONECODE.md");
		writeFileSync(claude, "STALE CLAUDE INSTRUCTION\n");
		writeFileSync(oneCode, "STALE ONECODE INSTRUCTION\n");
		vi.stubEnv("CLAUDE_CONFIG_DIR", claudeConfig);
		vi.stubEnv("ONECODE_STATE_DIR", oneCodeState);
		const fake = createFakePi();
		// The queue must be installed before claude-context, as it is in the extension load order.
		systemReminderExtension(fake.pi as never);
		claudeContextExtension(fake.pi as never);
		const ctx = createFakeCtx({ cwd: "/" });
		const request = (text: string) => [{ role: "user", content: [{ type: "text", text }], timestamp: 1 }] as never;
		await fake.fireOne("session_start", {}, ctx);
		await fake.fireOne("context", { messages: request("first session") }, ctx);

		rmSync(claude);
		rmSync(oneCode);
		await fake.fireOne("session_start", {}, ctx);
		const afterClear = await fake.fireOne<{ messages: unknown[] }>("context", { messages: request("after clear") }, ctx);

		expect(JSON.stringify(afterClear?.messages)).not.toContain("STALE");
	});

	it("does not discover startup AGENTS.md through an alias into .claude", () => {
		const hidden = join(root, ".claude");
		mkdirSync(join(hidden, "child"), { recursive: true });
		writeFileSync(join(hidden, "AGENTS.md"), "HIDDEN STARTUP RULE\n");
		symlinkSync(hidden, join(root, "alias"));
		const files = discoverContextFiles({ cwd: join(root, "alias", "child"), home: root, homeClaudeDir: join(root, "home"), rule: "agents-md" });
		expect(files.some((file) => file.content.includes("HIDDEN STARTUP RULE"))).toBe(false);
	});

	it("does not read Claude locations through AGENTS/ONECODE imports", () => {
		mkdirSync(join(root, ".claude"));
		writeFileSync(join(root, ".claude", "private.md"), "HIDDEN IMPORT RULE\n");
		writeFileSync(join(root, "AGENTS.md"), "@.claude/private.md\n");
		writeFileSync(join(root, "ONECODE.md"), "@.claude/private.md\n");
		const files = discoverContextFiles({ cwd: root, home: root, homeClaudeDir: join(root, "home"), rule: "agents-md" });
		const oneCode = discoverOneCodeFiles({ cwd: root, home: root, homeOneCodeDir: join(root, "home-onecode") });
		expect([...files, ...oneCode].some((file) => file.content.includes("HIDDEN IMPORT RULE"))).toBe(false);
	});

	it("does not enter a .claude directory through a project symlink when attaching nested AGENTS.md", () => {
		mkdirSync(join(root, ".claude", "nested"), { recursive: true });
		writeFileSync(join(root, ".claude", "AGENTS.md"), "CLAUDE-LOCATION AGENTS\n");
		writeFileSync(join(root, ".claude", "nested", "source.ts"), "export {};\n");
		symlinkSync(join(root, ".claude"), join(root, "alias"));

		expect(
			nestedInstructionFiles({
				cwd: root,
				filePath: join(root, "alias", "nested", "source.ts"),
				rule: "agents-md",
				home: root,
			}),
		).toEqual([]);
	});
});
