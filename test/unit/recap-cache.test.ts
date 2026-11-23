import { envName } from "../../extensions/lib/profile/brand.mjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { completeSimple as CompleteSimple } from "@earendil-works/pi-ai/compat";
import { registryStream } from "./helpers/side-call-registry.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

/** Stands in for the provider behind the model registry's stream (helpers/side-call-registry.ts). */
const completeSimple = vi.fn<typeof CompleteSimple>();

vi.mock("../../extensions/lib/side-calls/side-call-usage.ts", () => ({ logSideCallUsage: vi.fn(), SIDE_CALL_KINDS: ["reader", "btw", "recap"] }));

const complete = vi.mocked(completeSimple);
const { logSideCallUsage } = await import("../../extensions/lib/side-calls/side-call-usage.ts");
const logSideCall = vi.mocked(logSideCallUsage);
const answer = (text: string) => ({ content: [{ type: "text", text }], stopReason: "stop", usage: {} }) as Awaited<ReturnType<typeof completeSimple>>;
let recapExtension: typeof import("../../extensions/agents/recap/index.ts").default;

beforeEach(async () => {
	vi.useFakeTimers();
	process.env[envName("RECAP_IDLE_MS")] = "1000";
	complete.mockReset();
	logSideCall.mockReset();
	recapExtension = (await import("../../extensions/agents/recap/index.ts")).default;
});

afterEach(() => {
	delete process.env[envName("RECAP_IDLE_MS")];
	vi.useRealTimers();
});

/** A branch with Claude Code's minimum of three user turns, the last one `last`. */
function threeTurns(last: { role: string; content: string; timestamp: number }) {
	const earlier = [1, 2].map((n) => ({ role: "user", content: `Turn ${n}.`, timestamp: n }));
	return [...earlier, last].map((message, index) => ({ type: "message", id: `m${index + 1}`, parentId: index === 0 ? null : `m${index}`, message }));
}

async function scheduleRecap(model = { api: "anthropic-messages", provider: "anthropic", id: "test" }) {
	const fake = createFakePi();
	recapExtension(fake.pi as never);
	const earlier = { role: "user", content: "Earlier conversation.", timestamp: 1 };
	const ctx = createFakeCtx({
		hasUI: true,
		model,
		modelRegistry: {
			getAvailable: () => [model],
			streamSimple: registryStream(completeSimple),
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }),
		},
		sessionManager: { getBranch: () => threeTurns(earlier) },
	});
	await fake.fire("session_start", {}, ctx);
	await fake.fire("context", { messages: [earlier] }, ctx);
	await fake.fire("agent_settled", {}, ctx);
	await vi.advanceTimersByTimeAsync(1000);
	await vi.waitFor(() => expect(complete).toHaveBeenCalled());
	return { fake, ctx };
}

describe("standalone recap cache wiring", () => {
	it("uses the recap-specific session key and moves Anthropic's marker off the recap prompt", async () => {
		const payloads: Record<string, unknown>[] = [];
		complete.mockImplementation(async (_model, _context, options) => {
			const payload = {
				messages: [
					{ role: "user", content: [{ type: "text", text: "Earlier conversation." }] },
					{ role: "user", content: [{ type: "text", text: "Recap prompt", cache_control: { type: "ephemeral" } }] },
				],
			};
			options?.onPayload?.(payload, {} as never);
			payloads.push(payload);
			return answer("A recap.");
		});

		await scheduleRecap();

		const options = complete.mock.calls[0]?.[2]!;
		expect(options.sessionId).toBe("fake-session:recap");
		expect(options.onPayload).toBeTypeOf("function");
		expect(payloads[0]?.messages).toEqual([
			{ role: "user", content: [{ type: "text", text: "Earlier conversation.", cache_control: { type: "ephemeral" } }] },
			{ role: "user", content: [{ type: "text", text: "Recap prompt" }] },
		]);
		expect(logSideCall).toHaveBeenCalledWith(expect.objectContaining({
			kind: "recap",
			sessionId: "fake-session:recap",
			system: "",
		}), expect.objectContaining({ stopReason: "stop" }));
	});

	it("leaves other APIs without the Anthropic payload hook", async () => {
		complete.mockResolvedValue(answer("A recap."));
		await scheduleRecap({ api: "openai-responses", provider: "openai", id: "gpt-test" });
		const options = complete.mock.calls[0]?.[2]!;
		expect(options.sessionId).toBe("fake-session:recap");
		expect(options.onPayload).toBeUndefined();
	});

	it("logs every reasoning retry with its stable recap cache key", async () => {
		complete
			.mockResolvedValueOnce({ content: [], stopReason: "error", errorMessage: "Reasoning is mandatory and cannot be disabled.", usage: { attempt: 1 } } as unknown as Awaited<ReturnType<typeof completeSimple>>)
			.mockResolvedValueOnce(answer("A recap."));
		await scheduleRecap();
		expect(complete).toHaveBeenCalledTimes(2);
		for (const [, , options] of complete.mock.calls) expect(options?.sessionId).toBe("fake-session:recap");
		expect(logSideCall).toHaveBeenCalledTimes(2);
		expect(logSideCall).toHaveBeenNthCalledWith(1, expect.objectContaining({ kind: "recap", sessionId: "fake-session:recap" }), expect.objectContaining({ stopReason: "error" }));
	});
});

