import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pinReleaseDates } from "./catalog-fixture.ts";
import { MODEL_UNUSABLE_CHANNEL } from "../../extensions/lib/model-unusable.ts";
import { oneCodeSettingsPath, readSuggestNewerModels } from "../../extensions/lib/one-code-settings.ts";
import newerModelExtension from "../../extensions/newer-model/index.ts";
import { NOTICE_CHANNEL } from "../../extensions/lib/notices.ts";
import { createFakeCtx, createFakePi, flushNotices } from "./helpers/fake-pi.ts";

const model = (id: string) => ({ provider: "openai", id, name: id, api: "openai-responses", cost: { input: 1, output: 3 } }) as Model<Api>;
const old = model("gpt-5.6-luna");
const newer = model("gpt-6-luna");
const sol = model("gpt-5.6-sol");
const newerSol = model("gpt-6-sol");
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "onecode-newer-model-"));
	vi.stubEnv("ONECODE_STATE_DIR", dir);
	pinReleaseDates({
		"openai/gpt-5.6-luna": { releaseDate: "2026-07-09" },
		"openai/gpt-6-luna": { releaseDate: "2026-09-01" },
		"openai/gpt-5.6-sol": { releaseDate: "2026-07-09" },
		"openai/gpt-6-sol": { releaseDate: "2026-09-01" },
	});
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

function mount(mode = "tui", hasUI = true) {
	const fake = createFakePi();
	const emit = vi.spyOn(fake.events, "emit");
	const getAvailable = vi.fn(() => [old, newer, sol, newerSol]);
	const getAll = vi.fn(() => { throw new Error("Suggestions must use available models, not the full catalog"); });
	const ctx = createFakeCtx({ mode, hasUI, model: old, modelRegistry: { getAvailable, getAll } });
	newerModelExtension(fake.pi as never);
	// The notice reaches the UI when the lifecycle notice batch closes (lib/notices.ts).
	const start = async () => { await fake.fire("session_start", { reason: "startup" }, ctx); await flushNotices(); };
	const select = async (m: Model<Api>) => { await fake.fire("model_select", { model: m }, ctx); await flushNotices(); };
	return { fake, ctx, start, select, emit, getAvailable, getAll };
}

