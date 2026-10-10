import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import effortExtension from "../../extensions/effort/index.ts";
import { REMINDER_CHANNEL } from "../../extensions/lib/reminders.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { stubHome } from "./helpers/home.ts";

let home: string;
let agentDir: string;
let settingsPath: string;
const model = { provider: "openai", id: "reasoner", name: "Reasoner", reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } };
const key = `${model.provider}/${model.id}`;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "effort-persistence-"));
	agentDir = join(home, ".onecode", "agent");
	settingsPath = join(agentDir, "settings.json");
	stubHome(home);
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("ONECODE_STATE_DIR", join(home, ".onecode"));
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(home, { recursive: true, force: true });
});

function seed(value: unknown) {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(settingsPath, JSON.stringify(value));
}
function settings() {
	return JSON.parse(readFileSync(settingsPath, "utf8"));
}
function mount(mode = "rpc", currentModel: unknown = model) {
	const fake = createFakePi();
	let level = "medium";
	fake.pi.getThinkingLevel = vi.fn(() => level);
	fake.pi.setThinkingLevel = vi.fn((wanted: string) => { level = wanted; });
	fake.pi.getSettings = () => ({ defaultThinkingLevel: "medium" });
	const ctx = createFakeCtx({ model: currentModel, mode, hasUI: mode === "rpc" || mode === "tui" });
	const reminders: Array<{ text?: string }> = [];
	fake.events.on(REMINDER_CHANNEL, (data) => reminders.push(data as { text?: string }));
	effortExtension(fake.pi as never);
	const command = (arg: string) => fake.commands.get("effort")!.handler(arg, ctx);
	const notices = () => (ctx._notified as Array<{ message: string }>).map((n) => n.message);
	return { fake, ctx, command, notices, reminders, level: () => level };
}

describe("/effort persistence (Claude Code 2.1.296)", () => {
	it.each(["low", "medium", "high", "xhigh"])("saves interactive %s per model and pi reloads it after restart", async (level) => {
		seed({ theme: "onecode", modelThinkingLevels: { "other/model": "low" } });
		const { command, level: actual } = mount();
		await command(level);
		expect(actual()).toBe(level);
		expect(settings()).toEqual({ theme: "onecode", modelThinkingLevels: { "other/model": "low", [key]: level } });
		const restarted = SettingsManager.create(home, agentDir);
		expect(restarted.getModelThinkingLevel(model.provider, model.id)).toBe(level);
		expect(existsSync(join(home, ".claude"))).toBe(false);
	});

	it.each([undefined, "low"] as const)("a fresh pi session restores saved effort unless explicitly overridden by %s", async (thinkingLevel) => {
		await mount().command("high");
		const manager = SettingsManager.create(home, agentDir);
		const loader = new DefaultResourceLoader({
			cwd: home, agentDir, settingsManager: manager,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		});
		await loader.reload();
		const runtime = await ModelRuntime.create({
			credentials: { read: async () => undefined, list: async () => [], modify: async () => undefined, delete: async () => {} },
			modelsPath: null, refreshOnCreate: false,
		});
		const { session } = await createAgentSession({
			cwd: home, agentDir, resourceLoader: loader, settingsManager: manager, modelRuntime: runtime,
			model: model as never, thinkingLevel, tools: [], sessionManager: SessionManager.inMemory(home),
		});
		try {
			expect(session.thinkingLevel).toBe(thinkingLevel ?? "high");
		} finally {
			session.dispose();
		}
	});

	it("keeps max session-only without overwriting the saved level", async () => {
		seed({ modelThinkingLevels: { [key]: "low" } });
		const { command, notices, level } = mount();
		await command("max");
		expect(level()).toBe("max");
		expect(settings().modelThinkingLevels[key]).toBe("low");
		expect(notices()).toContain("Set effort level to max (this session only): Maximum capability with deepest reasoning. May use excessive tokens resulting in long response times or overthinking. Use sparingly for the hardest tasks.");
	});

	it.each(["auto", "unset"])("%s clears only the current model and restores the session default", async (arg) => {
		seed({ theme: "onecode", modelThinkingLevels: { [key]: "high", "other/model": "low" } });
		const { command, notices, level } = mount();
		await command("high");
		await command(arg);
		expect(level()).toBe("medium");
		expect(settings()).toEqual({ theme: "onecode", modelThinkingLevels: { "other/model": "low" } });
		expect(notices()).toContain("Effort level set to auto");
	});

	it.each(["print", "json"])("does not persist choices in noninteractive %s sessions", async (mode) => {
		seed({ modelThinkingLevels: { [key]: "low" } });
		const { command, level, notices } = mount(mode);
		await command("high");
		expect(level()).toBe("high");
		expect(settings().modelThinkingLevels[key]).toBe("low");
		expect(notices()).toContain("Set effort level to high (this session only): Comprehensive implementation with extensive testing and documentation");
	});

	it("reports the exact saved response in the UI and local-command stdout", async () => {
		const { command, notices, reminders } = mount();
		await command("high");
		const stdout = "Set effort level to high (saved as your default for new sessions): Comprehensive implementation with extensive testing and documentation";
		expect(notices()).toContain(stdout);
		expect(reminders.some((r) => r.text === `<local-command-stdout>${stdout}</local-command-stdout>\n`)).toBe(true);
	});

	it("does not erase malformed settings and reports the save failure", async () => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(settingsPath, "{ malformed");
		const { command, notices } = mount();
		await command("high");
		expect(readFileSync(settingsPath, "utf8")).toBe("{ malformed");
		expect(notices().join("\n")).toContain("Failed to set effort level:");
		expect(notices().join("\n")).not.toContain("saved as your default");
	});

	it.each(["off", "minimal", "ultracode", "not-a-level"])("does not add persistence for %s", async (arg) => {
		const { command } = mount();
		await command(arg);
		expect(existsSync(settingsPath)).toBe(false);
	});

	it.each(["enter", "session", "cancel"])("the slider's %s action uses the correct save scope", async (action) => {
		seed({ modelThinkingLevels: { [key]: "low" } });
		const { fake, ctx, command, level } = mount("tui");
		(ctx.ui as { custom: ReturnType<typeof vi.fn> }).custom.mockImplementation(async (factory) => new Promise((done) => {
			const component = factory({ requestRender: vi.fn() }, {}, {}, done);
			// The current stop is medium. Move to high, then confirm or cancel.
			component.handleInput("\u001b[C");
			component.handleInput(action === "enter" ? "\r" : action === "session" ? "s" : "\u001b");
		}));
		await command("");
		expect(level()).toBe(action === "cancel" ? "medium" : "high");
		expect(settings().modelThinkingLevels[key]).toBe(action === "enter" ? "high" : "low");
		await fake.fire("session_shutdown", {}, ctx);
	});

	it("does not persist a model-capped selection", async () => {
		const { fake, command } = mount();
		fake.pi.setThinkingLevel = vi.fn();
		fake.pi.getThinkingLevel = vi.fn(() => "medium");
		await command("high");
		expect(existsSync(settingsPath)).toBe(false);
	});
});
