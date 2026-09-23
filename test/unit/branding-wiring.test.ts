import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import brandingExtension from "../../extensions/branding/index.ts";
import { ARGUMENT_HINT_CHANNEL } from "../../extensions/lib/argument-hints.ts";

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
	const fire = (event: string, ctx: unknown) => {
		for (const fn of handlers.get(event) ?? []) fn({}, ctx);
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
