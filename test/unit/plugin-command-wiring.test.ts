import { ONE_SHOT_COMMAND_FAILED_CHANNEL } from "../../extensions/lib/interrupt.ts";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pluginsExtension from "../../extensions/plugins/index.ts";
import { invalidatePluginsCache } from "../../extensions/lib/plugins.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { stubHome } from "./helpers/home.ts";
import { captureUserTurns } from "./helpers/user-turn.ts";
import { SUBAGENT_GATE_CHANNEL } from "../../extensions/permissions/subagent-gate.ts";
import { shellQuote } from "../../extensions/lib/shell-quote.ts";
import { WORKTREE_CHANNEL } from "../../extensions/lib/worktree-channel.ts";

let home: string;
let exitCode: typeof process.exitCode;
beforeEach(() => {
	exitCode = process.exitCode;
	process.exitCode = undefined;
	home = mkdtempSync(join(tmpdir(), "onecode-plugin-command-"));
	stubHome(home);
	vi.stubEnv("PI_CODING_AGENT_DIR", join(home, "agent"));
	const plugin = join(home, "fixture");
	mkdirSync(join(plugin, "commands"), { recursive: true });
	mkdirSync(join(home, "agent", "plugins"), { recursive: true });
	writeFileSync(join(plugin, "commands", "ping.md"), "Reply with $ARGUMENTS");
	writeFileSync(join(home, "agent", "plugins", "installed_plugins.json"), JSON.stringify({
		plugins: { "fixture@local": [{ installPath: plugin, enabled: true }] },
	}));
	invalidatePluginsCache();
});
afterEach(() => {
	process.exitCode = exitCode;
	vi.restoreAllMocks();
	invalidatePluginsCache();
	vi.unstubAllEnvs();
	rmSync(home, { recursive: true, force: true });
});