describe("the standalone recap follows the current branch", () => {
	it("summarizes the branch /tree selected, not the messages the last request carried", async () => {
		complete.mockResolvedValue(answer("A recap."));
		const model = { api: "anthropic-messages", provider: "anthropic", id: "test" };
		const fake = createFakePi();
		recapExtension(fake.pi as never);
		const apple = { role: "user", content: "Remember APPLE", timestamp: 1 };
		const banana = { role: "user", content: "Now remember BANANA", timestamp: 2 };
		let branchMessages: unknown[] = [apple, banana];
		const ctx = createFakeCtx({
			hasUI: true,
			model,
			modelRegistry: { getAvailable: () => [model], streamSimple: registryStream(completeSimple), getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }) },
			sessionManager: { getSessionId: () => "s", getBranch: () => threeTurns(banana), buildSessionProjection: () => ({ messages: branchMessages }) },
		});
		await fake.fire("session_start", {}, ctx);
		await fake.fire("context", { messages: [apple, banana] }, ctx);
		await fake.fire("agent_settled", {}, ctx);
		// /tree back to before the BANANA prompt while the idle timer runs: pi fires no context event.
		branchMessages = [apple];
		await vi.advanceTimersByTimeAsync(1000);
		await vi.waitFor(() => expect(complete).toHaveBeenCalled());
		const sent = JSON.stringify(complete.mock.calls[0]?.[1].messages);
		expect(sent).toContain("Remember APPLE");
		expect(sent).not.toContain("BANANA");
	});
});

describe("recap while background work runs", () => {
	it("skips while an agent or workflow runs, as Claude Code does, and fires once it is done", async () => {
		const { SESSION_WORK_CHANNEL } = await import("../../extensions/lib/notify/session-work.ts");
		complete.mockResolvedValue(answer("You were building the parser."));
		const fake = createFakePi();
		recapExtension(fake.pi as never);
		const tasks: Array<{ id: string; type: string; status: string; description: string }> = [{ id: "a1", type: "subagent", status: "running", description: "Look up" }];
		fake.events.on(SESSION_WORK_CHANNEL, (data) => (data as { tasks: unknown[] }).tasks.push(...tasks));
		const model = { api: "anthropic-messages", provider: "anthropic", id: "test" };
		const earlier = { role: "user", content: "Earlier conversation.", timestamp: 1 };
		const ctx = createFakeCtx({
			hasUI: true,
			model,
			modelRegistry: { getAvailable: () => [model], streamSimple: registryStream(completeSimple), getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }) },
			sessionManager: { getBranch: () => threeTurns(earlier) },
		});
		await fake.fire("session_start", {}, ctx);
		await fake.fire("context", { messages: [earlier] }, ctx);
		await fake.fire("agent_settled", {}, ctx);
		await vi.advanceTimersByTimeAsync(1000);
		expect(complete).not.toHaveBeenCalled();

		// A shell alone does not hold it back; the agent's turn ending re-arms it.
		tasks.splice(0, tasks.length, { id: "s1", type: "shell", status: "running", description: "npm run dev" });
		await fake.fire("agent_start", {}, ctx);
		await fake.fire("agent_settled", {}, ctx);
		await vi.advanceTimersByTimeAsync(1000);
		await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
	});
});

