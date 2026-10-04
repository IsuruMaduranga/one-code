/**
 * Idle compaction (extensions/idle-compact): Claude Code 2.1.289's rules for
 * compacting an idle session before its one-hour cache expires: the cache TTL
 * read from the request body, the fire at 90% of the hour, the refusal order,
 * and the wiring that arms on a TUI request and compacts once with the notice.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import idleCompactExtension from "../../extensions/idle-compact/index.ts";
import {
	type ArmedRequest,
	DEFAULT_MIN_TOKENS,
	type FireProbe,
	IDLE_COMPACT_NOTICE,
	IdleCompactTimer,
	idleCompactConfig,
	idleRefusal,
	ONE_HOUR_MS,
	requestCacheTtl,
} from "../../extensions/idle-compact/policy.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const FIRE_MS = 54 * 60_000;
const ephemeral = (ttl?: string) => ({ type: "ephemeral", ...(ttl ? { ttl } : {}) });

describe("requestCacheTtl", () => {
	it("reads a one-hour breakpoint on the system, the tools or a message block", () => {
		expect(requestCacheTtl({ system: [{ type: "text", text: "s", cache_control: ephemeral("1h") }], messages: [] })).toBe("1h");
		expect(requestCacheTtl({ tools: [{ name: "t", cache_control: ephemeral("1h") }], messages: [] })).toBe("1h");
		expect(
			requestCacheTtl({ messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: ephemeral("1h") }] }] }),
		).toBe("1h");
	});

	it("says 5m for breakpoints without a ttl, and nothing for a body without breakpoints", () => {
		expect(requestCacheTtl({ system: [{ type: "text", text: "s", cache_control: ephemeral() }], messages: [] })).toBe("5m");
		expect(requestCacheTtl({ input: [{ role: "user", content: "hi" }], prompt_cache_retention: "24h" })).toBeUndefined();
		expect(requestCacheTtl(undefined)).toBeUndefined();
	});
});

describe("idleCompactConfig", () => {
	it("is on with Claude Code's 200,000-token floor and no delay override by default", () => {
		expect(idleCompactConfig({})).toEqual({ enabled: true, minTokens: DEFAULT_MIN_TOKENS });
	});

	it("turns off with CC_IDLE_COMPACT=0 and takes the testing overrides", () => {
		expect(idleCompactConfig({ CC_IDLE_COMPACT: "0" }).enabled).toBe(false);
		expect(idleCompactConfig({ CC_IDLE_COMPACT_MIN_TOKENS: "500", CC_IDLE_COMPACT_DELAY_MS: "5000" })).toEqual({ enabled: true, minTokens: 500, delayMs: 5000 });
	});

	it("ignores a delay under a second or past the cache lifetime, and a nonsense threshold", () => {
		expect(idleCompactConfig({ CC_IDLE_COMPACT_DELAY_MS: "10" }).delayMs).toBeUndefined();
		expect(idleCompactConfig({ CC_IDLE_COMPACT_DELAY_MS: String(ONE_HOUR_MS) }).delayMs).toBeUndefined();
		expect(idleCompactConfig({ CC_IDLE_COMPACT_MIN_TOKENS: "lots" }).minTokens).toBe(DEFAULT_MIN_TOKENS);
	});
});

describe("idleRefusal", () => {
	const armed: ArmedRequest = { at: 0, ttlMs: ONE_HOUR_MS, model: "anthropic/claude-opus-5-5", thinking: "medium" };
	const probe = (over: Partial<FireProbe> = {}): FireProbe => ({
		now: FIRE_MS,
		dueAt: FIRE_MS,
		config: { enabled: true, minTokens: DEFAULT_MIN_TOKENS },
		compactionOn: true,
		model: armed.model,
		thinking: armed.thinking,
		warm: true,
		contextTokens: 250_000,
		lastRequestAt: 0,
		rateLimitStatus: undefined,
		idle: true,
		lastInteractionAt: undefined,
		...over,
	});

	it("compacts a warm, idle, large session at the mark", () => {
		expect(idleRefusal(armed, probe())).toBeNull();
		expect(idleRefusal(armed, probe({ rateLimitStatus: "allowed", lastInteractionAt: FIRE_MS - 61_000 }))).toBeNull();
	});

	it("refuses for each of Claude Code's reasons", () => {
		expect(idleRefusal(armed, probe({ config: { enabled: false, minTokens: 1 } }))).toBe("disabled");
		expect(idleRefusal(armed, probe({ compactionOn: false }))).toBe("compaction_off");
		expect(idleRefusal(armed, probe({ model: "anthropic/claude-sonnet-5-5" }))).toBe("prefix_changed");
		expect(idleRefusal(armed, probe({ thinking: "high" }))).toBe("prefix_changed");
		expect(idleRefusal({ ...armed, ttlMs: 5 * 60_000 }, probe())).toBe("not_one_hour");
		expect(idleRefusal(armed, probe({ now: FIRE_MS + 61_000 }))).toBe("lapsed");
		expect(idleRefusal(armed, probe({ warm: false }))).toBe("lapsed");
		expect(idleRefusal(armed, probe({ contextTokens: 199_999 }))).toBe("small");
		expect(idleRefusal(armed, probe({ lastRequestAt: 1 }))).toBe("newer_request");
		expect(idleRefusal(armed, probe({ rateLimitStatus: "allowed_warning" }))).toBe("near_limit");
		expect(idleRefusal(armed, probe({ idle: false }))).toBe("busy");
		expect(idleRefusal(armed, probe({ lastInteractionAt: FIRE_MS - 59_000 }))).toBe("present");
	});

	it("checks them in Claude Code's order", () => {
		expect(idleRefusal(armed, probe({ compactionOn: false, contextTokens: 0, idle: false }))).toBe("compaction_off");
		expect(idleRefusal(armed, probe({ contextTokens: 0, idle: false }))).toBe("small");
		expect(idleRefusal(armed, probe({ idle: false, lastInteractionAt: FIRE_MS }))).toBe("busy");
	});
});

describe("IdleCompactTimer", () => {
	beforeEach(() => vi.useFakeTimers({ now: 0 }));
	afterEach(() => vi.useRealTimers());

	const make = (config = idleCompactConfig({})) => {
		const fired: Array<{ armed: ArmedRequest; dueAt: number }> = [];
		const timer = new IdleCompactTimer(
			{ set: (cb, ms) => setTimeout(cb, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) },
			Date.now,
			() => config,
			(armed, dueAt) => fired.push({ armed, dueAt }),
		);
		return { timer, fired };
	};
	const request = (at: number, ttlMs = ONE_HOUR_MS): ArmedRequest => ({ at, ttlMs, model: "m", thinking: "off" });

	it("fires at 90% of the hour after a one-hour request", () => {
		const { timer, fired } = make();
		timer.noteRequest(request(0));
		vi.advanceTimersByTime(FIRE_MS - 1);
		expect(fired).toHaveLength(0);
		vi.advanceTimersByTime(1);
		expect(fired).toEqual([{ armed: request(0), dueAt: FIRE_MS }]);
		expect(timer.pending).toBeUndefined();
	});

	it("re-arms on each request, and a five-minute request or a cancel clears it", () => {
		const { timer, fired } = make();
		timer.noteRequest(request(0));
		vi.advanceTimersByTime(10 * 60_000);
		timer.noteRequest(request(Date.now()));
		vi.advanceTimersByTime(FIRE_MS - 1);
		expect(fired).toHaveLength(0);
		timer.noteRequest(request(Date.now(), 5 * 60_000));
		expect(timer.pending).toBeUndefined();
		timer.noteRequest(request(Date.now()));
		timer.cancel();
		vi.advanceTimersByTime(2 * ONE_HOUR_MS);
		expect(fired).toHaveLength(0);
	});

	it("arms nothing when off, and uses the delay override", () => {
		const off = make(idleCompactConfig({ CC_IDLE_COMPACT: "0" }));
		off.timer.noteRequest(request(0));
		expect(off.timer.pending).toBeUndefined();
		const quick = make(idleCompactConfig({ CC_IDLE_COMPACT_DELAY_MS: "5000" }));
		quick.timer.noteRequest(request(0));
		vi.advanceTimersByTime(5000);
		expect(quick.fired.map((f) => f.dueAt)).toEqual([5000]);
	});
});

describe("idle-compact wiring", () => {
	let agentDir: string;
	beforeEach(() => {
		vi.useFakeTimers({ now: 1_000_000 });
		agentDir = mkdtempSync(join(tmpdir(), "idle-compact-agent-"));
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		for (const name of ["CC_IDLE_COMPACT", "CC_IDLE_COMPACT_MIN_TOKENS", "CC_IDLE_COMPACT_DELAY_MS", "CC_COMPACTION"]) vi.stubEnv(name, undefined as unknown as string);
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
		rmSync(agentDir, { recursive: true, force: true });
	});

	const oneHourBody = { system: [{ type: "text", text: "s", cache_control: ephemeral("1h") }], messages: [] };
	const model = { provider: "anthropic", id: "claude-opus-5-5" };

	async function mount(over: Record<string, unknown> = {}) {
		const fake = createFakePi();
		idleCompactExtension(fake.pi as never);
		let onKey: (() => void) | undefined;
		const ctx = createFakeCtx({
			mode: "tui",
			hasUI: true,
			cwd: agentDir,
			model,
			getContextUsage: () => ({ tokens: 250_000, contextWindow: 1_000_000, percent: 25 }),
			ui: { onTerminalInput: vi.fn((handler: () => void) => ((onKey = handler), () => {})) },
			...over,
		});
		await fake.fire("session_start", { reason: "startup" }, ctx);
		/** One main-session request and its reply. */
		const turn = async (body: unknown = oneHourBody, usage = { cacheRead: 200_000, cacheWrite: 1_000 }) => {
			await fake.fire("before_provider_request", { payload: body }, ctx);
			await fake.fire("message_end", { message: { role: "assistant", usage } }, ctx);
		};
		return { fake, ctx, turn, compact: ctx.compact as ReturnType<typeof vi.fn>, key: () => onKey?.() };
	}

	it("compacts once at 54 minutes and adds Claude Code's notice", async () => {
		const { fake, turn, compact } = await mount();
		await turn();
		vi.advanceTimersByTime(FIRE_MS - 1);
		expect(compact).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(compact).toHaveBeenCalledTimes(1);
		expect(compact.mock.calls[0][0].customInstructions).toBeUndefined();
		compact.mock.calls[0][0].onComplete({});
		expect(fake.appendedEntries).toEqual([{ customType: "one-code:idle-compact", data: undefined }]);
		vi.advanceTimersByTime(2 * ONE_HOUR_MS);
		expect(compact).toHaveBeenCalledTimes(1);
	});

	it("renders the notice as a dim marked line", async () => {
		const { fake } = await mount();
		const renderer = fake.entryRenderers.get("one-code:idle-compact") as (entry: unknown, options: unknown, theme: unknown) => { render(width: number): string[] };
		expect(renderer({}, {}, {}).render(80).join("\n")).toContain(IDLE_COMPACT_NOTICE);
	});

	it("leaves a session alone when the user pressed a key in the last minute", async () => {
		const { turn, compact, key } = await mount();
		await turn();
		vi.advanceTimersByTime(FIRE_MS - 30_000);
		key();
		vi.advanceTimersByTime(30_000);
		expect(compact).not.toHaveBeenCalled();
	});

	it("leaves a small, a busy or a near-limit session alone", async () => {
		const small = await mount({ getContextUsage: () => ({ tokens: 120_000, contextWindow: 1_000_000, percent: 12 }) });
		await small.turn();
		const busy = await mount({ isIdle: () => false });
		await busy.turn();
		const limited = await mount();
		await limited.turn();
		await limited.fake.fire("after_provider_response", { status: 200, headers: { "Anthropic-Ratelimit-Unified-Status": "allowed_warning" } }, limited.ctx);
		vi.advanceTimersByTime(FIRE_MS);
		for (const run of [small, busy, limited]) expect(run.compact).not.toHaveBeenCalled();
	});

	it("does not arm on a five-minute cache, a cold reply, or outside the TUI", async () => {
		const short = await mount();
		await short.turn({ system: [{ type: "text", text: "s", cache_control: ephemeral() }], messages: [] });
		const cold = await mount();
		await cold.turn(oneHourBody, { cacheRead: 0, cacheWrite: 0 });
		const rpc = await mount({ mode: "rpc" });
		await rpc.turn();
		vi.advanceTimersByTime(FIRE_MS);
		for (const run of [short, cold, rpc]) expect(run.compact).not.toHaveBeenCalled();
	});

	it("drops the timer on a compaction, a branch switch or a model switch", async () => {
		const compacted = await mount();
		await compacted.turn();
		await compacted.fake.fire("session_compact", {}, compacted.ctx);
		const branched = await mount();
		await branched.turn();
		await branched.fake.fire("session_tree", {}, branched.ctx);
		const switched = await mount();
		await switched.turn();
		(switched.ctx as { model: unknown }).model = { provider: "anthropic", id: "claude-sonnet-5-5" };
		vi.advanceTimersByTime(FIRE_MS);
		for (const run of [compacted, branched, switched]) expect(run.compact).not.toHaveBeenCalled();
	});

	it("respects CC_IDLE_COMPACT=0, CC_COMPACTION=0 and pi's compaction.enabled", async () => {
		vi.stubEnv("CC_IDLE_COMPACT", "0");
		const off = await mount();
		await off.turn();
		vi.stubEnv("CC_IDLE_COMPACT", undefined as unknown as string);
		vi.stubEnv("CC_COMPACTION", "0");
		const ours = await mount();
		await ours.turn();
		vi.advanceTimersByTime(FIRE_MS);
		expect(off.compact).not.toHaveBeenCalled();
		expect(ours.compact).not.toHaveBeenCalled();

		vi.stubEnv("CC_COMPACTION", undefined as unknown as string);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false } }));
		const piOff = await mount();
		await piOff.turn();
		vi.advanceTimersByTime(FIRE_MS);
		expect(piOff.compact).not.toHaveBeenCalled();
	});
});
