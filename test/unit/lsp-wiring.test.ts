/**
 * lsp/index.ts wiring (T15c): the mid-session crash/respawn path in
 * `clientFor` (up to MAX_RESPAWNS, then give up and report once), and
 * `forceDeltaScan` — why an edit's diagnostics resurface even when the
 * server's publish tally didn't move.
 *
 * The real `LspClient` spawns a real language-server child process, so it is
 * replaced here with a controllable fake at the `./client.ts` module
 * boundary; `pathToUri` and the rest of that module's pure exports are kept
 * real via `importOriginal`.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LspDiagnostic } from "../../extensions/lsp/format.ts";
import { pathToUri } from "../../extensions/lsp/client.ts";
import lspExtension from "../../extensions/lsp/index.ts";
import { REMINDER_CHANNEL } from "../../extensions/lib/reminders.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";

const state = vi.hoisted(() => ({
	instances: [] as FakeLspClientInstance[],
	// A path that does not exist: `discoverPlugins`'s reads are all
	// try/catch-guarded against a missing directory, so nothing needs to be
	// created on disk — this just has to be *some* string, not the real home.
	fakeHome: `/nonexistent/one-code-test-lsp-wiring-fake-home-${Math.random().toString(36).slice(2)}`,
}));

// Plugin LSP routing (`pluginRouting`) discovers plugins under the real
// homedir by default (`defaultDiscoverRoots`'s `home` param is not threaded
// through from index.ts); redirect it to a nonexistent dir so this test's
// behavior does not depend on whatever plugins happen to be installed on the
// machine running it.
vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	const actualDefault = (actual as unknown as { default?: Record<string, unknown> }).default;
	return { ...actual, homedir: () => state.fakeHome, default: { ...actualDefault, homedir: () => state.fakeHome } };
});

interface FakeLspClientInstance {
	config: unknown;
	root: string;
	isRunningValue: boolean;
	publishCountValue: number;
	diagnosticsMap: Map<string, LspDiagnostic[]>;
	stopped: boolean;
	error: string | undefined;
}

vi.mock("../../extensions/lsp/client.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../extensions/lsp/client.ts")>();
	class FakeLspClient implements FakeLspClientInstance {
		isRunningValue = true;
		publishCountValue = 0;
		diagnosticsMap = new Map<string, LspDiagnostic[]>();
		stopped = false;
		error: string | undefined;
		constructor(
			public config: unknown,
			public root: string,
		) {
			state.instances.push(this);
		}
		get isRunning() {
			return this.isRunningValue;
		}
		async start() {
			// no-op: "started" successfully unless the test crashes it after the fact
		}
		async getDiagnostics() {
			return [];
		}
		allDiagnostics() {
			return this.diagnosticsMap;
		}
		get publishCount() {
			return this.publishCountValue;
		}
		async stop() {
			this.stopped = true;
		}
	}
	return { ...actual, LspClient: FakeLspClient };
});

describe("lsp wiring", () => {
	let dir: string;
	let fake: FakePi;
	/** `<new-diagnostics>` blocks queued on the reminder channel, in order. */
	const delivered: Array<{ text?: string; placement?: string; raw?: boolean }> = [];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "lsp-wiring-"));
		state.instances.length = 0;
		delivered.length = 0;
		fake = createFakePi();
		fake.events.on(REMINDER_CHANNEL, (data) => delivered.push(data as never));
		lspExtension(fake.pi as never);
	});
	afterEach(() => {
		vi.useRealTimers();
		rmSync(dir, { recursive: true, force: true });
	});

	const editEvent = (path: string) => ({ toolName: "edit" as const, input: { path }, isError: false, content: [], toolCallId: "c" });

	it("respawns a crashed server up to MAX_RESPAWNS, then gives up and reports once", async () => {
		vi.useFakeTimers();
		const notify = vi.fn();
		const ctx = createFakeCtx({ cwd: dir, hasUI: true, ui: { notify } });
		const file = join(dir, "a.py");
		writeFileSync(file, "x = 1\n");

		// First edit: spawns and runs fine.
		await fake.fireOne("tool_result", editEvent(file), ctx);
		expect(state.instances).toHaveLength(1);
		expect(state.instances[0].isRunningValue).toBe(true);

		// Crash #1 -> respawn (500ms backoff).
		state.instances[0].isRunningValue = false;
		let pending = fake.fireOne("tool_result", editEvent(file), ctx);
		await vi.advanceTimersByTimeAsync(600);
		await pending;
		expect(state.instances).toHaveLength(2);

		// Crash #2 -> respawn (1000ms backoff).
		state.instances[1].isRunningValue = false;
		pending = fake.fireOne("tool_result", editEvent(file), ctx);
		await vi.advanceTimersByTimeAsync(1100);
		await pending;
		expect(state.instances).toHaveLength(3);

		// Crash #3 -> exceeds MAX_RESPAWNS (2): gives up immediately, no new client.
		state.instances[2].isRunningValue = false;
		await fake.fireOne("tool_result", editEvent(file), ctx);
		expect(state.instances).toHaveLength(3);
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0][0]).toContain("gave up after 2 restarts");

		// A further edit must not spam the warning a second time (warned-once).
		await fake.fireOne("tool_result", editEvent(file), ctx);
		expect(notify).toHaveBeenCalledTimes(1);
	});

	it("forceDeltaScan resurfaces an edited file's diagnostics even when the publish tally is unchanged", async () => {
		const ctx = createFakeCtx({ cwd: dir, hasUI: true });
		const file = join(dir, "b.py");
		writeFileSync(file, "x = 1\n");

		await fake.fireOne("tool_result", editEvent(file), ctx);
		expect(state.instances).toHaveLength(1);
		const client = state.instances[0];
		const uri = pathToUri(file);
		client.publishCountValue = 1;
		client.diagnosticsMap.set(uri, [
			{ range: { start: { line: 0, character: 0 } }, severity: 1, message: "unresolved name x" },
		]);

		// Every tool_result re-checks the delta; nothing changed since the last
		// check (still count 0 -> going to 1 for the FIRST time here), so this
		// is the initial publish reaching the model.
		await fake.fireOne("tool_result", { toolName: "read" as const, input: {}, isError: false, content: [], toolCallId: "c2" }, ctx);
		expect(delivered).toHaveLength(1);
		expect(delivered[0].text).toContain("unresolved name x");
		// Claude Code's shape: a bare <new-diagnostics> block inside the tool
		// result, no <system-reminder> frame, never a message of its own.
		expect(delivered[0].text?.startsWith("<new-diagnostics>")).toBe(true);
		expect(delivered[0]).toMatchObject({ placement: "last-append", raw: true });
		expect(fake.sentMessages).toHaveLength(0);

		// Same publish tally (1), unrelated tool call: no re-fingerprinting, no
		// duplicate delivery (the tool_result waste-avoidance short-circuit).
		delivered.length = 0;
		await fake.fireOne("tool_result", { toolName: "read" as const, input: {}, isError: false, content: [], toolCallId: "c3" }, ctx);
		expect(delivered).toHaveLength(0);

		// Re-editing the SAME file clears its delivered-set and forces a delta
		// scan, so the still-unfixed diagnostic resurfaces even though the
		// server's publish tally never moved from 1.
		await fake.fireOne("tool_result", editEvent(file), ctx);
		expect(delivered).toHaveLength(1);
		expect(delivered[0].text).toContain("unresolved name x");
	});

	it("delivers diagnostics that arrived while idle on the next run's start, whoever opened it", async () => {
		const ctx = createFakeCtx({ cwd: dir, hasUI: true });
		const file = join(dir, "c.py");
		writeFileSync(file, "y = 2\n");
		await fake.fireOne("tool_result", editEvent(file), ctx);
		const client = state.instances[0];

		// The server publishes after the turn settled: nothing is sent now…
		client.publishCountValue = 1;
		client.diagnosticsMap.set(pathToUri(file), [
			{ range: { start: { line: 0, character: 0 } }, severity: 1, message: "unresolved name y" },
		]);
		expect(delivered).toHaveLength(0);

		// …and the next run — a harness notification's as much as a prompt's,
		// since agent_start fires for both — carries it as a one-shot.
		await fake.fireOne("agent_start", {}, ctx);
		expect(delivered).toHaveLength(1);
		expect(delivered[0].text).toContain("unresolved name y");
		expect(fake.sentMessages).toHaveLength(0);

		// Delivered once: the following run has nothing new.
		delivered.length = 0;
		await fake.fireOne("agent_start", {}, ctx);
		expect(delivered).toHaveLength(0);
	});
});
