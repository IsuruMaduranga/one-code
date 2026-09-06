import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandEnv, loadServers, missingEnvVars, parseServer, referencedEnvVars } from "../../extensions/mcp/config.ts";
import {
	capDescription,
	DESCRIPTION_CAP,
	describeContent,
	describeResourceContents,
	jsonSchemaToTypeBox,
	namespacedToolName,
	parseNamespacedToolName,
	pluginServerName,
	validateImageData,
} from "../../extensions/mcp/schema.ts";
import { createTailBuffer } from "../../extensions/mcp/client.ts";

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
			referencedEnv: ["HOME_DIR"],
		});
	});

	it("parses an http server and expands header values, capturing the referenced var name", () => {
		const server = parseServer("api", { url: "https://x/mcp", headers: { Authorization: "Bearer $TOKEN" } }, "s", env);
		expect(server).toMatchObject({ kind: "http", url: "https://x/mcp", headers: { Authorization: "Bearer secret" } });
		// The var name is kept for the consent dialog even though the value is expanded away (review M5).
		expect(server?.referencedEnv).toEqual(["TOKEN"]);
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
	it("namespaces as Claude Code does: hyphens kept, other illegal characters sanitised", () => {
		expect(namespacedToolName("github", "get_issue")).toBe("mcp__github__get_issue");
		expect(namespacedToolName("my-server", "do.thing")).toBe("mcp__my-server__do_thing");
		// CC's capture: mcp__plugin_context7_context7__query-docs
		expect(namespacedToolName(pluginServerName("context7", "context7"), "query-docs")).toBe(
			"mcp__plugin_context7_context7__query-docs",
		);
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

	it("collects a decodable image, deriving the mime type from its bytes", () => {
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString("base64");
		const result = describeContent([{ type: "image", data: png, mimeType: "image/gif" }]);
		// mimeType comes from the magic bytes (png), not the server's claim (gif).
		expect(result.images).toEqual([{ data: png, mimeType: "image/png" }]);
	});

	it("turns an undecodable image into a text note instead of poisoning the request (review H4)", () => {
		const junk = Buffer.from("this is not an image at all").toString("base64");
		const result = describeContent([{ type: "image", data: junk, mimeType: "image/png" }], "stub");
		expect(result.images).toEqual([]);
		expect(result.text).toContain("could not be decoded");
		expect(result.text).toContain("stub");
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

describe("validateImageData", () => {
	const b64 = (bytes: number[]) => Buffer.from(bytes).toString("base64");
	it("accepts png/jpeg/gif/webp by magic bytes and reports the true mime", () => {
		expect(validateImageData(b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "x")).toEqual({ ok: true, mimeType: "image/png" });
		expect(validateImageData(b64([0xff, 0xd8, 0xff, 0x00]), "x")).toEqual({ ok: true, mimeType: "image/jpeg" });
		expect(validateImageData(b64([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]), "x")).toEqual({ ok: true, mimeType: "image/gif" });
		const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP")]).toString("base64");
		expect(validateImageData(webp, "x")).toEqual({ ok: true, mimeType: "image/webp" });
	});
	it("rejects unrecognised and empty data", () => {
		expect(validateImageData(Buffer.from("nope").toString("base64"), "image/png").ok).toBe(false);
		expect(validateImageData("", "image/png").ok).toBe(false);
	});
});

describe("referencedEnvVars", () => {
	it("collects every $VAR and ${VAR} name referenced", () => {
		expect(referencedEnvVars("Bearer ${TOKEN}", "$OTHER and plain")).toEqual(["TOKEN", "OTHER"]);
		expect(referencedEnvVars("no vars here")).toEqual([]);
	});
});

describe("capDescription (review L2)", () => {
	it("passes short descriptions through and truncates long ones with a labelled marker", () => {
		expect(capDescription("short")).toBe("short");
		expect(capDescription(undefined)).toBeUndefined();
		const big = "z".repeat(DESCRIPTION_CAP + 500);
		const capped = capDescription(big)!;
		expect(capped.length).toBeLessThan(big.length);
		expect(capped).toContain("[truncated,");
	});

	it("caps a parameter description inside a converted schema", () => {
		const big = "y".repeat(DESCRIPTION_CAP + 100);
		const schema = jsonSchemaToTypeBox({ type: "object", properties: { q: { type: "string", description: big } } }) as {
			properties: { q: { description: string } };
		};
		expect(schema.properties.q.description.length).toBeLessThan(big.length);
		expect(schema.properties.q.description).toContain("[truncated,");
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

describe("mcpInstructionsReminder", () => {
	it("formats per-server sections and skips servers without instructions", async () => {
		const { mcpInstructionsReminder } = await import("../../extensions/mcp/client.ts");
		const text = mcpInstructionsReminder([
			{ server: { name: "deepwiki" }, instructions: "Ask questions about repos." },
			{ server: { name: "silent" } },
		]);
		expect(text).toContain("# MCP Server Instructions");
		expect(text).toContain("## deepwiki\nAsk questions about repos.");
		expect(text).not.toContain("silent");
	});

	it("returns undefined when no server has instructions, truncates long ones", async () => {
		const { mcpInstructionsReminder } = await import("../../extensions/mcp/client.ts");
		expect(mcpInstructionsReminder([{ server: { name: "s" } }])).toBeUndefined();
		const long = mcpInstructionsReminder([{ server: { name: "s" }, instructions: "x".repeat(5000) }]);
		expect(long).toContain("… [truncated]");
		expect(long!.length).toBeLessThan(4000);
	});
});

describe("createTailBuffer", () => {
	it("keeps only the last `cap` characters and trims", () => {
		const tail = createTailBuffer(10);
		tail.push("abcdefgh");
		tail.push(Buffer.from("ijklmn\n"));
		expect(tail.text()).toBe("fghijklmn");
	});
});

