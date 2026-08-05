import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandEnv, loadServers, missingEnvVars, parseServer } from "../../extensions/mcp/config.ts";
import {
	describeContent,
	describeResourceContents,
	jsonSchemaToTypeBox,
	namespacedToolName,
	parseNamespacedToolName,
} from "../../extensions/mcp/schema.ts";

describe("expandEnv", () => {
	it("expands both $VAR and ${VAR}", () => {
		expect(expandEnv("$A/${B}/c", { A: "x", B: "y" })).toBe("x/y/c");
	});

	it("replaces unset variables with an empty string", () => {
		expect(expandEnv("pre-$MISSING-post", {})).toBe("pre--post");
	});
});

describe("parseServer", () => {
	const env = { TOKEN: "secret", HOME_DIR: "/home/u" };

	it("parses a stdio server with args and env expansion", () => {
		expect(parseServer("fs", { command: "npx", args: ["-y", "server", "$HOME_DIR"] }, "/p/.mcp.json", env)).toEqual({
			kind: "stdio",
			name: "fs",
			command: "npx",
			args: ["-y", "server", "/home/u"],
			env: undefined,
			source: "/p/.mcp.json",
		});
	});

	it("parses an http server and expands header values", () => {
		const server = parseServer("api", { url: "https://x/mcp", headers: { Authorization: "Bearer $TOKEN" } }, "s", env);
		expect(server).toMatchObject({ kind: "http", url: "https://x/mcp", headers: { Authorization: "Bearer secret" } });
	});

	it("prefers url over command when both are present", () => {
		expect(parseServer("both", { url: "https://x", command: "npx" }, "s", env)?.kind).toBe("http");
	});

	it("rejects entries that are disabled or have neither command nor url", () => {
		expect(parseServer("x", { command: "npx", disabled: true }, "s", env)).toBeUndefined();
		expect(parseServer("x", {}, "s", env)).toBeUndefined();
		expect(parseServer("x", { command: "   " }, "s", env)).toBeUndefined();
	});
});

describe("loadServers", () => {
	let root: string;
	let home: string;
	let project: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "cc-mcp-"));
		home = join(root, "home");
		project = join(root, "project");
		mkdirSync(home, { recursive: true });
		mkdirSync(join(project, ".claude"), { recursive: true });
		// Mark the project root so the .mcp.json walk stops here.
		mkdirSync(join(project, ".git"), { recursive: true });
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	const write = (path: string, servers: Record<string, unknown>) =>
		writeFileSync(path, JSON.stringify({ mcpServers: servers }));

	it("merges user and project configs, project winning by name", () => {
		write(join(home, ".claude.json"), { a: { command: "user-a" }, shared: { command: "user-shared" } });
		write(join(project, ".mcp.json"), { b: { command: "proj-b" }, shared: { command: "proj-shared" } });
		const servers = loadServers(project, home, {});
		expect(servers.map((s) => s.name)).toEqual(["a", "b", "shared"]);
		expect(servers.find((s) => s.name === "shared")).toMatchObject({ command: "proj-shared" });
	});

	it("lets settings.local.json override the project config", () => {
		write(join(project, ".mcp.json"), { x: { command: "shared" } });
		write(join(project, ".claude", "settings.local.json"), { x: { command: "personal" } });
		expect(loadServers(project, home, {})[0]).toMatchObject({ command: "personal" });
	});

	it("lets a disabled entry remove an inherited server", () => {
		write(join(home, ".claude.json"), { gone: { command: "user" } });
		write(join(project, ".mcp.json"), { gone: { command: "user", disabled: true } });
		expect(loadServers(project, home, {})).toEqual([]);
	});

	it("finds .mcp.json in an ancestor directory", () => {
		const nested = join(project, "packages", "app");
		mkdirSync(nested, { recursive: true });
		write(join(project, ".mcp.json"), { root: { command: "from-root" } });
		expect(loadServers(nested, home, {}).map((s) => s.name)).toEqual(["root"]);
	});

	it("tolerates missing and malformed files", () => {
		writeFileSync(join(project, ".mcp.json"), "{ not json");
		expect(loadServers(project, home, {})).toEqual([]);
	});
});

describe("tool naming", () => {
	it("namespaces as Claude Code does and sanitises illegal characters", () => {
		expect(namespacedToolName("github", "get_issue")).toBe("mcp__github__get_issue");
		expect(namespacedToolName("my-server", "do.thing")).toBe("mcp__my_server__do_thing");
	});

	it("round-trips a namespaced name", () => {
		expect(parseNamespacedToolName("mcp__github__get_issue")).toEqual({ server: "github", tool: "get_issue" });
	});

	it("returns undefined for names that are not namespaced", () => {
		expect(parseNamespacedToolName("read")).toBeUndefined();
		expect(parseNamespacedToolName("mcp__noseparator")).toBeUndefined();
	});
});

