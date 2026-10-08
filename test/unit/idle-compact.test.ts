/**
 * Idle compaction (extensions/idle-compact): Claude Code 2.1.289's rules for
 * compacting an idle session before its one-hour cache expires: the cache TTL
 * read from the request body, the fire at 90% of the hour, the refusal order,
 * and the wiring, which follows the compaction extension's capture of the last
 * request and compacts once with the notice.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import compactionExtension from "../../extensions/compaction/index.ts";
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
} from "../../extensions/idle-compact/policy.ts";
import { hasOneHourCache } from "../../extensions/lib/anthropic-payload.ts";
import { unrefTimers } from "../../extensions/lib/timer-ops.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const FIRE_MS = 54 * 60_000;
const ephemeral = (ttl?: string) => ({ type: "ephemeral", ...(ttl ? { ttl } : {}) });
/** An Anthropic body whose system block carries a breakpoint with `ttl`. */
const body = (ttl?: string) => ({ system: [{ type: "text", text: "s", cache_control: ephemeral(ttl) }], messages: [], max_tokens: 1000 });

describe("hasOneHourCache", () => {
	it("finds a one-hour breakpoint on the system, the tools or a message block", () => {
		expect(hasOneHourCache(body("1h"))).toBe(true);
		expect(hasOneHourCache({ tools: [{ name: "t", cache_control: ephemeral("1h") }], messages: [] })).toBe(true);
		expect(hasOneHourCache({ messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: ephemeral("1h") }] }] })).toBe(true);
	});

	it("is false for five-minute breakpoints and for a body without any", () => {
		expect(hasOneHourCache(body())).toBe(false);
		expect(hasOneHourCache({ input: [{ role: "user", content: "hi" }], prompt_cache_retention: "24h" })).toBe(false);
		expect(hasOneHourCache(undefined)).toBe(false);
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

	it("ignores a delay under a second or past the hour, and a nonsense threshold", () => {
		expect(idleCompactConfig({ CC_IDLE_COMPACT_DELAY_MS: "10" }).delayMs).toBeUndefined();
		expect(idleCompactConfig({ CC_IDLE_COMPACT_DELAY_MS: String(ONE_HOUR_MS) }).delayMs).toBeUndefined();
		expect(idleCompactConfig({ CC_IDLE_COMPACT_MIN_TOKENS: "lots" }).minTokens).toBe(DEFAULT_MIN_TOKENS);
	});
});

