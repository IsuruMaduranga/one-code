import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import doctorExtension from "../../extensions/doctor/index.ts";
import { setModelFactsForTest } from "../../extensions/lib/model-facts.ts";
import { MODEL_UNUSABLE_CHANNEL } from "../../extensions/lib/model-unusable.ts";
import { SUBAGENT_DEFAULT_CHANGED_CHANNEL } from "../../extensions/lib/settings-channels.ts";
import { PERMISSION_STATUS_CHANNEL } from "../../extensions/permissions/modes.ts";
import { createFakePi, type FakePi } from "./helpers/fake-pi.ts";
import { stubHome } from "./helpers/home.ts";
import { captureUserTurns } from "./helpers/user-turn.ts";

const model = (provider: string, id: string, input: number, api = "anthropic-messages") =>
	({ provider, id, name: id, api, cost: { input, output: input * 5 }, contextWindow: 200_000 }) as any;
const anthropic = [model("anthropic", "claude-opus-5", 5), model("anthropic", "claude-sonnet-5", 3), model("anthropic", "claude-haiku-4-5", 1)];

let home: string;
let cwd: string;
let fake: FakePi;
let startTurn: () => Promise<void>;
let setModel: ReturnType<typeof vi.fn>;
let sessionStarted: boolean;

function ctxFor(current: any | undefined, mode: "tui" | "rpc" | "print" | "json" = "print") {
	const notified: string[] = [];
	vi.spyOn(console, "error").mockImplementation((text) => notified.push(text));
	return {
		notified,
		ctx: {
			cwd,
			hasUI: mode === "tui" || mode === "rpc",
			mode,
			waitForIdle: vi.fn(async () => {}),
			isIdle: () => true,
			sessionManager: { getSessionDir: () => join(cwd, ".sessions") },
			model: current,
			thinkingLevel: "medium",
			modelRegistry: {
				getAll: () => anthropic,
				getAvailable: () => (current ? anthropic : []),
				getProviderAuthStatus: (provider: string) => ({ configured: provider === "anthropic" && !!current, source: "stored" }),
				getProviderDisplayName: (provider: string) => provider,
			},
			ui: { notify: (text: string) => notified.push(text) },
		},
	};
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "onecode-doctor-wiring-home-"));
	cwd = mkdtempSync(join(tmpdir(), "onecode-doctor-wiring-cwd-"));
	stubHome(home);
	vi.stubEnv("PI_CODING_AGENT_DIR", join(home, ".onecode", "agent"));
	vi.stubEnv("ONECODE_NO_UPDATE_CHECK", "1");
	vi.stubEnv("CC_VERSION", "");
	// A clean environment for the checks that read it.
	for (const key of ["CLAUDE_CODE_SUBAGENT_MODEL", "CC_PROMPT_TIER", "CLAUDE_CONFIG_DIR", "AA_API_KEY"]) vi.stubEnv(key, "");
	sessionStarted = false;
	fake = createFakePi();
	startTurn = captureUserTurns(fake);
	setModel = vi.fn(async () => true);
	fake.pi.setModel = setModel;
	doctorExtension(fake.pi as never);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(home, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});

const run = async (args: string, ctx: unknown) => {
	if (!sessionStarted) {
		sessionStarted = true;
		await fake.fire("session_start", { reason: "startup" }, ctx);
	}
	return fake.commands.get("doctor")!.handler(args, ctx);
};

