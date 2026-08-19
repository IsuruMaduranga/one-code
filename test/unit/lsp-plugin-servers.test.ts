import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sanitizePathSegment } from "../../extensions/lib/plugin-root.ts";
import {
	collectRawServers,
	pluginDataDir,
	pluginLanguageId,
	readManifestLspServers,
	type ResolvedPluginServer,
	resolveExtensionRouting,
	resolvePluginServers,
	resolveServerConfig,
	resolveWithinPlugin,
	substitute,
} from "../../extensions/lsp/plugin-servers.ts";

const PLUGIN = { name: "demo", path: "/plugins/demo", dataRoot: "/data-root" };

const baseConfig = (overrides?: Record<string, unknown>) => ({
	command: "demo-ls",
	extensionToLanguage: { ".dl": "demolang" },
	...overrides,
});

const resolveOne = (raw: unknown, env: Record<string, string | undefined> = {}) => {
	const diagnostics: string[] = [];
	const server = resolveServerConfig(PLUGIN, "srv", raw, env, diagnostics);
	return { server, diagnostics };
};

describe("substitution", () => {
	const ctx = { pluginRootDir: "/plugins/demo", dataDir: "/data-root/demo", env: { HOME: "/home/u" } };

	it("replaces CLAUDE_PLUGIN_ROOT and CLAUDE_PLUGIN_DATA", () => {
		expect(substitute("${CLAUDE_PLUGIN_ROOT}/bin/ls ${CLAUDE_PLUGIN_DATA}/cache", ctx).value).toBe(
			"/plugins/demo/bin/ls /data-root/demo/cache",
		);
	});

	it("replaces set env vars, uses :- defaults, leaves missing literal", () => {
		expect(substitute("${HOME}/x", ctx).value).toBe("/home/u/x");
		expect(substitute("${MISSING:-fallback}", ctx).value).toBe("fallback");
		const missing = substitute("${MISSING}", ctx);
		expect(missing.value).toBe("${MISSING}");
		expect(missing.missing).toEqual(["MISSING"]);
	});

	it("flags user_config placeholders", () => {
		const result = substitute("${user_config.apiKey}", ctx);
		expect(result.userConfig).toBe(true);
		expect(result.value).toBe("${user_config.apiKey}");
	});
});

describe("resolveServerConfig", () => {
	it("resolves a full config with substitution in command, args, env, workspaceFolder", () => {
		const { server, diagnostics } = resolveOne(
			baseConfig({
				command: "${CLAUDE_PLUGIN_ROOT}/bin/demo-ls",
				args: ["--data", "${CLAUDE_PLUGIN_DATA}", "--home", "${HOME:-/root}"],
				env: { DEMO_HOME: "${CLAUDE_PLUGIN_ROOT}/lib" },
				workspaceFolder: "${CLAUDE_PLUGIN_ROOT}/ws",
				startupTimeout: 120000,
				initializationOptions: { flag: true },
				settings: { demo: { path: "${CLAUDE_PLUGIN_ROOT}" } },
			}),
			{ HOME: "/home/u" },
		);
		expect(diagnostics).toEqual([]);
		expect(server).toMatchObject({
			key: "plugin:demo:srv",
			pluginName: "demo",
			serverName: "srv",
			command: "/plugins/demo/bin/demo-ls",
			args: ["--data", join("/data-root", "demo"), "--home", "/home/u"],
			workspaceFolder: "/plugins/demo/ws",
			startupTimeoutMs: 120000,
			initializationOptions: { flag: true },
		});
		expect(server?.env).toMatchObject({
			CLAUDE_PLUGIN_ROOT: "/plugins/demo",
			CLAUDE_PLUGIN_DATA: join("/data-root", "demo"),
			DEMO_HOME: "/plugins/demo/lib",
		});
		// settings pass through UNSUBSTITUTED — the exclusion is deliberate.
		expect(server?.settings).toEqual({ demo: { path: "${CLAUDE_PLUGIN_ROOT}" } });
	});

	it("rejects a missing or empty extensionToLanguage", () => {
		expect(resolveOne({ command: "x" }).server).toBeUndefined();
		const { server, diagnostics } = resolveOne({ command: "x", extensionToLanguage: {} });
		expect(server).toBeUndefined();
		expect(diagnostics[0]).toContain("extensionToLanguage");
	});

	it("normalizes extension keys to lowercase with a leading dot", () => {
		const { server } = resolveOne(baseConfig({ extensionToLanguage: { BAL: "ballerina", ".XML": "xml" } }));
		expect(server?.languageByExtension).toEqual({ ".bal": "ballerina", ".xml": "xml" });
	});

	it("rejects a command with spaces unless it starts with /", () => {
		expect(resolveOne(baseConfig({ command: "bal start-language-server" })).server).toBeUndefined();
		expect(resolveOne(baseConfig({ command: "/usr/local/my tool/ls" })).server).toBeDefined();
	});

	it("rejects socket transport and the unimplemented lifecycle fields, each by name", () => {
		for (const [field, value] of [
			["transport", "socket"],
			["shutdownTimeout", 5000],
			["restartOnCrash", true],
			["maxRestarts", 3],
		] as const) {
			const { server, diagnostics } = resolveOne(baseConfig({ [field]: value }));
			expect(server).toBeUndefined();
			expect(diagnostics[0]).toContain(String(field));
		}
		expect(resolveOne(baseConfig({ transport: "stdio" })).server).toBeDefined();
	});

	it("rejects a server using ${user_config.*} anywhere substitutable", () => {
		const { server, diagnostics } = resolveOne(baseConfig({ args: ["--key", "${user_config.apiKey}"] }));
		expect(server).toBeUndefined();
		expect(diagnostics[0]).toContain("user_config");
	});

	it("rejects a command left with an unresolved placeholder; args keep it with a diagnostic", () => {
		const missingCommand = resolveOne(baseConfig({ command: "${NOPE}/ls" }));
		expect(missingCommand.server).toBeUndefined();

		const missingArg = resolveOne(baseConfig({ args: ["${NOPE}"] }));
		expect(missingArg.server?.args).toEqual(["${NOPE}"]);
		expect(missingArg.diagnostics[0]).toContain("NOPE");
	});

	it("lets config env override the injected CLAUDE_PLUGIN_* keys", () => {
		const { server } = resolveOne(baseConfig({ env: { CLAUDE_PLUGIN_DATA: "/custom" } }));
		expect(server?.env.CLAUDE_PLUGIN_DATA).toBe("/custom");
	});
});

