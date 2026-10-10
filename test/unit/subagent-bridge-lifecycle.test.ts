import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classify } from "../../extensions/auto-mode/classifier.ts";
import { MODE_CHANNEL } from "../../extensions/lib/plan-mode-channels.ts";
import permissionsExtension from "../../extensions/permissions/index.ts";
import { type PermissionBridge, SUBAGENT_GATE_CHANNEL, watchPermissionBridge } from "../../extensions/permissions/subagent-gate.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";
import { buildGate } from "./helpers/permission-gate-harness.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

vi.mock("../../extensions/permissions/settings.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../extensions/permissions/settings.ts")>()),
	outsideReadPromptSeen: () => false,
}));

vi.mock("../../extensions/auto-mode/classifier.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../extensions/auto-mode/classifier.ts")>()),
	classify: vi.fn(async () => ({ decision: "allow", reason: "", tier: "allow" })),
}));

describe("subagent permission bridge lifecycle", () => {
	let root: string;
	let cwd: string;
	let fake: FakePi;
	let ctx: Record<string, unknown>;
	let bridge: PermissionBridge;

	beforeEach(async () => {
		vi.mocked(classify).mockReset();
		vi.mocked(classify).mockResolvedValue({ decision: "allow", reason: "", tier: "allow" } as never);
		root = mkdtempSync(join(tmpdir(), "bridge-lifecycle-"));
		cwd = join(root, "project");
		mkdirSync(cwd);
		vi.stubEnv("CLAUDE_CONFIG_DIR", join(root, ".claude"));
		vi.stubEnv("ONECODE_STATE_DIR", join(root, ".onecode"));
		vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
		fake = createFakePi();
		fake.events.on(SUBAGENT_GATE_CHANNEL, (data) => {
			const next = (data as { decide?: PermissionBridge } | undefined)?.decide;
			if (next) bridge = next;
		});
		permissionsExtension(fake.pi as never);
		ctx = createFakeCtx({
			cwd,
			modelRegistry: { getAvailable: () => [] },
			sessionManager: { getSessionId: () => "parent-1", getSessionDir: () => join(root, "session"), getBranch: () => [] },
		});
		await fake.fire("session_start", { reason: "startup" }, ctx);
		fake.events.emit(MODE_CHANNEL, { mode: "acceptEdits" });
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	const writeCall = () => ({ toolName: "write", input: { path: "output.txt", content: "child" }, cwd });

	it("applies Agent(type) deny rules to both main and bridged delegations before classification", async () => {
		mkdirSync(join(cwd, ".claude"));
		writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({ permissions: { deny: ["Agent(explore)"] } }));
		await fake.fire("session_start", { reason: "reload" }, ctx);
		fake.events.emit(MODE_CHANNEL, { mode: "auto" });
		const call = { toolName: "Agent", input: { subagent_type: "Explore", prompt: "Inspect the repository" }, cwd };
		expect(await bridge(call)).toMatchObject({ block: true });
		expect(await fake.fireOne("tool_call", { ...call, toolCallId: "agent-1" }, ctx)).toMatchObject({ block: true });
		expect(classify).not.toHaveBeenCalled();
	});

	it("keeps the stopped bridge published after shutdown, so a child resolving it then is denied", async () => {
		const getBridge = watchPermissionBridge(fake.pi as never);
		await fake.fire("session_start", { reason: "reload" }, ctx);
		fake.events.emit(MODE_CHANNEL, { mode: "acceptEdits" });
		await fake.fire("session_shutdown", {}, ctx);
		const gate = buildGate({ permissions: {} }, getBridge);
		expect(await gate.handler({ toolName: "write", input: { path: "output.txt", content: "child" } })).toMatchObject({ block: true });
	});

	it("rejects calls through a retained bridge after parent shutdown", async () => {
		const retained = bridge;
		await fake.fire("session_shutdown", {}, ctx);
		expect(await retained(writeCall())).toMatchObject({ block: true });
	});

	it("rejects an old bridge after session replacement, but permits the new session's bridge", async () => {
		const retained = bridge;
		await fake.fire("session_start", { reason: "new" }, ctx);
		fake.events.emit(MODE_CHANNEL, { mode: "acceptEdits" });
		expect(await retained(writeCall())).toMatchObject({ block: true });
		expect(await bridge(writeCall())).toBeUndefined();
	});

	it("does not approve an already aborted child's fast-path call", async () => {
		const controller = new AbortController();
		controller.abort();
		expect(await bridge({ ...writeCall(), signal: controller.signal })).toMatchObject({ block: true });
	});

	it("cancels a child's pending classifier and rejects a late allow after shutdown", async () => {
		fake.events.emit(MODE_CHANNEL, { mode: "auto" });
		const started = deferred<void>();
		const outcome = deferred<Awaited<ReturnType<typeof classify>>>();
		vi.mocked(classify).mockImplementationOnce(async () => {
			started.resolve();
			return outcome.promise;
		});
		const pending = bridge({ toolName: "bash", input: { command: "curl https://example.com" }, cwd });
		await started.promise;
		await fake.fire("session_shutdown", {}, ctx);
		outcome.resolve({ decision: "allow", reason: "", tier: "allow" } as never);
		expect(await pending).toMatchObject({ block: true });
	});

	it("aborts a pending child permission dialog when its parent shuts down", async () => {
		const shown = deferred<AbortSignal | undefined>();
		const answer = deferred<string | undefined>();
		ctx = createFakeCtx({ ...ctx, hasUI: true, ui: {
			select: vi.fn(async (_title, _options, options) => {
				shown.resolve(options?.signal);
				return answer.promise;
			}),
		} });
		await fake.fire("session_start", { reason: "reload" }, ctx);
		fake.events.emit(MODE_CHANNEL, { mode: "default" });
		const pending = bridge(writeCall());
		const signal = await shown.promise;
		await fake.fire("session_shutdown", {}, ctx);
		answer.resolve("Yes");
		expect(await pending).toMatchObject({ block: true });
		expect(signal?.aborted).toBe(true);
	});

	it("cancels the first outside-read consent dialog with the child's signal, not the parent's turn", async () => {
		const shown = deferred<AbortSignal | undefined>();
		const answer = deferred<string | undefined>();
		const parent = new AbortController();
		const child = new AbortController();
		const outside = join(root, "outside.txt");
		writeFileSync(outside, "outside the project");
		ctx = createFakeCtx({ ...ctx, hasUI: true, signal: parent.signal, ui: {
			select: vi.fn(async (_title, _options, options) => {
				shown.resolve(options?.signal);
				return answer.promise;
			}),
		} });
		await fake.fire("session_start", { reason: "reload" }, ctx);
		fake.events.emit(MODE_CHANNEL, { mode: "auto" });
		const pending = bridge({ toolName: "read", input: { path: outside }, cwd, signal: child.signal,
			model: { provider: "anthropic", id: "claude-opus-4-8" } as never });
		const signal = await Promise.race([shown.promise, pending.then((result) => { throw new Error(`Expected outside-read prompt, received ${JSON.stringify(result)}`); })]);
		child.abort();
		answer.resolve(undefined);
		expect(await pending).toMatchObject({ block: true });
		expect(signal?.aborted).toBe(true);
		expect(parent.signal.aborted).toBe(false);
	});

	it("skips a stopped child's outside-read prompt queued behind another permission dialog", async () => {
		const shown = deferred<void>();
		const answer = deferred<string | undefined>();
		const child = new AbortController();
		const outside = join(root, "outside.txt");
		writeFileSync(outside, "outside the project");
		const select = vi.fn(async () => undefined as string | undefined);
		select.mockImplementationOnce(async () => { shown.resolve(); return answer.promise; });
		ctx = createFakeCtx({ ...ctx, hasUI: true, ui: { select } });
		await fake.fire("session_start", { reason: "reload" }, ctx);
		fake.events.emit(MODE_CHANNEL, { mode: "auto" });
		const call = { toolName: "read", input: { path: outside }, cwd,
			model: { provider: "anthropic", id: "claude-opus-4-8" } as never };
		const first = bridge(call);
		await shown.promise;
		const queued = bridge({ ...call, signal: child.signal });
		// Let the child enter the shared prompt queue before it is stopped.
		await new Promise((resolve) => setImmediate(resolve));
		child.abort();
		answer.resolve(undefined);
		await first;
		expect(await queued).toMatchObject({ block: true });
		expect(select).toHaveBeenCalledTimes(1);
	});
});
