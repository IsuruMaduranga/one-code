/**
 * A language server the profile declares (lib/profile/language-servers.ts):
 * the language-server feature routes a file to it by extension, ahead of the
 * base's table, and a product extension's request goes out on the same
 * connection (tools/lsp/request-channel.ts). The real `LspClient` spawns a
 * process, so it is replaced with a fake at the `./client.ts` boundary, as in
 * lsp-wiring.test.ts.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { languageServerProblems, resolveLanguageServers } from "../../extensions/lib/profile/language-servers.ts";
import type { Profile } from "../../extensions/lib/profile/profile-contract.ts";
import { activeProfile, resolveProfile, setActiveProfileForTest } from "../../extensions/lib/profile/profile.ts";
import lspExtension from "../../extensions/tools/lsp/index.ts";
import { lspRequest } from "../../extensions/tools/lsp/request-channel.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";

const state = vi.hoisted(() => ({
	instances: [] as Array<{ config: { command: string; args: string[] }; root: string; options: unknown; requests: Array<[string, unknown, number | undefined]> }>,
	fakeHome: `/nonexistent/lsp-product-server-home-${Math.random().toString(36).slice(2)}`,
}));

vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	const actualDefault = (actual as unknown as { default?: Record<string, unknown> }).default;
	return { ...actual, homedir: () => state.fakeHome, default: { ...actualDefault, homedir: () => state.fakeHome } };
});

vi.mock("../../extensions/tools/lsp/client.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../extensions/tools/lsp/client.ts")>();
	class FakeLspClient {
		requests: Array<[string, unknown, number | undefined]> = [];
		isRunning = true;
		publishCount = 0;
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
			return new Map();
		}
		async request(method: string, params: unknown, timeoutMs?: number) {
			this.requests.push([method, params, timeoutMs]);
			return { echoed: method };
		}
		async stop() {}
	}
	return { ...actual, LspClient: FakeLspClient };
});

const text = activeProfile().text;
const SERVERS = {
	ballerina: {
		command: "${PROFILE_DIR}/ls/start",
		args: ["--jar", "${PROFILE_DIR}/ls/server.jar"],
		extensions: { bal: "ballerina", ".TOML": "toml" },
		rootMarkers: ["Ballerina.toml"],
		env: { LS_HOME: "${PROFILE_DIR}/ls" },
		initializationOptions: { lowCode: true },
	},
};

describe("a profile's language server", () => {
	let dir: string;
	let fake: FakePi;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "lsp-product-"));
		state.instances.length = 0;
		setActiveProfileForTest(resolveProfile({ features: {}, tools: {}, childExtensions: [], text: () => text, languageServers: SERVERS } satisfies Profile, {}, "/profile"));
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
				name: "ballerina",
				command: "/profile/ls/start",
				args: ["--jar", "/profile/ls/server.jar"],
				languageByExtension: { ".bal": "ballerina", ".toml": "toml" },
				rootMarkers: ["Ballerina.toml"],
				env: { LS_HOME: "/profile/ls" },
				initializationOptions: { lowCode: true },
			},
		]);
	});

	it("serves an edited file of its extension, rooted at the nearest marker, with no trust prompt", async () => {
		mkdirSync(join(dir, "pkg", "modules", "a"), { recursive: true });
		writeFileSync(join(dir, "pkg", "Ballerina.toml"), "");
		const file = join(dir, "pkg", "modules", "a", "main.bal");
		writeFileSync(file, "");
		const ctx = createFakeCtx({ cwd: dir });
		await run("tool_result", { toolName: "edit", input: { path: file }, isError: false, content: [], toolCallId: "c" }, ctx);
		expect(state.instances).toHaveLength(1);
		expect(state.instances[0].config).toEqual({ command: "/profile/ls/start", args: ["--jar", "/profile/ls/server.jar"] });
		expect(state.instances[0].root).toBe(join(dir, "pkg"));
		expect(state.instances[0].options).toEqual({ env: { LS_HOME: "/profile/ls" }, initializationOptions: { lowCode: true }, startupTimeoutMs: undefined });
	});

	it("answers a product extension's request on the same connection as the diagnostics", async () => {
		writeFileSync(join(dir, "Ballerina.toml"), "");
		const file = join(dir, "main.bal");
		writeFileSync(file, "");
		const ctx = createFakeCtx({ cwd: dir });
		await run("session_start", {}, ctx);
		await run("tool_result", { toolName: "write", input: { path: file }, isError: false, content: [], toolCallId: "c" }, ctx);
		const answer = await lspRequest(fake.events, { server: "ballerina", file, method: "configEditorV2/getConfigVariables", params: { projectPath: dir }, timeoutMs: 5_000 });
		expect(answer).toEqual({ echoed: "configEditorV2/getConfigVariables" });
		// One server instance: the request reused the one the edit started.
		expect(state.instances).toHaveLength(1);
		expect(state.instances[0].requests).toEqual([["configEditorV2/getConfigVariables", { projectPath: dir }, 5_000]]);
	});

	it("starts the server for a request that comes before any edit", async () => {
		const ctx = createFakeCtx({ cwd: dir });
		await run("session_start", {}, ctx);
		await lspRequest(fake.events, { server: "ballerina", file: "main.bal", method: "x/y" });
		expect(state.instances).toHaveLength(1);
		expect(state.instances[0].root).toBe(dir);
	});

	it("rejects a request for a server the profile does not declare, or with no listener", async () => {
		await run("session_start", {}, createFakeCtx({ cwd: dir }));
		await expect(lspRequest(fake.events, { server: "nope", file: "a.bal", method: "x" })).rejects.toThrow(/declares no language server named "nope"/);
		await expect(lspRequest({ emit: () => {} }, { server: "ballerina", file: "a.bal", method: "x" })).rejects.toThrow(/No language server can answer/);
	});

	it("refuses an entry the base cannot route", () => {
		expect(languageServerProblems({ Bal: { command: "x", extensions: { bal: "b" } } })).toEqual(['language server "Bal" must have a bare lowercase name']);
		expect(languageServerProblems({ a: { command: "", extensions: {} } })).toEqual(['language server "a" has no command', 'language server "a" lists no file extension']);
		expect(languageServerProblems({ a: { command: "x", extensions: { bal: "b" } }, b: { command: "y", extensions: { ".BAL": "b" } } })).toEqual(['language servers "a" and "b" both claim .bal']);
	});
});
