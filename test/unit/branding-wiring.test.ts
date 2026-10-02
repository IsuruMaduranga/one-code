import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import brandingExtension from "../../extensions/branding/index.ts";
import { ARGUMENT_HINT_CHANNEL } from "../../extensions/lib/argument-hints.ts";
import { KEEP_DECLINED_KEY } from "../../extensions/branding/compaction-keep.ts";
import { KEEP_NO, KEEP_YES } from "../../extensions/lib/compaction-keep.mjs";
import { TURN_OFF_YES } from "../../extensions/lib/replaced-builtins.mjs";

function fakePi() {
	const handlers = new Map<string, ((event: unknown, ctx: unknown) => void)[]>();
	const listeners = new Map<string, ((data: unknown) => void)[]>();
	const pi = {
		on: (event: string, fn: (event: unknown, ctx: unknown) => void) => handlers.set(event, [...(handlers.get(event) ?? []), fn]),
		events: {
			on: (channel: string, fn: (data: unknown) => void) => listeners.set(channel, [...(listeners.get(channel) ?? []), fn]),
			emit: (channel: string, data: unknown) => {
				for (const fn of listeners.get(channel) ?? []) fn(data);
			},
		},
		getSessionName: () => undefined,
	};
	const fire = (event: string, ctx: unknown, payload: unknown = {}) => {
		for (const fn of handlers.get(event) ?? []) fn(payload, ctx);
	};
	return { pi, fire };
}

describe("branding session_start", () => {
	const dirs: string[] = [];
	afterEach(() => {
		vi.unstubAllEnvs();
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("installs the prompt editor with argument hints when the banner is off (CC_NO_BANNER=1)", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "branding-"));
		dirs.push(agentDir);
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("CC_NO_BANNER", "1");
		const { pi, fire } = fakePi();
		brandingExtension(pi as never);
		let factory: unknown;
		const ctx = {
			hasUI: true,
			mode: "tui",
			cwd: agentDir,
			ui: { setHiddenThinkingLabel: () => {}, setEditorComponent: (f: unknown) => (factory = f), notify: () => {}, setTitle: () => {} },
		};
		expect(() => fire("session_start", ctx)).not.toThrow();
		expect(typeof factory).toBe("function");
		// The hint listener exists even though the banner code never ran.
		expect(() => pi.events.emit(ARGUMENT_HINT_CHANNEL, { command: "btw", hint: "[question]" })).not.toThrow();
	});
});

describe("branding: pi's built-in tool search and MCP at startup", () => {
	const dirs: string[] = [];
	afterEach(() => {
		vi.unstubAllEnvs();
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	/** A user's own pi (no app) whose settings leave both built-ins on, and a session context that answers the question. */
	const setup = (projectExtensions?: string[]) => {
		const root = mkdtempSync(join(tmpdir(), "branding-builtins-"));
		dirs.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		// The keep window is set, so the compaction keep-window question stays out of these tests.
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 0 } }));
		if (projectExtensions) writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ extensions: projectExtensions }));
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("HOME", root);
		vi.stubEnv("CC_VERSION", "");
		vi.stubEnv("CC_NO_BANNER", "1");
		const select = vi.fn(async () => TURN_OFF_YES);
		const notify = vi.fn();
		const ctx = { hasUI: true, mode: "tui", cwd, ui: { setHiddenThinkingLabel: () => {}, setEditorComponent: () => {}, notify, setTitle: () => {}, select } };
		const { pi, fire } = fakePi();
		brandingExtension(pi as never);
		return { agentDir, ctx, fire, select, notify };
	};
	const settled = () => new Promise((resolve) => setTimeout(resolve, 50));

	it("asks at startup, but not again on /new, resume or fork", async () => {
		const { ctx, fire, select } = setup();
		for (const reason of ["new", "resume", "fork"]) fire("session_start", ctx, { reason });
		await settled();
		expect(select).not.toHaveBeenCalled();
		fire("session_start", ctx, { reason: "startup" });
		await settled();
		expect(select).toHaveBeenCalledTimes(1);
	});

	it("after a yes, names the built-in the project's settings keep on", async () => {
		const { agentDir, ctx, fire, notify } = setup(["+builtin:mcp"]);
		fire("session_start", ctx, { reason: "startup" });
		await settled();
		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).extensions).toEqual(["-builtin:tool-search"]);
		const texts = notify.mock.calls.map(([text]) => String(text));
		expect(texts.some((text) => text.includes("Turned off pi's built-in tool-search") && text.includes("This project's settings keep mcp on"))).toBe(true);
	});
});

describe("branding: pi's compaction keep window at startup", () => {
	const dirs: string[] = [];
	afterEach(() => {
		vi.unstubAllEnvs();
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	/** A user's own pi with both built-ins already off, so only the keep-window question can show. */
	const setup = (answer: string, userSettings: Record<string, unknown> = {}) => {
		const root = mkdtempSync(join(tmpdir(), "branding-keep-"));
		dirs.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: ["-builtin:tool-search", "-builtin:mcp"], ...userSettings }));
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("HOME", root);
		vi.stubEnv("ONECODE_STATE_DIR", join(root, ".onecode"));
		vi.stubEnv("CC_VERSION", "");
		vi.stubEnv("CC_NO_BANNER", "1");
		const select = vi.fn(async () => answer);
		const ctx = { hasUI: true, mode: "tui", cwd, ui: { setHiddenThinkingLabel: () => {}, setEditorComponent: () => {}, notify: vi.fn(), setTitle: () => {}, select } };
		const { pi, fire } = fakePi();
		brandingExtension(pi as never);
		return { root, agentDir, ctx, fire, select };
	};
	const settled = () => new Promise((resolve) => setTimeout(resolve, 50));
	const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

	it("asks once and writes 0 into the user's pi settings, keeping their other keys", async () => {
		const { agentDir, ctx, fire, select } = setup(KEEP_YES, { compaction: { enabled: true } });
		fire("session_start", ctx, { reason: "startup" });
		await settled();
		expect(select).toHaveBeenCalledTimes(1);
		const written = readJson(join(agentDir, "settings.json"));
		expect(written.compaction).toEqual({ enabled: true, keepRecentTokens: 0 });
		expect(written.extensions).toEqual(["-builtin:tool-search", "-builtin:mcp"]);
	});

	it("remembers a no and never asks again", async () => {
		const { root, ctx, fire, select } = setup(KEEP_NO);
		fire("session_start", ctx, { reason: "startup" });
		await settled();
		expect(readJson(join(root, ".onecode", "settings.json"))[KEEP_DECLINED_KEY]).toBe(true);
		fire("session_start", ctx, { reason: "startup" });
		await settled();
		expect(select).toHaveBeenCalledTimes(1);
	});

	it("leaves an explicit value alone, and never asks under the app", async () => {
		const explicit = setup(KEEP_YES, { compaction: { keepRecentTokens: 20000 } });
		explicit.fire("session_start", explicit.ctx, { reason: "startup" });
		await settled();
		expect(explicit.select).not.toHaveBeenCalled();
		const app = setup(KEEP_YES);
		vi.stubEnv("CC_VERSION", "1.0.0");
		app.fire("session_start", app.ctx, { reason: "startup" });
		await settled();
		expect(app.select).not.toHaveBeenCalled();
	});
});