describe("plugin command user turns", () => {
	it("asks the permission bridge before a template shell command and respects its denial", async () => {
		const marker = join(home, "must-not-run");
		const command = `printf marker > ${shellQuote(marker)}`;
		writeFileSync(join(home, "fixture", "commands", "ping.md"), `Before !\`${command}\` after`);
		const fake = createFakePi();
		pluginsExtension(fake.pi as never);
		const decide = vi.fn(async () => ({ block: true as const, reason: "denied by rule" }));
		fake.events.emit(SUBAGENT_GATE_CHANNEL, { decide });
		const ctx = createFakeCtx({ cwd: home, mode: "tui" });
		await fake.commands.get("fixture:ping")!.handler("", ctx);
		expect(existsSync(marker)).toBe(false);
		expect(decide).toHaveBeenCalledWith(expect.objectContaining({ toolName: "bash", input: { command }, cwd: home }));
		expect(fake.sentUserMessages).toEqual([]);
	});

	it("fails closed for template shell commands when the permission bridge is absent", async () => {
		const marker = join(home, "must-not-run");
		writeFileSync(join(home, "fixture", "commands", "ping.md"), `!\`printf marker > ${shellQuote(marker)}\``);
		const fake = createFakePi();
		pluginsExtension(fake.pi as never);
		await fake.commands.get("fixture:ping")!.handler("", createFakeCtx({ cwd: home, mode: "tui" }));
		expect(existsSync(marker)).toBe(false);
		expect(fake.sentUserMessages).toEqual([]);
	});

	it("expands an approved shell placeholder with the same quoted arguments the gate checked", async () => {
		writeFileSync(join(home, "fixture", "commands", "ping.md"), "Before !`printf '%s' $ARGUMENTS` after");
		const fake = createFakePi();
		pluginsExtension(fake.pi as never);
		const decide = vi.fn(async () => undefined);
		fake.events.emit(SUBAGENT_GATE_CHANNEL, { decide });
		await fake.commands.get("fixture:ping")!.handler("literal;value", createFakeCtx({ cwd: home, mode: "tui" }));
		expect(decide).toHaveBeenCalledWith(expect.objectContaining({ input: { command: "printf '%s' 'literal;value'" } }));
		expect(fake.sentUserMessages[0].content).toBe("Before literal;value after");
	});

	it("runs an approved placeholder, and asks the gate, in the entered worktree", async () => {
		const worktree = join(home, "wt");
		mkdirSync(worktree);
		writeFileSync(join(home, "fixture", "commands", "ping.md"), "In !`pwd`");
		const fake = createFakePi();
		pluginsExtension(fake.pi as never);
		const decide = vi.fn(async () => undefined);
		fake.events.emit(SUBAGENT_GATE_CHANNEL, { decide });
		fake.events.emit(WORKTREE_CHANNEL, { path: worktree, branch: "wt" });
		await fake.commands.get("fixture:ping")!.handler("", createFakeCtx({ cwd: home, mode: "tui" }));
		expect(decide).toHaveBeenCalledWith(expect.objectContaining({ cwd: worktree }));
		expect(realpathSync(String(fake.sentUserMessages[0].content).slice(3).trim())).toBe(realpathSync(worktree));
	});

	it.each(["print", "json"])("reports a blocked shell placeholder as failure in %s without starting a turn", async (mode) => {
		writeFileSync(join(home, "fixture", "commands", "ping.md"), "!`printf never`");
		const fake = createFakePi();
		const failures: unknown[] = [];
		fake.events.on(ONE_SHOT_COMMAND_FAILED_CHANNEL, (data: unknown) => failures.push(data));
		pluginsExtension(fake.pi as never);
		fake.events.emit(SUBAGENT_GATE_CHANNEL, { decide: async () => ({ block: true, reason: "denied by rule" }) });
		const output = vi.spyOn(console, "error").mockImplementation(() => {});
		await fake.commands.get("fixture:ping")!.handler("", createFakeCtx({ mode, cwd: home }));
		expect(fake.sentUserMessages).toEqual([]);
		expect(output.mock.calls.flat().join("\n")).toContain("Shell placeholder blocked: denied by rule");
		expect(failures).toHaveLength(1);
	});

	it.each(["print", "json"])("reports a vanished command template instead of succeeding silently in %s", async (mode) => {
		const fake = createFakePi();
		const failures: unknown[] = [];
		fake.events.on(ONE_SHOT_COMMAND_FAILED_CHANNEL, (data: unknown) => failures.push(data));
		pluginsExtension(fake.pi as never);
		unlinkSync(join(home, "fixture", "commands", "ping.md"));
		const output = vi.spyOn(console, "error").mockImplementation(() => {});
		await fake.commands.get("fixture:ping")!.handler("ARGS", createFakeCtx({ mode, cwd: home }));
		expect(fake.sentUserMessages).toEqual([]);
		expect(output.mock.calls.flat().join("\n")).toContain("unavailable");
		expect(failures).toHaveLength(1);
	});

	it.each(["print", "json"])("waits for startup then settlement in %s", async (mode) => {
		const fake = createFakePi();
		const startTurn = captureUserTurns(fake);
		pluginsExtension(fake.pi as never);
		let settle!: () => void;
		const idle = new Promise<void>((resolve) => { settle = resolve; });
		const waitForIdle = vi.fn(() => idle);
		let returned = false;
		const running = fake.commands.get("fixture:ping")!.handler("PLUGIN_OK", createFakeCtx({
			mode, cwd: home, waitForIdle,
			sessionManager: { getSessionDir: () => join(home, "sessions") },
		})).then(() => { returned = true; });
		try {
			await vi.waitFor(() => expect(fake.sentUserMessages).toHaveLength(1));
			expect(fake.sentUserMessages[0].content).toBe("Reply with PLUGIN_OK");
			expect(returned).toBe(false);
			expect(waitForIdle).not.toHaveBeenCalled();
			await startTurn();
			await vi.waitFor(() => expect(waitForIdle).toHaveBeenCalledTimes(1));
			expect(returned).toBe(false);
		} finally {
			settle();
			await running;
		}
		expect(returned).toBe(true);
	});
});