describe("recap skips and output (Claude Code 2.1.330)", () => {
	async function mountOnBranch(onFire = (_ctx: Record<string, unknown>) => {}) {
		const { SESSION_WORK_CHANNEL } = await import("../../extensions/lib/notify/session-work.ts");
		const fake = createFakePi();
		recapExtension(fake.pi as never);
		const work = { wakeup: false };
		fake.events.on(SESSION_WORK_CHANNEL, (data) => ((data as { wakeupPending: boolean }).wakeupPending ||= work.wakeup));
		const model = { api: "anthropic-messages", provider: "anthropic", id: "test" };
		let draft = "";
		let keystroke: (() => void) | undefined;
		const ctx = createFakeCtx({
			hasUI: true,
			model,
			modelRegistry: { getAvailable: () => [model], streamSimple: registryStream(completeSimple), getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }) },
			sessionManager: { getBranch: () => fake.branch },
			ui: { getEditorText: () => draft, onTerminalInput: (handler: () => void) => ((keystroke = handler), () => {}) },
		});
		const prompt = (text: string) => fake.branch.push({ type: "message", id: `u${fake.branch.length}`, parentId: null, message: { role: "user", content: text, timestamp: 1 } });
		await fake.fire("session_start", {}, ctx);
		/** One idle period after a turn end: true when the recap ran. */
		const idle = async (after: "turn" | "keystroke" = "turn") => {
			const before = complete.mock.calls.length;
			if (after === "turn") {
				await fake.fire("agent_start", {}, ctx);
				await fake.fire("agent_settled", {}, ctx);
			} else keystroke!();
			onFire(ctx);
			// A keystroke holds the fire back 30 seconds (the scheduler's QUIET_MS).
			await vi.advanceTimersByTimeAsync(after === "turn" ? 1000 : 30_000);
			return complete.mock.calls.length > before;
		};
		return { fake, ctx, work, prompt, idle, setDraft: (text: string) => (draft = text) };
	}

	it("holds off for a draft, a pending wakeup, the rate limit and too few turns, then ends the first recaps with how to turn them off", async () => {
		complete.mockResolvedValue(answer("You were building the parser."));
		const { fake, ctx, work, prompt, idle, setDraft } = await mountOnBranch();
		prompt("one");
		prompt("two");
		expect(await idle()).toBe(false); // two user turns
		prompt("three");
		setDraft("half a thought");
		expect(await idle()).toBe(false);
		setDraft("");
		work.wakeup = true;
		expect(await idle()).toBe(false);
		work.wakeup = false;
		await fake.fire("after_provider_response", { status: 200, headers: { "Anthropic-Ratelimit-Unified-Status": "rejected" } }, ctx);
		expect(await idle()).toBe(false);
		await fake.fire("after_provider_response", { status: 200, headers: { "anthropic-ratelimit-unified-status": "allowed" } }, ctx);
		expect(await idle()).toBe(true);
		expect(fake.appendedEntries.at(-1)?.data).toEqual({ content: `You were building the parser. (turn off recaps with ${envName("FEATURES_OFF")}=recap)` });

		// The recap is now the last entry: no second one until two more user turns.
		expect(await idle()).toBe(false);
		prompt("four");
		expect(await idle()).toBe(false);
		prompt("five");
		expect(await idle()).toBe(true);
	});

	it("tries again on the next idle period after a failure, up to three failures a turn", async () => {
		complete.mockRejectedValue(new Error("overloaded"));
		const { prompt, idle } = await mountOnBranch();
		for (const text of ["one", "two", "three"]) prompt(text);
		expect(await idle()).toBe(true);
		expect(await idle("keystroke")).toBe(true);
		expect(await idle("keystroke")).toBe(true);
		expect(await idle("keystroke")).toBe(false);
		// A turn end gives a fresh budget.
		expect(await idle()).toBe(true);
	});

	it("skips once the cache is stale: past 0.9 of the five-minute lifetime since the turn ended", async () => {
		complete.mockResolvedValue(answer("A recap."));
		const { prompt, idle } = await mountOnBranch();
		for (const text of ["one", "two", "three"]) prompt(text);
		await idle("turn").then(() => complete.mockClear());
		prompt("four");
		prompt("five");
		// The keystroke re-arms the timer, but it fires 300 seconds after the turn ended, when the five-minute cache is stale.
		await vi.advanceTimersByTimeAsync(270_000);
		expect(await idle("keystroke")).toBe(false);
	});
});
