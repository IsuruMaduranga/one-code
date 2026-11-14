/**
 * A language server the profile declares (lib/profile/language-servers.ts):
 * the language-server feature routes a file to it by extension, ahead of the
 * base's table, and a product extension's request goes out on the same
 * connection (tools/lsp/request-channel.ts), as does its report of files
 * changed on disk. The real `LspClient` spawns a process, so it is replaced
 * with a fake at the `./client.ts` boundary, as in lsp-wiring.test.ts; what
 * the real one sends for a report is lsp-disk-changes.test.ts.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { languageServerProblems, resolveLanguageServers } from "../../extensions/lib/profile/language-servers.ts";
import { setActiveProfileForTest } from "../../extensions/lib/profile/profile.ts";
import lspExtension from "../../extensions/tools/lsp/index.ts";
import { pathToUri } from "../../extensions/tools/lsp/client.ts";
import { lspFilesChanged, lspRequest } from "../../extensions/tools/lsp/request-channel.ts";
import { REMINDER_CHANNEL } from "../../extensions/lib/request/reminders.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";
import { useProfile } from "./helpers/profile.ts";

const state = vi.hoisted(() => ({
	instances: [] as FakeClient[],
	fakeHome: `/nonexistent/lsp-product-server-home-${Math.random().toString(36).slice(2)}`,
}));

interface FakeClient {
	config: { command: string; args: string[] };
	root: string;
	options: unknown;
	requests: Array<[string, unknown, number | undefined]>;
	/** Every call that reaches the server, in order: requests, refreshes, reports. */
	calls: unknown[];
	isRunning: boolean;
	publishCount: number;
	diagnostics: Map<string, unknown[]>;
	/** The uris the next refresh or report says it re-sent. */
	resent: string[];
}

vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	const actualDefault = (actual as unknown as { default?: Record<string, unknown> }).default;
	return { ...actual, homedir: () => state.fakeHome, default: { ...actualDefault, homedir: () => state.fakeHome } };
});

vi.mock("../../extensions/tools/lsp/client.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../extensions/tools/lsp/client.ts")>();
	class FakeLspClient {
		requests: Array<[string, unknown, number | undefined]> = [];
		calls: unknown[] = [];
		isRunning = true;
		publishCount = 0;
		diagnostics = new Map<string, unknown[]>();
		resent: string[] = [];
		error: string | undefined;
		constructor(
			public config: { command: string; args: string[] },
			public root: string,
			public options: unknown,
		) {
			state.instances.push(this);
		}
		async start() {}
		async getDiagnostics() {
			return [];
		}
		allDiagnostics() {
			return this.diagnostics;
		}
		async request(method: string, params: unknown, timeoutMs?: number) {
			this.requests.push([method, params, timeoutMs]);
			this.calls.push(["request", method]);
			return { echoed: method };
		}
		refreshOpenFiles(skip?: string) {
			this.calls.push(["refresh", skip]);
			return this.resent.splice(0);
		}
		applyDiskChanges(changes: unknown[]) {
			this.calls.push(["changes", changes]);
			return this.resent.splice(0);
		}
		async stop() {}
	}
	return { ...actual, LspClient: FakeLspClient };
});

const SERVERS = {
	sample: {
		command: "${PROFILE_DIR}/ls/start",
		args: ["--jar", "${PROFILE_DIR}/ls/server.jar"],
		extensions: { smp: "sample", ".CFG": "config" },
		rootMarkers: ["Sample.project"],
		env: { LS_HOME: "${PROFILE_DIR}/ls" },
		initializationOptions: { mode: "full" },
	},
};

