/**
 * request/ledger/wire.ts registers what keeps the wire as pi 1.5.0 sent it:
 * the `anthropic` provider's threadless stream and the idle cache-warm veto.
 * The ledger sim and fake pi swallow both registrations, so this loads the
 * extension on a fake that keeps them.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import ledgerWireExtension from "../../extensions/request/ledger/wire.ts";

const agentDir = mkdtempSync(join(tmpdir(), "oc-wire-wiring-"));
afterAll(() => rmSync(agentDir, { recursive: true, force: true }));
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(join(agentDir, "settings.json"), { force: true });
});

type Handler = (event: unknown, ctx: unknown) => unknown;

function load() {
	const providers: [string, { api?: string; streamSimple?: unknown }][] = [];
	const handlers: Record<string, Handler[]> = {};
	const pi = {
		on: (event: string, handler: Handler) => {
			(handlers[event] ??= []).push(handler);
		},
		events: { on: () => {}, emit: () => {} },
		registerProvider: (name: string, config: { api?: string; streamSimple?: unknown }) => providers.push([name, config]),
	};
	ledgerWireExtension(pi as never);
	const decide = (idle: boolean) => handlers.cache_warming_decision?.[0]?.({ type: "cache_warming_decision", action: "warm" }, { isIdle: () => idle, cwd: agentDir });
	return { providers, handlers, decide };
}

describe("ledger-wire registrations", () => {
	it("registers the anthropic provider's threadless stream on anthropic-messages", () => {
		const { providers } = load();
		expect(providers.map(([name]) => name)).toEqual(["anthropic"]);
		expect(providers[0][1].api).toBe("anthropic-messages");
		expect(typeof providers[0][1].streamSimple).toBe("function");
	});

	it("vetoes an idle warm on pi's default and leaves a warm during a run to pi", () => {
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		const { handlers, decide } = load();
		expect(handlers.cache_warming_decision).toHaveLength(1);
		expect(decide(true)).toEqual({ action: "stop" });
		expect(decide(false)).toBeUndefined();
	});

	it("leaves idle warms to pi when the user set cacheWarming in pi's global settings", () => {
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: "idle" }));
		expect(load().decide(true)).toBeUndefined();
	});
});