describe("idleRefusal", () => {
	const armed: ArmedRequest = { at: 0, model: "anthropic/claude-opus-5-5", thinking: "medium" };
	const probe = (over: Partial<FireProbe> = {}): FireProbe => ({
		now: FIRE_MS,
		dueAt: FIRE_MS,
		config: { enabled: true, minTokens: DEFAULT_MIN_TOKENS },
		compactionOn: true,
		model: armed.model,
		thinking: armed.thinking,
		warm: true,
		contextTokens: 250_000,
		rateLimitStatus: undefined,
		idle: true,
		lastInteractionAt: undefined,
		...over,
	});

	it("compacts a warm, idle, large session at the mark", () => {
		expect(idleRefusal(armed, probe())).toBeNull();
		expect(idleRefusal(armed, probe({ rateLimitStatus: "allowed", lastInteractionAt: FIRE_MS - 61_000 }))).toBeNull();
	});

	it.each<[string, Partial<FireProbe>]>([
		["disabled", { config: { enabled: false, minTokens: 1 } }],
		["compaction_off", { compactionOn: false }],
		["prefix_changed", { model: "anthropic/claude-sonnet-5-5" }],
		["prefix_changed", { thinking: "high" }],
		["lapsed", { now: FIRE_MS + 61_000 }],
		["lapsed", { warm: false }],
		["lapsed", { now: ONE_HOUR_MS, dueAt: ONE_HOUR_MS }],
		["small", { contextTokens: 199_999 }],
		["near_limit", { rateLimitStatus: "allowed_warning" }],
		["busy", { idle: false }],
		["present", { lastInteractionAt: FIRE_MS - 59_000 }],
	])("refuses with %s", (reason, over) => {
		expect(idleRefusal(armed, probe(over))).toBe(reason);
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
		const timer = new IdleCompactTimer(unrefTimers, Date.now, () => config, (armed, dueAt) => fired.push({ armed, dueAt }));
		return { timer, fired };
	};
	const request = (at: number): ArmedRequest => ({ at, model: "m", thinking: "off" });

	it("fires at 90% of the hour", () => {
		const { timer, fired } = make();
		timer.arm(request(0));
		vi.advanceTimersByTime(FIRE_MS - 1);
		expect(fired).toHaveLength(0);
		vi.advanceTimersByTime(1);
		expect(fired).toEqual([{ armed: request(0), dueAt: FIRE_MS }]);
		expect(timer.pending).toBe(false);
	});

	it("re-arms on each request, and a cancel clears it", () => {
		const { timer, fired } = make();
		timer.arm(request(0));
		vi.advanceTimersByTime(10 * 60_000);
		timer.arm(request(Date.now()));
		vi.advanceTimersByTime(FIRE_MS - 1);
		expect(fired).toHaveLength(0);
		timer.cancel();
		vi.advanceTimersByTime(2 * ONE_HOUR_MS);
		expect(fired).toHaveLength(0);
	});

	it("arms nothing when off, and uses the delay override", () => {
		const off = make(idleCompactConfig({ CC_IDLE_COMPACT: "0" }));
		off.timer.arm(request(0));
		expect(off.timer.pending).toBe(false);
		const quick = make(idleCompactConfig({ CC_IDLE_COMPACT_DELAY_MS: "5000" }));
		quick.timer.arm(request(0));
		vi.advanceTimersByTime(5000);
		expect(quick.fired.map((f) => f.dueAt)).toEqual([5000]);
	});
});

describe("idle-compact wiring, beside the compaction extension's capture", () => {
	let agentDir: string;
	beforeEach(() => {
		vi.useFakeTimers({ now: 1_000_000 });
		agentDir = mkdtempSync(join(tmpdir(), "idle-compact-agent-"));
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		for (const name of ["CC_IDLE_COMPACT", "CC_IDLE_COMPACT_MIN_TOKENS", "CC_IDLE_COMPACT_DELAY_MS", "CC_COMPACTION"]) vi.stubEnv(name, undefined);
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
		rmSync(agentDir, { recursive: true, force: true });
	});

	const model = { api: "anthropic-messages", provider: "anthropic", id: "claude-opus-5-5" };

	async function mount(over: Record<string, unknown> = {}) {
		const fake = createFakePi();
		compactionExtension(fake.pi as never);
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
		const turn = async (payload: unknown = body("1h"), usage = { cacheRead: 200_000, cacheWrite: 1_000 }) => {
			await fake.fire("before_provider_request", { payload }, ctx);
			await fake.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: "ok" }], usage } }, ctx);
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

	type Run = Awaited<ReturnType<typeof mount>>;
	it.each<[string, Record<string, unknown>, (run: Run) => Promise<void>]>([
		["a small session", { getContextUsage: () => ({ tokens: 120_000, contextWindow: 1_000_000, percent: 12 }) }, (run) => run.turn()],
		["a busy session", { isIdle: () => false }, (run) => run.turn()],
		[
			"a session near its rate limit",
			{},
			async (run) => {
				await run.turn();
				await run.fake.fire("after_provider_response", { status: 200, headers: { "Anthropic-Ratelimit-Unified-Status": "allowed_warning" } }, run.ctx);
			},
		],
		["a five-minute cache", {}, (run) => run.turn(body())],
		["a cold reply", {}, (run) => run.turn(body("1h"), { cacheRead: 0, cacheWrite: 0 })],
		["an RPC session", { mode: "rpc" }, (run) => run.turn()],
		[
			"a compacted session",
			{},
			async (run) => {
				await run.turn();
				await run.fake.fire("session_compact", {}, run.ctx);
			},
		],
		[
			"a branch switch",
			{},
			async (run) => {
				await run.turn();
				await run.fake.fire("session_tree", {}, run.ctx);
			},
		],
		[
			"a model switch",
			{},
			async (run) => {
				await run.turn();
				(run.ctx as { model: unknown }).model = { ...model, id: "claude-sonnet-5-5" };
			},
		],
	])("leaves %s alone", async (_name, over, act) => {
		const run = await mount(over);
		await act(run);
		vi.advanceTimersByTime(FIRE_MS);
		expect(run.compact).not.toHaveBeenCalled();
	});

	it("respects CC_IDLE_COMPACT=0, CC_COMPACTION=0 and pi's compaction.enabled", async () => {
		vi.stubEnv("CC_IDLE_COMPACT", "0");
		const off = await mount();
		await off.turn();
		vi.stubEnv("CC_IDLE_COMPACT", undefined);
		vi.stubEnv("CC_COMPACTION", "0");
		const ours = await mount();
		await ours.turn();
		vi.advanceTimersByTime(FIRE_MS);
		expect(off.compact).not.toHaveBeenCalled();
		expect(ours.compact).not.toHaveBeenCalled();

		vi.stubEnv("CC_COMPACTION", undefined);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false } }));
		const piOff = await mount();
		await piOff.turn();
		vi.advanceTimersByTime(FIRE_MS);
		expect(piOff.compact).not.toHaveBeenCalled();
	});
});