describe("a profile's language server", () => {
	let dir: string;
	let fake: FakePi;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "lsp-product-"));
		state.instances.length = 0;
		useProfile({ languageServers: SERVERS }, "/profile");
		fake = createFakePi();
		lspExtension(fake.pi as never);
	});
	afterEach(() => {
		setActiveProfileForTest(undefined);
		rmSync(dir, { recursive: true, force: true });
	});

	const run = async (event: string, payload: unknown, ctx: unknown) => {
		for (const handler of fake.handlers.get(event) ?? []) await handler(payload, ctx);
	};

	it("fills in the profile folder and normalizes its extensions", () => {
		expect(resolveLanguageServers(SERVERS, "/profile")).toEqual([
			{
				name: "sample",
				command: "/profile/ls/start",
				args: ["--jar", "/profile/ls/server.jar"],
				languageByExtension: { ".smp": "sample", ".cfg": "config" },
				rootMarkers: ["Sample.project"],
				env: { LS_HOME: "/profile/ls" },
				initializationOptions: { mode: "full" },
				startupTimeoutMs: undefined,
			},
		]);
	});

	it("serves an edited file of its extension, rooted at the nearest marker, with no trust prompt", async () => {
		mkdirSync(join(dir, "pkg", "modules", "a"), { recursive: true });
		writeFileSync(join(dir, "pkg", "Sample.project"), "");
		const file = join(dir, "pkg", "modules", "a", "main.smp");
		writeFileSync(file, "");
		const ctx = createFakeCtx({ cwd: dir });
		await run("tool_result", { toolName: "edit", input: { path: file }, isError: false, content: [], toolCallId: "c" }, ctx);
		expect(state.instances).toHaveLength(1);
		expect(state.instances[0].config).toEqual({ command: "/profile/ls/start", args: ["--jar", "/profile/ls/server.jar"] });
		expect(state.instances[0].root).toBe(join(dir, "pkg"));
		expect(state.instances[0].options).toEqual({ env: { LS_HOME: "/profile/ls" }, initializationOptions: { mode: "full" }, startupTimeoutMs: undefined });
	});

	it("starts without the project-trust prompt even when its command is one the base asks about", async () => {
		// jdtls from the base's own table runs project code and asks first; declared by the profile it is product configuration.
		useProfile({ languageServers: { java: { command: "jdtls", extensions: { ".java": "java" } } } }, "/profile");
		const file = join(dir, "Main.java");
		writeFileSync(file, "");
		let asked = false;
		const ctx = createFakeCtx({ cwd: dir, hasUI: true, ui: { confirm: async () => ((asked = true), false), notify: () => {} } });
		await run("tool_result", { toolName: "edit", input: { path: file }, isError: false, content: [], toolCallId: "c" }, ctx);
		expect(asked).toBe(false);
		expect(state.instances.map((instance) => instance.config.command)).toEqual(["jdtls"]);
	});

	it("answers a product extension's request on the same connection as the diagnostics", async () => {
		writeFileSync(join(dir, "Sample.project"), "");
		const file = join(dir, "main.smp");
		writeFileSync(file, "");
		const ctx = createFakeCtx({ cwd: dir });
		await run("session_start", {}, ctx);
		await run("tool_result", { toolName: "write", input: { path: file }, isError: false, content: [], toolCallId: "c" }, ctx);
		const answer = await lspRequest(fake.events, { server: "sample", file, method: "sample/projectInfo", params: { projectPath: dir }, timeoutMs: 5_000 });
		expect(answer).toEqual({ echoed: "sample/projectInfo" });
		// One server instance: the request reused the one the edit started.
		expect(state.instances).toHaveLength(1);
		expect(state.instances[0].requests).toEqual([["sample/projectInfo", { projectPath: dir }, 5_000]]);
	});

	it("starts the server for a request that comes before any edit", async () => {
		const ctx = createFakeCtx({ cwd: dir });
		await run("session_start", {}, ctx);
		await lspRequest(fake.events, { server: "sample", file: "main.smp", method: "x/y" });
		expect(state.instances).toHaveLength(1);
		expect(state.instances[0].root).toBe(dir);
	});

	it("starts no server for a request that arrives after the session ended", async () => {
		await run("session_start", {}, createFakeCtx({ cwd: dir }));
		await run("session_shutdown", {}, createFakeCtx({ cwd: dir }));
		await expect(lspRequest(fake.events, { server: "sample", file: "main.smp", method: "x/y" })).rejects.toThrow(/No session is running/);
		expect(state.instances).toHaveLength(0);
	});

	it("rejects a request for a server the profile does not declare, or with no listener", async () => {
		await run("session_start", {}, createFakeCtx({ cwd: dir }));
		await expect(lspRequest(fake.events, { server: "nope", file: "a.smp", method: "x" })).rejects.toThrow(/declares no language server named "nope"/);
		await expect(lspRequest({ emit: () => {} }, { server: "sample", file: "a.smp", method: "x" })).rejects.toThrow(/No language server can answer/);
	});

	describe("files changed on disk", () => {
		const editOf = (path: string) => ({ toolName: "edit", input: { path }, isError: false, content: [], toolCallId: "c" });
		const project = (name: string) => {
			mkdirSync(join(dir, name), { recursive: true });
			writeFileSync(join(dir, name, "Sample.project"), "");
			const file = join(dir, name, "main.smp");
			writeFileSync(file, "");
			return file;
		};

		it("go to the running server of each file's project, and start none", async () => {
			const one = project("one");
			const two = project("two");
			const ctx = createFakeCtx({ cwd: dir });
			await run("session_start", {}, ctx);
			// No server yet: nothing to update, nothing started.
			await lspFilesChanged(fake.events, { server: "sample", changes: [{ path: one }] });
			expect(state.instances).toHaveLength(0);

			await run("tool_result", editOf(one), ctx);
			expect(state.instances).toHaveLength(1);
			await lspFilesChanged(fake.events, {
				server: "sample",
				changes: [{ path: "one/types.smp", type: "created" }, { path: two }, { path: join(dir, "one", "Sample.project") }],
			});
			// One report per server, relative paths resolved against the session's directory; project two runs no server.
			expect(state.instances).toHaveLength(1);
			expect(state.instances[0].calls).toEqual([
				["changes", [{ path: join(dir, "one", "types.smp"), type: "created" }, { path: join(dir, "one", "Sample.project"), type: undefined }]],
			]);
		});

		it("are applied before the report returns, so the request after it sees them", async () => {
			const file = project("p");
			const ctx = createFakeCtx({ cwd: dir });
			await run("session_start", {}, ctx);
			await run("tool_result", editOf(file), ctx);
			const report = lspFilesChanged(fake.events, { server: "sample", changes: [{ path: file }] });
			expect(state.instances[0].calls).toEqual([["changes", [{ path: file, type: undefined }]]]);
			await report;
		});

		it("are rejected for a server the profile does not declare, and resolve where nothing listens", async () => {
			await run("session_start", {}, createFakeCtx({ cwd: dir }));
			await expect(lspFilesChanged(fake.events, { server: "nope", changes: [{ path: "a.smp" }] })).rejects.toThrow(/declares no language server named "nope"/);
			await expect(lspFilesChanged({ emit: () => {} }, { server: "sample", changes: [{ path: "a.smp" }] })).resolves.toBeUndefined();
		});

		it("are looked for on disk before a product's request goes out", async () => {
			const file = project("p");
			const ctx = createFakeCtx({ cwd: dir });
			await run("session_start", {}, ctx);
			await lspRequest(fake.events, { server: "sample", file, method: "x/y" });
			expect(state.instances[0].calls).toEqual([["refresh", undefined], ["request", "x/y"]]);
		});

		it("are looked for on disk before lsp_diagnostics reads a file, which it syncs itself", async () => {
			const file = project("p");
			const ctx = createFakeCtx({ cwd: dir });
			await fake.tools.get("lsp_diagnostics")!.execute("t", { path: file }, undefined, undefined, ctx);
			expect(state.instances[0].calls).toEqual([["refresh", file]]);
		});

		it("reset a re-sent file's delivered diagnostics, as an edit does", async () => {
			const file = project("p");
			const uri = pathToUri(file);
			const delivered: Array<{ text?: string }> = [];
			fake.events.on(REMINDER_CHANNEL, (data) => delivered.push(data as never));
			const ctx = createFakeCtx({ cwd: dir });
			await run("session_start", {}, ctx);
			await run("tool_result", editOf(file), ctx);
			const client = state.instances[0];
			client.publishCount = 1;
			client.diagnostics.set(uri, [{ range: { start: { line: 0, character: 0 } }, severity: 1, message: "undefined symbol" }]);
			const round = () => run("tool_result", { toolName: "bash", input: {}, isError: false, content: [], toolCallId: "r" }, ctx);
			await round();
			expect(delivered).toHaveLength(1);

			// A report that re-sent nothing changes nothing.
			await lspFilesChanged(fake.events, { server: "sample", changes: [{ path: file }] });
			await round();
			expect(delivered).toHaveLength(1);

			// One that re-sent the open file: the still-present error is news again, as after an edit.
			client.resent = [uri];
			await lspFilesChanged(fake.events, { server: "sample", changes: [{ path: file }] });
			await round();
			expect(delivered).toHaveLength(2);
			expect(delivered[1].text).toContain("undefined symbol");
		});
	});

	it("refuses an entry the base cannot route", () => {
		expect(languageServerProblems({ Smp: { command: "x", extensions: { smp: "s" } } })).toEqual(['language server "Smp" must have a bare lowercase name']);
		expect(languageServerProblems({ a: { command: "", extensions: {} } })).toEqual(['language server "a" has no command', 'language server "a" lists no file extension']);
		expect(languageServerProblems({ a: { command: "x", extensions: { smp: "s" } }, b: { command: "y", extensions: { ".SMP": "s" } } })).toEqual(['language servers "a" and "b" both claim .smp']);
	});
});
