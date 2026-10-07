import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTICE_CHANNEL, queueNotice } from "../../extensions/lib/notices.ts";
import newerModelExtension from "../../extensions/newer-model/index.ts";
import permissionsExtension from "../../extensions/permissions/index.ts";
import { pinCatalog } from "./catalog-fixture.ts";
import { createFakeCtx, createFakePi, flushNotices } from "./helpers/fake-pi.ts";
import { stubHome } from "./helpers/home.ts";

const uiCtx = (hasUI = true) => {
	const notify = vi.fn();
	return { ctx: { hasUI, ui: { notify } } as never, notify };
};

describe("lifecycle notice owner", () => {
	it("shows warnings and errors first, each on its own, then one info notice joining the info texts in order", async () => {
		const events = createEventBus();
		const { ctx, notify } = uiCtx();
		queueNotice(events, ctx, "info", "first info");
		queueNotice(events, ctx, "warning", "a warning");
		queueNotice(events, ctx, "info", "second info");
		queueNotice(events, ctx, "error", "an error");
		expect(notify).not.toHaveBeenCalled();
		await flushNotices();
		expect(notify.mock.calls).toEqual([
			["a warning", "warning"],
			["an error", "error"],
			["first info\nsecond info", "info"],
		]);
	});

	it("collects across awaited handlers, flushes once, then starts a fresh batch", async () => {
		const events = createEventBus();
		const { ctx, notify } = uiCtx();
		// pi awaits each extension's handler in turn, so microtask boundaries sit between them.
		const handlers = [
			() => queueNotice(events, ctx, "info", "one"),
			async () => {
				await Promise.resolve();
				queueNotice(events, ctx, "info", "two");
			},
		];
		for (const handler of handlers) await handler();
		await flushNotices();
		expect(notify.mock.calls).toEqual([["one\ntwo", "info"]]);
		await flushNotices();
		expect(notify).toHaveBeenCalledTimes(1);
		queueNotice(events, ctx, "info", "three");
		await flushNotices();
		expect(notify.mock.calls.at(-1)).toEqual(["three", "info"]);
	});

	it("elects one owner per bus however many callers there are", async () => {
		const events = createEventBus();
		const on = vi.spyOn(events, "on");
		const { ctx, notify } = uiCtx();
		queueNotice(events, ctx, "info", "a");
		queueNotice(events, ctx, "info", "b");
		expect(on.mock.calls.filter(([channel]) => channel === NOTICE_CHANNEL)).toHaveLength(1);
		await flushNotices();
		expect(notify).toHaveBeenCalledTimes(1);
	});

	it("notifies at once without a UI, as the direct call did", () => {
		const events = createEventBus();
		const emit = vi.spyOn(events, "emit");
		const { ctx, notify } = uiCtx(false);
		queueNotice(events, ctx, "info", "headless");
		expect(notify).toHaveBeenCalledWith("headless", "info");
		expect(emit).not.toHaveBeenCalled();
	});

	it("drops a notice whose session went stale before the batch closed", async () => {
		const events = createEventBus();
		const notify = vi.fn(() => {
			throw new Error("stale ctx");
		});
		queueNotice(events, { hasUI: true, ui: { notify } } as never, "info", "late");
		await expect(flushNotices()).resolves.toBeUndefined();
		expect(notify).toHaveBeenCalledTimes(1);
	});
});

describe("lifecycle notices across extensions", () => {
	let home: string;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "onecode-notices-"));
		mkdirSync(join(home, "project"));
		mkdirSync(join(home, ".onecode"));
		stubHome(home);
		vi.stubEnv("ONECODE_STATE_DIR", join(home, ".onecode"));
		vi.stubEnv("PI_CODING_AGENT_DIR", join(home, "agent"));
		pinCatalog([
			{ id: "openai/gpt-6-sol", released: "2026-09-22", price: [1, 13] },
			{ id: "openai/gpt-5.6-sol", released: "2026-07-09", price: [2.5, 30] },
		]);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(home, { recursive: true, force: true });
	});

	it("joins permissions' classifier announcement and newer-model's suggestion into one info notice", async () => {
		const model = (id: string, price: number) => ({ provider: "openai-codex", id, name: id, contextWindow: 272_000, maxTokens: 8192, cost: { input: price, output: price * 4 } });
		const old = model("gpt-5.6-sol", 2.5);
		const newer = model("gpt-6-sol", 1);
		const fake = createFakePi();
		permissionsExtension(fake.pi as never);
		newerModelExtension(fake.pi as never);
		const ctx = createFakeCtx({
			cwd: join(home, "project"),
			mode: "tui",
			hasUI: true,
			model: old,
			modelRegistry: { getAvailable: () => [old, newer] },
			sessionManager: { getSessionId: () => "s", getSessionDir: () => join(home, "sessions"), getBranch: () => [] },
		});
		await fake.fire("session_start", { reason: "startup" }, ctx);
		await flushNotices();
		const notify = (ctx.ui as { notify: ReturnType<typeof vi.fn> }).notify;
		const infos = notify.mock.calls.filter(([, level]) => level === "info").map(([text]) => String(text));
		expect(infos).toHaveLength(1);
		expect(infos[0]).toMatch(/Auto mode (?:is screening|will screen) calls with/);
		expect(infos[0]).toContain("gpt-6-sol is newer than gpt-5.6-sol");
	});
});
