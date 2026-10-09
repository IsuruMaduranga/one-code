import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import hooksExtension from "../../extensions/hooks/index.ts";
import { approvalStorePath, resetTrustSessionState } from "../../extensions/hooks/trust.ts";
import { resetHookSettingsCache } from "../../extensions/hooks/settings.ts";
import lspExtension from "../../extensions/lsp/index.ts";
import { lspTrustStorePath } from "../../extensions/lsp/trust.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { stubHome } from "./helpers/home.ts";

const state = vi.hoisted(() => ({ runHook: vi.fn(), startServer: vi.fn() }));
vi.mock("../../extensions/hooks/executor.ts", () => ({ runHookCommand: state.runHook }));
vi.mock("../../extensions/lsp/client.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../extensions/lsp/client.ts")>();
	return { ...actual, LspClient: class {
		isRunning = true;
		publishCount = 0;
		async start() { state.startServer(); }
		async getDiagnostics() { return []; }
		allDiagnostics() { return new Map(); }
	} };
});

let root: string;
let cwd: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "rpc-trust-"));
	cwd = join(root, "project");
	mkdirSync(join(cwd, ".claude"), { recursive: true });
	stubHome(root);
	vi.stubEnv("CLAUDE_CONFIG_DIR", join(root, ".claude"));
	vi.stubEnv("ONECODE_CONFIG_MODE", "claude-compatible");
	vi.stubEnv("ONECODE_STATE_DIR", join(root, ".onecode"));
	vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
	resetTrustSessionState();
	resetHookSettingsCache();
	state.startServer.mockReset();
	state.runHook.mockReset().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0, durationMs: 1 });
	writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo trusted" }] }] } }));
	writeFileSync(join(cwd, "Cargo.toml"), "[package]\nname = 'demo'\nversion = '0.1.0'\n");
	writeFileSync(join(cwd, "main.rs"), "fn main() {}\n");
});
afterEach(() => {
	resetTrustSessionState();
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

function mount(kind: "hooks" | "lsp", confirm: ReturnType<typeof vi.fn>, signal: AbortSignal) {
	const fake = createFakePi();
	const ctx = createFakeCtx({ cwd, hasUI: true, mode: "rpc", signal, ui: { confirm } });
	if (kind === "hooks") hooksExtension(fake.pi as never);
	else lspExtension(fake.pi as never);
	const run = () => kind === "hooks"
		? fake.fireOne("tool_call", { toolName: "bash", toolCallId: "t", input: { command: "echo hello" } }, ctx)
		: fake.tools.get("lsp_diagnostics")!.execute("t", { path: "main.rs" }, ctx.signal as AbortSignal, undefined, ctx);
	return { run, ctx };
}

describe.each(["hooks", "lsp"] as const)("%s trust in RPC", (kind) => {
	it("aborting a pending tool's confirm settles the wait without approving or launching", async () => {
		const controller = new AbortController();
		let dismiss!: (value: boolean) => void;
		const confirm = vi.fn((_title: string, _message: string, options?: { signal?: AbortSignal }) => new Promise<boolean>((resolve) => {
			dismiss = resolve;
			if (options?.signal?.aborted) resolve(false);
			else options?.signal?.addEventListener("abort", () => resolve(false), { once: true });
		}));
		const { run, ctx } = mount(kind, confirm, controller.signal);
		const pending = run();
		await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
		controller.abort();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const settled = await Promise.race([pending.then(() => "settled"), new Promise<string>((resolve) => { timer = setTimeout(() => resolve("still waiting for RPC reply"), 50); })]);
			expect(settled).toBe("settled");
			expect(confirm.mock.calls[0][2]?.signal).toBe(controller.signal);
			expect(existsSync(kind === "hooks" ? approvalStorePath() : lspTrustStorePath())).toBe(false);
			expect(state.runHook).not.toHaveBeenCalled();
			expect(state.startServer).not.toHaveBeenCalled();
		} finally {
			clearTimeout(timer);
			dismiss(false);
			await pending;
		}
		// Cancellation is not a remembered refusal: a fresh turn can ask again.
		ctx.signal = new AbortController().signal;
		confirm.mockResolvedValue(true);
		await run();
		expect(confirm).toHaveBeenCalledTimes(2);
		expect(existsSync(kind === "hooks" ? approvalStorePath() : lspTrustStorePath())).toBe(true);
		expect(kind === "hooks" ? state.runHook : state.startServer).toHaveBeenCalledOnce();
	});

	it("a confirm completing true after abort cannot persist trust or launch project code", async () => {
		const controller = new AbortController();
		let answer!: (value: boolean) => void;
		const confirm = vi.fn(() => new Promise<boolean>((resolve) => { answer = resolve; }));
		const { run } = mount(kind, confirm, controller.signal);
		const pending = run();
		await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
		controller.abort();
		answer(true);
		await pending;
		expect(existsSync(kind === "hooks" ? approvalStorePath() : lspTrustStorePath())).toBe(false);
		expect(state.runHook).not.toHaveBeenCalled();
		expect(state.startServer).not.toHaveBeenCalled();
	});
});