describe("config sources", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "cc-lsp-plugin-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const plugin = () => ({ name: "demo", path: dir, dataRoot: join(dir, "data") });

	it("reads .lsp.json and manifest lspServers, manifest winning on collision", () => {
		writeFileSync(
			join(dir, ".lsp.json"),
			JSON.stringify({
				srv: baseConfig({ command: "from-lsp-json" }),
				only: baseConfig(),
			}),
		);
		const manifest = { srv: baseConfig({ command: "from-manifest" }) };
		const { servers, diagnostics } = resolvePluginServers(plugin(), join(dir, ".lsp.json"), manifest, {});
		expect(diagnostics).toEqual([]);
		expect(servers.map((s) => [s.serverName, s.command]).sort()).toEqual([
			["only", "demo-ls"],
			["srv", "from-manifest"],
		]);
	});

	it("invalid .lsp.json is one diagnostic; the manifest source still resolves", () => {
		writeFileSync(join(dir, ".lsp.json"), "{ broken");
		const { servers, diagnostics } = resolvePluginServers(plugin(), join(dir, ".lsp.json"), { srv: baseConfig() }, {});
		expect(servers).toHaveLength(1);
		expect(diagnostics[0]).toContain("invalid JSON");
	});

	it("manifest string entries resolve within the plugin dir; escapes are rejected", () => {
		mkdirSync(join(dir, "configs"), { recursive: true });
		writeFileSync(join(dir, "configs", "servers.json"), JSON.stringify({ srv: baseConfig() }));
		const ok = resolvePluginServers(plugin(), undefined, "./configs/servers.json", {});
		expect(ok.servers).toHaveLength(1);

		const traversal = resolvePluginServers(plugin(), undefined, "../outside.json", {});
		expect(traversal.servers).toEqual([]);
		expect(traversal.diagnostics[0]).toContain("escapes the plugin directory");

		const absolute = resolveWithinPlugin(dir, "/etc/servers.json");
		expect(absolute).toBeUndefined();
	});

	it("manifest arrays mix path strings and inline records", () => {
		writeFileSync(join(dir, "extra.json"), JSON.stringify({ fromFile: baseConfig() }));
		const raw = collectRawServers({ name: "demo", path: dir }, undefined, ["./extra.json", { inline: baseConfig() }], []);
		expect(Object.keys(raw).sort()).toEqual(["fromFile", "inline"]);
	});

	it("readManifestLspServers reads the raw field off plugin.json", () => {
		mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
		writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "demo", lspServers: { a: 1 } }));
		expect(readManifestLspServers(dir)).toEqual({ a: 1 });
		expect(readManifestLspServers(join(dir, "missing"))).toBeUndefined();
	});
});

describe("extension routing", () => {
	const server = (pluginName: string, serverName: string, exts: string[]): ResolvedPluginServer => ({
		key: `plugin:${pluginName}:${serverName}`,
		pluginName,
		serverName,
		languageByExtension: Object.fromEntries(exts.map((e) => [e, "lang"])),
		command: "x",
		args: [],
		env: {},
		dataDir: "/tmp/x",
	});

	it("routes each extension to its server", () => {
		const routing = resolveExtensionRouting([server("a", "s1", [".x"]), server("b", "s2", [".y"])]);
		expect(routing.byExtension.get(".x")?.key).toBe("plugin:a:s1");
		expect(routing.byExtension.get(".y")?.key).toBe("plugin:b:s2");
		expect(routing.collisions).toEqual([]);
	});

	it("is deterministic on collision (sorted by key, first wins) and records the loser", () => {
		const routing = resolveExtensionRouting([server("zeta", "s", [".x"]), server("alpha", "s", [".x"])]);
		expect(routing.byExtension.get(".x")?.key).toBe("plugin:alpha:s");
		expect(routing.collisions).toEqual([".x: plugin:zeta:s ignored (plugin:alpha:s claimed it first)"]);
	});

	it("pluginLanguageId picks the extension's language id", () => {
		const s = server("a", "s", [".x"]);
		s.languageByExtension = { ".x": "xlang", ".y": "ylang" };
		expect(pluginLanguageId(s, "/p/file.X")).toBe("xlang");
		expect(pluginLanguageId(s, "/p/file.y")).toBe("ylang");
	});
});

describe("data dir", () => {
	it("sanitizes hostile plugin ids into one safe, never-empty path segment", () => {
		expect(sanitizePathSegment("../../etc")).toBe("------etc");
		expect(sanitizePathSegment("my plugin@mp")).toBe("my-plugin-mp");
		expect(sanitizePathSegment("///")).toBe("---");
		// An all-stripped name must not collapse the data dir onto its parent.
		expect(sanitizePathSegment("")).toBe("unnamed");
		expect(pluginDataDir("/root/data", "a/b")).toBe(join("/root/data", "a-b"));
	});
});