describe("jsonSchemaToTypeBox", () => {
	it("converts an object with required and optional properties", () => {
		const schema = jsonSchemaToTypeBox({
			type: "object",
			properties: { path: { type: "string", description: "A path" }, depth: { type: "integer" } },
			required: ["path"],
		}) as Record<string, unknown>;
		expect(schema.type).toBe("object");
		const properties = schema.properties as Record<string, Record<string, unknown>>;
		expect(properties.path.type).toBe("string");
		expect(properties.path.description).toBe("A path");
		expect(schema.required).toEqual(["path"]);
	});

	it("converts primitives and arrays", () => {
		expect((jsonSchemaToTypeBox({ type: "boolean" }) as Record<string, unknown>).type).toBe("boolean");
		const array = jsonSchemaToTypeBox({ type: "array", items: { type: "string" } }) as Record<string, unknown>;
		expect(array.type).toBe("array");
		expect((array.items as Record<string, unknown>).type).toBe("string");
	});

	it("turns an enum into a union of literals", () => {
		const schema = jsonSchemaToTypeBox({ enum: ["a", "b"] }) as Record<string, unknown>;
		expect(Array.isArray(schema.anyOf)).toBe(true);
	});

	it("degrades unknown constructs to something permissive rather than failing", () => {
		expect(jsonSchemaToTypeBox(undefined)).toBeDefined();
		expect(jsonSchemaToTypeBox({ type: "null" })).toBeDefined();
	});

	it("keeps objects open to undeclared properties", () => {
		const schema = jsonSchemaToTypeBox({ type: "object", properties: {} }) as Record<string, unknown>;
		expect(schema.additionalProperties).toBe(true);
	});
});

describe("describeContent", () => {
	it("joins text blocks", () => {
		expect(describeContent([{ type: "text", text: "one" }, { type: "text", text: "two" }]).text).toBe("one\ntwo");
	});

	it("collects images separately with a default mime type", () => {
		const result = describeContent([{ type: "image", data: "abc" }]);
		expect(result.images).toEqual([{ data: "abc", mimeType: "image/png" }]);
	});

	it("renders embedded resources and unknown block types", () => {
		expect(describeContent([{ type: "resource", resource: { text: "body" } }]).text).toBe("body");
		expect(describeContent([{ type: "resource", resource: { uri: "file://x" } }]).text).toContain("file://x");
		expect(describeContent([{ type: "audio" }]).text).toBe("[audio content]");
	});

	it("handles missing content", () => {
		expect(describeContent(undefined)).toEqual({ text: "", images: [] });
	});
});

describe("describeResourceContents", () => {
	it("returns the text of a text resource", () => {
		expect(describeResourceContents([{ uri: "x://a", mimeType: "text/plain", text: "hello" }])).toBe("hello");
	});

	it("joins several entries", () => {
		expect(describeResourceContents([{ text: "one" }, { text: "two" }])).toBe("one\ntwo");
	});

	it("summarises a binary blob instead of dumping base64", () => {
		const out = describeResourceContents([{ uri: "x://img", mimeType: "image/png", blob: "A".repeat(4096) }]);
		expect(out).toContain("binary resource");
		expect(out).toContain("image/png");
		expect(out).not.toContain("AAAA");
	});

	it("handles missing or empty contents", () => {
		expect(describeResourceContents(undefined)).toBe("");
		expect(describeResourceContents([{ uri: "x://empty" }])).toBe("");
	});
});

describe("missing environment variables", () => {
	it("reports variables a value references but that are not set", () => {
		expect(missingEnvVars("Bearer ${TOKEN}", {})).toEqual(["TOKEN"]);
		expect(missingEnvVars("$A/$B", { A: "set" })).toEqual(["B"]);
		expect(missingEnvVars("nothing here", {})).toEqual([]);
		expect(missingEnvVars("${T} and ${T}", {})).toEqual(["T"]);
	});

	it("flags an http server whose auth token is unset instead of sending an empty bearer", () => {
		const server = parseServer(
			"github",
			{ type: "http", url: "https://api.example.com/mcp", headers: { Authorization: "Bearer ${GH_TOKEN}" } },
			"plugin/.mcp.json",
			{},
		);
		expect(server?.missingEnv).toEqual(["GH_TOKEN"]);
	});

	it("flags a stdio server with an unset variable in args or env", () => {
		expect(parseServer("x", { command: "npx", args: ["--key", "$KEY"] }, "s", {})?.missingEnv).toEqual(["KEY"]);
		expect(parseServer("y", { command: "srv", env: { TOKEN: "${SECRET}" } }, "s", {})?.missingEnv).toEqual(["SECRET"]);
	});

	it("leaves missingEnv undefined when everything resolves", () => {
		expect(parseServer("z", { command: "npx", args: ["$A"] }, "s", { A: "ok" })?.missingEnv).toBeUndefined();
	});
});
