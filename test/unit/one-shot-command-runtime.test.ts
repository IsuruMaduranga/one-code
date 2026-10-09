import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
	type AgentSession, type ExtensionAPI, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUserMessageSender } from "../../extensions/lib/notifications.ts";
import { ONE_SHOT_COMMAND_FAILED_CHANNEL } from "../../extensions/lib/interrupt.ts";
import doctorExtension from "../../extensions/doctor/index.ts";
import { INIT_PROMPT } from "../../extensions/init/prompt.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

const sessions: AgentSession[] = [];
const dirs: string[] = [];
let exitCode: typeof process.exitCode;
beforeEach(() => { exitCode = process.exitCode; process.exitCode = undefined; });
afterEach(async () => {
	process.exitCode = exitCode;
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const session of sessions.splice(0)) {
		await session.abort();
		session.dispose();
	}
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Real pi preflight, queue, extension hooks and settlement; only the provider is replaced. */
async function setup(extra: ExtensionFactory = () => {}, mode: "print" | "json" = "print", extensionPaths: string[] = []) {
	const dir = mkdtempSync(join(tmpdir(), "one-shot-command-runtime-"));
	dirs.push(dir);
	const errors: string[] = [];
	// The sender reports a failed start to the exit extension (exit/index.ts), which sets the code at shutdown.
	const failures: unknown[] = [];
	let api!: ExtensionAPI;
	let send!: ReturnType<typeof createUserMessageSender>;
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
	const loader = new DefaultResourceLoader({
		cwd: dir, agentDir: dir, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		additionalExtensionPaths: extensionPaths,
		extensionFactories: [(pi) => {
			api = pi;
			pi.events.on(ONE_SHOT_COMMAND_FAILED_CHANNEL, (data) => failures.push(data));
			send = createUserMessageSender(pi);
			pi.registerCommand("test-command", { description: "test", handler: async (args, ctx) => {
				await send(ctx, args, { deliverAs: "followUp" });
			} });
		}, extra],
	});
	await loader.reload();
	const runtime = await ModelRuntime.create({ credentials: {
		read: async () => undefined, list: async () => [], modify: async () => undefined, delete: async () => {},
	}, modelsPath: null, refreshOnCreate: false });
	vi.spyOn(runtime, "hasConfiguredAuth").mockReturnValue(true);
	const model = {
		id: "test-model", name: "Test", provider: "test-provider", api: "openai-completions", baseUrl: "http://localhost.invalid",
		reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000,
	} as const;
	const { session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager,
		modelRuntime: runtime, model: model as never, tools: [], sessionManager: SessionManager.inMemory(dir) });
	sessions.push(session);
	const requests: string[] = [];
	const gates: ReturnType<typeof deferred>[] = [];
	session.agent.streamFunction = async (_model, context) => {
		const text = context.messages.filter((m) => m.role === "user").map((m) => typeof m.content === "string" ? m.content : m.content.filter((p) => p.type === "text").map((p) => p.text).join("\n")).at(-1)!;
		requests.push(text);
		const gate = gates.shift();
		await gate?.promise;
		const message = { role: "assistant", content: [{ type: "text", text: `reply:${text}` }], api: model.api, provider: model.provider, model: model.id,
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
		return { async *[Symbol.asyncIterator]() { yield { type: "done", reason: "stop", message }; }, result: async () => message } as never;
	};
	await session.bindExtensions({ mode, commandContextActions: { waitForIdle: () => session.waitForIdle() } as never,
		onError: (error) => errors.push(`${error.event}: ${error.error}`) });
	return { session, api, send, runtime, errors, failures, requests, gates, ctx: session.extensionRunner!.createCommandContext() };
}

describe("one-shot commands against pi's runtime", () => {
	it.each(["print", "json"] as const)("prints the doctor fallback without a model in %s", async (mode) => {
		const h = await setup(doctorExtension, mode);
		h.session.agent.state.model = undefined as never;
		const output = vi.spyOn(console, "error").mockImplementation(() => {});
		await h.session.prompt("/doctor");
		expect(h.requests).toEqual([]);
		expect(h.errors).toEqual([]);
		expect(output.mock.calls.flat().join("\n")).toContain("No model is available");
		expect(output.mock.calls.flat().join("\n")).toContain("One Code doctor");
	});

	it.each(["print", "json"] as const)("waits for a command submitted during another run in %s", async (mode) => {
		const h = await setup(undefined, mode);
		const first = deferred();
		h.gates.push(first);
		const turn = h.session.prompt("existing turn");
		await vi.waitFor(() => expect(h.requests).toEqual(["existing turn"]));
		let returned = false;
		const command = h.session.prompt("/test-command command turn").then(() => { returned = true; });
		first.resolve();
		await turn;
		await vi.waitFor(() => expect(h.requests).toContain("command turn"));
		await vi.waitFor(() => expect(returned).toBe(true), { timeout: 500 });
		await command;
		expect(h.errors).toEqual([]);
	});

	it("does not mistake an unrelated turn for a command still in input preflight", async () => {
		const input = deferred();
		const entered = deferred();
		const h = await setup((pi) => {
			pi.on("input", async (event) => {
				if (event.text === "delayed command") { entered.resolve(); await input.promise; }
			});
		});
		let returned = false;
		const command = h.send(h.ctx, "delayed command").then(() => { returned = true; });
		await entered.promise;
		try {
			await h.session.prompt("unrelated turn");
			expect(h.requests).toEqual(["unrelated turn"]);
			expect(returned).toBe(false);
		} finally {
			input.resolve();
			await command;
			await h.session.waitForIdle();
		}
		expect(h.requests).toEqual(["unrelated turn", "delayed command"]);
	});

	it.each(["print", "json"] as const)("runs two init commands through pi's extension loader in %s", async (mode) => {
		const path = fileURLToPath(new URL("../../extensions/init/index.ts", import.meta.url));
		const h = await setup(undefined, mode, [path]);
		await h.session.prompt("/init");
		await h.session.prompt("/init");
		expect(h.requests).toEqual([INIT_PROMPT, INIT_PROMPT]);
		expect(h.errors).toEqual([]);
	});

	it.each(["print", "json"] as const)("runs two sequential commands with transformed input in %s", async (mode) => {
		const h = await setup((pi) => {
			pi.on("input", (event) => ({ action: "transform", text: event.text.toUpperCase() }));
		}, mode);
		await h.session.prompt("/test-command first argument");
		await h.session.prompt("/test-command second argument");
		expect(h.requests).toEqual(["FIRST ARGUMENT", "SECOND ARGUMENT"]);
		expect(h.errors).toEqual([]);
	});

	it.each(["consumed", "401"])("does not exit successfully when preflight is %s", async (failure) => {
		const h = await setup((pi) => {
			if (failure === "consumed") pi.on("input", () => ({ action: "handled" }));
		});
		if (failure === "401") {
			vi.mocked(h.runtime.hasConfiguredAuth).mockReturnValue(false);
			vi.spyOn(h.runtime, "checkAuth").mockRejectedValue(new Error("401: invalid credentials"));
		}
		vi.useFakeTimers();
		const command = h.session.prompt("/test-command never runs");
		await vi.advanceTimersByTimeAsync(30_000);
		await command; // pi catches command exceptions, so a rejection alone is not an exit status.
		expect(h.requests).toEqual([]);
		expect(h.errors).toContainEqual(expect.stringContaining("did not start within 30 seconds"));
		if (failure === "401") expect(h.errors).toContainEqual(expect.stringContaining("401: invalid credentials"));
		expect(h.failures).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	// Known upstream limitation (REPORT.md): the void API has no cancellation
	// handle for preflight. Unskip to reproduce; do not disguise it as a success.
	it.skip("does not run a command whose input hook resumes after its startup timeout", async () => {
		const input = deferred();
		const h = await setup((pi) => {
			pi.on("input", async () => { await input.promise; });
		});
		vi.useFakeTimers();
		const command = expect(h.send(h.ctx, "expired command")).rejects.toThrow("did not start within 30 seconds");
		await vi.advanceTimersByTimeAsync(30_000);
		await command;
		input.resolve();
		await vi.advanceTimersByTimeAsync(0);
		await h.session.waitForIdle();
		expect(h.requests).toEqual([]);
	});

	// A raw send outside the coordinated command senders can still overtake
	// preflight. Never silently run an unacknowledged queued command in that case.
	it("fails without queueing if an uncoordinated turn starts during preflight", async () => {
		const input = deferred();
		const h = await setup((pi) => {
			pi.on("input", async (event) => {
				if (event.text === "delayed command") await input.promise;
			});
		});
		vi.useFakeTimers();
		let outcome: string | undefined;
		const command = h.send(h.ctx, "delayed command", { deliverAs: "followUp" }).then(
			() => { outcome = "completed"; }, (error: Error) => { outcome = error.message; },
		);
		await vi.advanceTimersByTimeAsync(0);
		const provider = deferred();
		h.gates.push(provider);
		const unrelated = h.session.prompt("unrelated turn");
		await vi.advanceTimersByTimeAsync(0);
		input.resolve();
		await vi.advanceTimersByTimeAsync(0);
		provider.resolve();
		await unrelated;
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(30_000);
		await command;
		expect(h.requests).toEqual(["unrelated turn"]);
		expect(outcome).toContain("did not start within 30 seconds");
		expect(h.errors).toContainEqual(expect.stringContaining("Agent is already processing"));
		expect(h.failures).toHaveLength(1);
	});

	it("serializes one-shot commands from different extensions through preflight", async () => {
		const input = deferred();
		const entered = deferred();
		let other!: ReturnType<typeof createUserMessageSender>;
		const h = await setup((pi) => {
			other = createUserMessageSender(pi);
			pi.on("input", async (event) => {
				if (event.text === "first command") { entered.resolve(); await input.promise; }
			});
		});
		const first = h.send(h.ctx, "first command");
		await entered.promise;
		const second = other(h.ctx, "second command");
		try {
			await new Promise((resolve) => setImmediate(resolve));
			expect(h.requests).toEqual([]);
		} finally {
			input.resolve();
			await Promise.all([first, second]);
		}
		expect(h.requests).toEqual(["first command", "second command"]);
		expect(h.errors).toEqual([]);
	});

	it("rejects shutdown after startup instead of awaiting idle forever", async () => {
		const h = await setup();
		const running = deferred();
		h.gates.push(running);
		const result = h.send(h.ctx, "command").then(() => "resolved", (error: Error) => error.message);
		await vi.waitFor(() => expect(h.requests).toEqual(["command"]));
		try {
			await h.session.extensionRunner!.emit({ type: "session_shutdown", reason: "quit" });
			let outcome: string | undefined;
			void result.then((value) => { outcome = value; });
			await vi.waitFor(() => expect(outcome).toMatch(/Session shut down/), { timeout: 500 });
		} finally {
			running.resolve();
			await result;
		}
	});
});
