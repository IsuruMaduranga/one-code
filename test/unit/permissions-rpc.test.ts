import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODE_CHANNEL } from "../../extensions/lib/plan-mode-channels.ts";
import permissionsExtension from "../../extensions/permissions/index.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { stubHome } from "./helpers/home.ts";

/** pi's RPC dialogs only dismiss on abort when the extension supplies a signal. */
function rpcDialog<T>(options: { signal?: AbortSignal } | undefined, cancelled: T): Promise<T> {
	return new Promise((resolve) => {
		if (options?.signal?.aborted) resolve(cancelled);
		else options?.signal?.addEventListener("abort", () => resolve(cancelled), { once: true });
	});
}

function bounded<T>(work: Promise<T>): Promise<T | "hung"> {
	return Promise.race([work, new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 100))]);
}

describe("RPC permission prompt cancellation", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "rpc-permissions-"));
		stubHome(join(root, "home"));
		vi.spyOn(os, "homedir").mockReturnValue(join(root, "home"));
		vi.stubEnv("ONECODE_STATE_DIR", join(root, "state"));
		vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		rmSync(root, { recursive: true, force: true });
	});

	for (const kind of ["repository trust", "outside read"] as const) {
		for (const racing of [false, true]) it(`aborting the ${kind} prompt ${racing ? "while an approval arrives" : "while waiting"} never grants access`, async () => {
			const cwd = join(root, "project");
			mkdirSync(join(cwd, ".claude"), { recursive: true });
			if (kind === "repository trust") writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Write"] } }));
			const fake = createFakePi();
			permissionsExtension(fake.pi as never);
			const abort = new AbortController();
			let opened!: () => void;
			const shown = new Promise<void>((resolve) => { opened = resolve; });
			const select = vi.fn((_title: string, _choices: string[], options?: { signal?: AbortSignal }) => {
				opened();
				if (racing) { abort.abort(); return Promise.resolve(_choices[0]); }
				return rpcDialog(options, undefined);
			});
			const confirm = vi.fn((_title: string, _message: string, options?: { signal?: AbortSignal }) => {
				opened();
				if (racing) { abort.abort(); return Promise.resolve(true); }
				return rpcDialog(options, false);
			});
			const ctx = createFakeCtx({
				cwd, mode: "rpc", hasUI: true, signal: abort.signal,
				model: { provider: "anthropic", id: "claude-sonnet-4-6", api: "anthropic-messages", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
				modelRegistry: { getAvailable: () => [] },
				sessionManager: { getSessionDir: () => join(root, "session"), getSessionId: () => "rpc", getBranch: () => [] },
				ui: { select, confirm },
			});
			await fake.fire("session_start", { reason: "startup" }, ctx);
			fake.events.emit(MODE_CHANNEL, { mode: kind === "outside read" ? "auto" : "default" });
			const gate = fake.fireOne("tool_call", {
				toolName: kind === "outside read" ? "read" : "write",
				input: { path: kind === "outside read" ? join(root, "..", "rpc-outside-notes.txt") : "test.txt" }, toolCallId: "call",
			}, ctx);
			const stage = await bounded(Promise.race([shown.then(() => "shown"), gate]));
			expect(stage).toBe("shown");
			if (kind === "repository trust") expect(confirm).toHaveBeenCalledOnce();
			else expect(select.mock.calls[0][0]).toContain("outside");
			abort.abort();
			expect(await bounded(gate)).toMatchObject({ block: true });
		});
	}

	for (const abortAt of ["select", "input"] as const) {
		it(`aborting during ${abortAt} settles the gate without asking another question or granting permission`, async () => {
			const fake = createFakePi();
			permissionsExtension(fake.pi as never);
			const abort = new AbortController();
			let opened!: () => void;
			const shown = new Promise<void>((resolve) => { opened = resolve; });
			const select = vi.fn((_title: string, _choices: string[], options?: { signal?: AbortSignal }) => {
				if (abortAt !== "select") return Promise.resolve("No, tell the agent what to do differently");
				opened();
				return rpcDialog(options, undefined);
			});
			const input = vi.fn((_title: string, _placeholder: string, options?: { signal?: AbortSignal }) => {
				opened();
				return rpcDialog(options, undefined);
			});
			const ctx = createFakeCtx({
				cwd: join(root, "project"), mode: "rpc", hasUI: true, signal: abort.signal,
				modelRegistry: { getAvailable: () => [] },
				sessionManager: { getSessionDir: () => join(root, "session"), getSessionId: () => "rpc", getBranch: () => [] },
				ui: { select, input },
			});
			await fake.fire("session_start", { reason: "startup" }, ctx);
			fake.events.emit(MODE_CHANNEL, { mode: "default" });
			const gate = fake.fireOne("tool_call", { toolName: "write", input: { path: "test.txt", content: "hello" }, toolCallId: "write-1" }, ctx);
			await shown;
			abort.abort();
			expect(await bounded(gate)).toMatchObject({ block: true });
			expect(input).toHaveBeenCalledTimes(abortAt === "input" ? 1 : 0);
		});
	}
});