describe("/doctor wiring", () => {
	it("registers the command with argument completions", () => {
		const command = fake.commands.get("doctor")!;
		expect(command).toBeDefined();
		const completions = (command.getArgumentCompletions as (p: string) => Array<{ value: string; description?: string }>)("pre");
		expect(completions.map((c) => c.value)).toEqual(["presets", "preset economical", "preset balanced", "preset quality"]);
		// Every subcommand explains itself in the completion menu.
		const all = (command.getArgumentCompletions as (p: string) => Array<{ value: string; description?: string }>)("");
		expect(all.map((c) => c.value)).toEqual(["report", "presets", "preset economical", "preset balanced", "preset quality"]);
		expect(all.every((c) => (c.description ?? "").length > 20)).toBe(true);
	});

	it.each(["print", "rpc"] as const)("`report` prints the report as a notification in %s, marking a missing provider", async (mode) => {
		const { ctx, notified } = ctxFor(undefined, mode);
		await run("report", ctx);
		expect(notified).toHaveLength(1);
		expect(notified[0]).toContain("One Code doctor");
		expect(notified[0]).toContain("Not ready: no model provider has credentials");
		expect(notified[0]).toContain("Updates: check skipped (ONECODE_NO_UPDATE_CHECK=1)");
		expect(ctx.waitForIdle).not.toHaveBeenCalled();
	});

	it("/doctor report shows the newer-model fix and drops models refused by the account", async () => {
		const main = model("anthropic", "claude-opus-4-8", 5);
		const newer = model("anthropic", "claude-opus-5-5", 4);
		setModelFactsForTest({
			"anthropic/claude-opus-4-8": { releaseDate: "2026-06-01" },
			"anthropic/claude-opus-5-5": { releaseDate: "2026-09-01" },
		});
		const { ctx, notified } = ctxFor(main, "rpc");
		ctx.modelRegistry.getAvailable = () => [main, newer];
		await run("report", ctx);
		const text = notified[0].replace(/\s+/g, " ");
		expect(text).toContain("claude-opus-5-5 is newer than claude-opus-4-8");
		expect(text).toContain("Switch with /model anthropic/claude-opus-5-5.");
		expect(fake.sentUserMessages).toEqual([]);
		fake.events.emit(MODEL_UNUSABLE_CHANNEL, { model: "anthropic/claude-opus-5-5", reason: "no access" });
		await run("report", ctx);
		expect(notified[1]).not.toContain("is newer than");
	});

	it("bare /doctor without a model falls back to the report and says why", async () => {
		const { ctx, notified } = ctxFor(undefined);
		await run("", ctx);
		expect(fake.sentUserMessages).toHaveLength(0);
		expect(notified[0]).toContain("No model is available, so the checkup cannot run");
		expect(notified[1]).toContain("One Code doctor");
		expect(ctx.waitForIdle).not.toHaveBeenCalled();
	});

	it("shows the live permission status it heard on the bus", async () => {
		fake.events.emit(PERMISSION_STATUS_CHANNEL, { mode: "plan", paused: false, classifier: "anthropic/claude-sonnet-5", pinned: true });
		const { ctx, notified } = ctxFor(anthropic[0]);
		await run("report", ctx);
		expect(notified[0]).toContain("Permission mode: plan");
		expect(notified[0]).toMatch(/screening this session on\s+anthropic\/claude-sonnet-5/);
	});

	it("reports the session tier until model_select re-resolves it", async () => {
		vi.stubEnv("CC_PROMPT_TIER", "workhorse");
		const { ctx, notified } = ctxFor(anthropic[0]);
		await run("report", ctx);
		expect(notified[0]).toContain("Prompt register: workhorse");
		vi.stubEnv("CC_PROMPT_TIER", "tiny");
		await run("report", ctx);
		expect(notified[1]).toContain("Prompt register: workhorse");
		ctx.model = anthropic[1];
		await fake.fire("model_select", { model: anthropic[1] }, ctx);
		await run("report", ctx);
		expect(notified[2]).toContain("Prompt register: tiny");
	});

	it("lists the presets on request", async () => {
		const { ctx, notified } = ctxFor(anthropic[1]);
		await run("presets", ctx);
		expect(notified[0]).toContain("economical: main claude-haiku-4-5");
		expect(notified[0]).toContain("balanced: main claude-sonnet-5");
		expect(notified[0]).toContain("← current main model");
	});

	it("applies a preset without changing a legacy classifier override", async () => {
		mkdirSync(join(home, ".onecode"), { recursive: true });
		writeFileSync(join(home, ".onecode", "settings.json"), JSON.stringify({ autoMode: { classifierModel: "anthropic/claude-opus-5", environment: ["x"] }, other: 1 }));
		const heard: string[] = [];
		fake.events.on(SUBAGENT_DEFAULT_CHANGED_CHANNEL, () => heard.push("subagent"));
		const { ctx, notified } = ctxFor(anthropic[1]);
		await run("preset quality", ctx);
		expect(setModel).toHaveBeenCalledTimes(1);
		expect(setModel.mock.calls[0][0].id).toBe("claude-opus-5");
		const saved = JSON.parse(readFileSync(join(home, ".onecode", "settings.json"), "utf8"));
		expect(saved.subagentModel).toBe("inherit");
		expect(saved.autoMode).toEqual({ classifierModel: "anthropic/claude-opus-5", environment: ["x"] });
		expect(saved.other).toBe(1);
		expect(heard).toEqual(["subagent"]);
		expect(notified[0]).toContain("Applied the maximum quality preset");
		expect(notified[0]).toContain("main model → anthropic/claude-opus-5");
	});

	it("does not touch settings when the model switch is refused", async () => {
		setModel.mockResolvedValueOnce(false);
		const { ctx, notified } = ctxFor(anthropic[1]);
		await run("preset economical", ctx);
		expect(notified[0]).toContain("nothing was changed");
		expect(() => readFileSync(join(home, ".onecode", "settings.json"))).toThrow();
	});

	it("rejects an unknown preset and a bare `preset`", async () => {
		const { ctx, notified } = ctxFor(anthropic[1]);
		await run("preset turbo", ctx);
		expect(notified[0]).toContain('Unknown preset "turbo"');
		await run("preset", ctx);
		expect(notified[1]).toContain("Which preset?");
		expect(setModel).not.toHaveBeenCalled();
	});

	it.each(["print", "json"] as const)("waits for the checkup turn in %s mode", async (mode) => {
		const { ctx } = ctxFor(anthropic[1], mode);
		let settle!: () => void;
		const idle = new Promise<void>((resolve) => { settle = resolve; });
		ctx.waitForIdle.mockImplementation(() => {
			expect(fake.sentUserMessages).toHaveLength(1);
			return idle;
		});
		let returned = false;
		const running = run("", ctx).then(() => { returned = true; });
		try {
			await vi.waitFor(() => expect(fake.sentUserMessages).toHaveLength(1));
			expect(returned).toBe(false);
			expect(ctx.waitForIdle).not.toHaveBeenCalled();
			await startTurn();
			await vi.waitFor(() => expect(ctx.waitForIdle).toHaveBeenCalledTimes(1));
			expect(returned).toBe(false);
		} finally {
			settle();
			await running;
		}
		expect(returned).toBe(true);
	});

	it.each(["tui", "rpc"] as const)("does not wait for the checkup turn in %s mode", async (mode) => {
		const { ctx } = ctxFor(anthropic[1], mode);
		await run("", ctx);
		expect(fake.sentUserMessages).toHaveLength(1);
		expect(ctx.waitForIdle).not.toHaveBeenCalled();
	});

	it("bare /doctor with a model sends the report inside the checkup prompt as a user turn", async () => {
		const withModel = ctxFor(anthropic[1], "rpc");
		await run("", withModel.ctx);
		expect(fake.sentUserMessages).toHaveLength(1);
		const content = fake.sentUserMessages[0].content as string;
		expect(content.startsWith("# One Code Doctor")).toBe(true);
		expect(content).toContain("Main: anthropic/claude-sonnet-5");
		expect(content).toContain("One Code never writes Claude Code's files");
		expect(fake.sentUserMessages[0].options).toEqual({ deliverAs: "followUp" });

		await run("fix", withModel.ctx);
		expect(withModel.notified.at(-1)).toContain('Unknown /doctor argument "fix"');
		expect(fake.sentUserMessages).toHaveLength(1);
	});
});

describe("/doctor preset on an unpriced provider", () => {
	it("explains that no preset can be applied instead of calling a valid name unknown", async () => {
		const unpriced = { provider: "ollama", id: "local", name: "local", api: "openai-completions", cost: undefined, contextWindow: 8000 } as any;
		const notified: string[] = [];
	vi.spyOn(console, "error").mockImplementation((text) => notified.push(text));
		const ctx = {
			cwd,
			hasUI: false,
			mode: "print",
			sessionManager: { getSessionDir: () => join(cwd, ".sessions") },
			model: unpriced,
			modelRegistry: { getAll: () => [unpriced], getAvailable: () => [unpriced], getProviderAuthStatus: () => ({ configured: true }), getProviderDisplayName: (p: string) => p },
			ui: { notify: (text: string) => notified.push(text) },
		};
		await run("preset quality", ctx);
		expect(notified[0]).toContain("No priced models on this provider");
		expect(setModel).not.toHaveBeenCalled();
	});
});
