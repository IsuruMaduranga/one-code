/**
 * lib/agent-loader.ts openChildSession — the two lifecycle facts every
 * in-process child (subagent, workflow agent) depends on
 * (LIFECYCLE-REVIEW-2026-09-06 H2, H3):
 *
 * 1. pi's `createAgentSession` never emits `session_start` (only `bindExtensions`
 *    does, which the CLI modes call and an SDK caller must call itself), so the
 *    helper emits it — with the caller's reason — before the first prompt.
 * 2. `AgentSession.dispose()` invalidates the LOADER's shared extension runtime,
 *    so a loader reused across sessions leaves the second session's extensions
 *    with a throwing `pi.*` and no bus subscriptions. The helper builds one
 *    loader per session, so the second session's extension works like the first.
 *
 * Real pi SDK sessions on a temp agent dir (no model, no network): nothing is
 * prompted, only created, started and disposed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type InlineExtension, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterAll, describe, expect, it } from "vitest";
import { openChildSession } from "../../extensions/lib/agent-loader.ts";

const agentDir = mkdtempSync(join(tmpdir(), "oc-child-session-agent-"));
afterAll(() => rmSync(agentDir, { recursive: true, force: true }));

/** Records the lifecycle a child extension sees and whether its pi API works at session start. */
function recorder(seen: string[]): InlineExtension {
	return {
		name: "lifecycle-recorder",
		hidden: true,
		factory: (pi) => {
			seen.push("factory");
			pi.events.on("probe:chan", () => seen.push("bus-handler"));
			pi.on("session_start", (event) => {
				seen.push(`session_start:${event.reason}`);
				try {
					pi.events.emit("probe:chan", 1);
					pi.getActiveTools();
					seen.push("api-ok");
				} catch (error) {
					seen.push(`api-threw:${(error as Error).message.slice(0, 40)}`);
				}
			});
		},
	};
}

async function open(seen: string[], startReason?: "startup" | "resume" | "fork") {
	const cwd = process.cwd();
	return openChildSession({
		loader: { cwd, agentDir, extraFactories: [recorder(seen)] },
		session: { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) },
		startReason,
	});
}

describe("openChildSession", () => {
	it("emits session_start (with the given reason) to the child's extensions before any prompt", async () => {
		const seen: string[] = [];
		const session = await open(seen, "resume");
		try {
			expect(seen).toEqual(["factory", "session_start:resume", "bus-handler", "api-ok"]);
		} finally {
			session.dispose();
		}
	});

	it("defaults the reason to startup", async () => {
		const seen: string[] = [];
		const session = await open(seen);
		session.dispose();
		expect(seen).toContain("session_start:startup");
	});

	it("gives every session a working extension runtime, even after an earlier session was disposed", async () => {
		const seen: string[] = [];
		const first = await open(seen);
		first.dispose();
		const second = await open(seen);
		second.dispose();
		// Two factory runs (one loader each), and the second session's emit and
		// getActiveTools succeed — on a shared loader they threw the stale-ctx
		// error and the bus handler never fired (measured, review appendix D).
		expect(seen).toEqual([
			"factory",
			"session_start:startup",
			"bus-handler",
			"api-ok",
			"factory",
			"session_start:startup",
			"bus-handler",
			"api-ok",
		]);
	});

	it("routes a child extension's handler error to onError instead of dropping it", async () => {
		const errors: string[] = [];
		const cwd = process.cwd();
		const throwing: InlineExtension = {
			name: "throws-at-start",
			hidden: true,
			factory: (pi) => {
				pi.on("session_start", () => {
					throw new Error("boom at start");
				});
			},
		};
		const session = await openChildSession({
			loader: { cwd, agentDir, extraFactories: [throwing] },
			session: { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) },
			onError: (error) => errors.push(`${error.event}: ${error.error}`),
		});
		session.dispose();
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("session_start");
		expect(errors[0]).toContain("boom at start");
	});
});