describe("newer-model notices", () => {
	it.each(["tui", "rpc"])("shows one user-only notice per session/model in %s", async (mode) => {
		const { fake, ctx, start, select, emit } = mount(mode);
		const notify = (ctx.ui as { notify: ReturnType<typeof vi.fn> }).notify;
		await start();
		await start(); // RPC may emit the same session_start twice.
		await select(old);
		await select(newer);
		await select(old);
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith("gpt-6-luna is newer than gpt-5.6-luna and costs about the same ($1.00/$3.00 vs $1.00/$3.00 per M tokens). Switch with /model openai/gpt-6-luna.", "info");
		// Advice must not alter tools, prompts, messages, reminders, or persisted context.
		expect([...fake.handlers.keys()]).toEqual(["session_start", "model_select"]);
		expect(fake.tools.size).toBe(0);
		expect(fake.commands.size).toBe(0);
		expect(fake.sentMessages).toEqual([]);
		expect(fake.sentUserMessages).toEqual([]);
		expect(fake.appendedEntries).toEqual([]);
		// The only bus traffic is the notice to the lifecycle notice owner.
		expect(new Set(emit.mock.calls.map(([channel]) => channel))).toEqual(new Set([NOTICE_CHANNEL]));
		expect(fake.pi.setModel).not.toHaveBeenCalled();
	});
	it("uses the model_select event model and reevaluates the available catalog", async () => {
		const { ctx, start, select, getAvailable } = mount();
		const notify = (ctx.ui as { notify: ReturnType<typeof vi.fn> }).notify;
		await start();
		getAvailable.mockReturnValue([old, newer, sol]);
		await select(sol);
		expect(notify).toHaveBeenCalledTimes(1);
		getAvailable.mockReturnValue([old, newer, sol, newerSol]);
		await select(sol);
		expect(notify).toHaveBeenCalledTimes(2);
		expect(notify.mock.calls[1][0]).toContain("gpt-6-sol is newer than gpt-5.6-sol");
	});
	it("can show the same model in a different session but not again in the original one", async () => {
		const { ctx, start } = mount();
		const notify = (ctx.ui as { notify: ReturnType<typeof vi.fn> }).notify;
		let session = "one";
		ctx.sessionManager = { getSessionId: () => session };
		await start();
		session = "two";
		await start();
		await start();
		session = "one";
		await start();
		expect(notify).toHaveBeenCalledTimes(2);
	});
	it.each(["print", "json"])("stays silent in %s even if hasUI is true", async (mode) => {
		const { ctx, start, select, getAvailable } = mount(mode);
		await start();
		await select(sol);
		expect((ctx.ui as { notify: unknown }).notify).not.toHaveBeenCalled();
		expect(getAvailable).not.toHaveBeenCalled();
	});
	it("stays silent without a user interface or session model", async () => {
		const { ctx, start, getAvailable } = mount("rpc", false);
		await start();
		ctx.hasUI = true;
		ctx.model = undefined;
		await start();
		expect((ctx.ui as { notify: unknown }).notify).not.toHaveBeenCalled();
		expect(getAvailable).not.toHaveBeenCalled();
	});
	it("honors opt-out at startup and model selection, without marking a suppressed notice as shown", async () => {
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ suggestNewerModels: false }));
		const { ctx, start, select, getAvailable } = mount();
		await start();
		await select(sol);
		expect((ctx.ui as { notify: unknown }).notify).not.toHaveBeenCalled();
		expect(getAvailable).not.toHaveBeenCalled();
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ suggestNewerModels: true }));
		await select(old);
		expect((ctx.ui as { notify: unknown }).notify).toHaveBeenCalledTimes(1);
	});
	it("does not recommend a model this account already refused", async () => {
		const { fake, ctx, start } = mount();
		fake.events.emit(MODEL_UNUSABLE_CHANNEL, { model: "openai/gpt-6-luna", reason: "not supported on this account" });
		await start();
		expect((ctx.ui as { notify: unknown }).notify).not.toHaveBeenCalled();
	});
	it("returns synchronously from session_start without waiting for slow work", () => {
		const { fake, ctx } = mount();
		expect(fake.handlers.get("session_start")![0]({}, ctx)).toBeUndefined();
	});
	it("registers the notice extension in the shipped package", () => {
		const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
		expect(pkg.pi.extensions).toContain("extensions/newer-model/index.ts");
	});
});

describe("readSuggestNewerModels", () => {
	const home = () => join(dir, "home");
	const path = () => oneCodeSettingsPath(home(), {});
	const write = (value: unknown) => {
		mkdirSync(dirname(path()), { recursive: true });
		writeFileSync(path(), JSON.stringify(value));
	};
	it("defaults to true without creating any settings", () => {
		expect(readSuggestNewerModels(home(), {})).toBe(true);
		expect(() => readFileSync(path())).toThrow();
	});
	it.each([{}, null, [], true, "false", { suggestNewerModels: "false" }, { suggestNewerModels: 0 }, { suggestNewerModels: true }])("ignores an absent or invalid boolean in %j", (value) => {
		write(value);
		expect(readSuggestNewerModels(home(), {})).toBe(true);
	});
	it("reads explicit false from One Code, never Claude Code's settings", () => {
		mkdirSync(join(home(), ".claude"), { recursive: true });
		writeFileSync(join(home(), ".claude", "settings.json"), JSON.stringify({ suggestNewerModels: false }));
		expect(readSuggestNewerModels(home(), {})).toBe(true);
		write({ suggestNewerModels: false });
		expect(readSuggestNewerModels(home(), {})).toBe(false);
	});
	it("ignores malformed JSON and respects ONECODE_STATE_DIR", () => {
		write({ suggestNewerModels: false });
		writeFileSync(path(), "{ bad json");
		expect(readSuggestNewerModels(home(), {})).toBe(true);
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ suggestNewerModels: false }));
		expect(readSuggestNewerModels(home(), { ONECODE_STATE_DIR: dir })).toBe(false);
	});
});
