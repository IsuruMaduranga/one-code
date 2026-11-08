import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandEnv, loadServers, missingEnvVars, parseServer, referencedEnvVars } from "../../extensions/mcp/config.ts";
import {
	capDescription as capWith,
	DESCRIPTION_CAP,
	describeContent as describeWith,
	describeResourceContents as describeResourceWith,
	jsonSchemaToTypeBox as convertSchema,
	namespacedToolName,
	parseNamespacedToolName,
	pluginServerName,
	validateImageData,
} from "../../extensions/mcp/schema.ts";
import { createTailBuffer, mcpInstructionsReminder as instructionsWith } from "../../extensions/mcp/client.ts";
import { requireText } from "../../extensions/lib/profile.ts";
import { makeMcpConfigDirs, piMcpConfigs, writeMcpServers as write } from "./helpers/mcp-config.ts";
import { TINY_GIF, TINY_JPEG, TINY_PNG, TINY_WEBP } from "./helpers/tiny-images.ts";

const mcpText = requireText("mcp");

/** The pure functions with the profile's text, as the extension passes it. */
const capDescription = (text: string | undefined) => capWith(text, mcpText.tool.descriptionCut);
const jsonSchemaToTypeBox = (schema: Parameters<typeof convertSchema>[0]) => convertSchema(schema, mcpText.tool.descriptionCut);
const describeContent = (blocks: Parameters<typeof describeWith>[0], server?: string) => describeWith(blocks, mcpText.content, server);
const describeResourceContents = (contents: Parameters<typeof describeResourceWith>[0]) => describeResourceWith(contents, mcpText.content);
const mcpInstructionsReminder = (connections: Parameters<typeof instructionsWith>[0]) => instructionsWith(connections, mcpText);

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
		({ root, home, project } = makeMcpConfigDirs());
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	describe("pi's own mcp.json files", () => {
		const piConfigs = () => piMcpConfigs(home, project);

		it("reads both in pi's format: ~/ and a relative cwd resolved, enabled: false skipped, project over user", () => {
			const { user, project: projectFile } = piConfigs();
			write(user, { tools: { command: "~/bin/tools", args: ["~/data"], cwd: "work" }, off: { command: "x", enabled: false }, shared: { url: "https://user.example/mcp" } });
			write(projectFile, { shared: { url: "https://project.example/mcp" } });
			const servers = loadServers(project, home, {}, [], { piConfigs: piConfigs() });
			expect(servers.map((s) => s.name)).toEqual(["shared", "tools"]);
			expect(servers.find((s) => s.name === "tools")).toMatchObject({ command: join(home, "bin", "tools"), args: [join(home, "data")], cwd: join(project, "work"), source: user, piOrigin: "user" });
			expect(servers.find((s) => s.name === "shared")).toMatchObject({ url: "https://project.example/mcp", source: projectFile, piOrigin: "project" });
		});

		it("skips a server with a !command value, with a note", () => {
			const { user } = piConfigs();
			write(user, { gh: { url: "https://api.example/mcp", headers: { Authorization: "!echo Bearer $(gh auth token)" } } });
			const notes: string[] = [];
			const servers = loadServers(project, home, {}, [], { piConfigs: piConfigs(), onNote: (m) => notes.push(m) });
			expect(servers).toEqual([]);
			expect(notes).toEqual([`MCP server "gh" in ${user} is skipped: a \`!command\` value in env or headers is not supported.`]);
		});

		it("reads servers other extensions registered, below every file, with the extension as the source", () => {
			const { user } = piConfigs();
			write(user, { shared: { command: "from-pi" } });
			const registered = [
				{ name: "jira", config: { url: "https://mcp.example.com/jira" }, extensionPath: "/ext/jira.ts" },
				{ name: "shared", config: { command: "from-extension" }, extensionPath: "/ext/other.ts" },
				{ name: "bad", config: { url: "https://x", headers: { A: "!cmd" } }, extensionPath: "/ext/bad.ts" },
			];
			const notes: string[] = [];
			const servers = loadServers(project, home, {}, [], { piConfigs: piConfigs(), registered, onNote: (m) => notes.push(m) });
			expect(servers.map((s) => [s.name, s.source])).toEqual([
				["jira", "/ext/jira.ts"],
				["shared", user],
			]);
			expect(servers[0].piOrigin).toBe("extension");
			expect(notes).toEqual(['MCP server "bad" registered by /ext/bad.ts is skipped: a `!command` value in env or headers is not supported.']);
		});

		it("reads neither file unless asked", () => {
			write(piConfigs().user, { tools: { command: "x" } });
			expect(loadServers(project, home, {})).toEqual([]);
		});
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
		const png = TINY_PNG;
		const result = describeContent([{ type: "image", data: png, mimeType: "image/gif" }]);
		// mimeType comes from the magic bytes (png), not the server's claim (gif).
		expect(result.images).toEqual([{ data: png, mimeType: "image/png" }]);
	});

	it("turns an undecodable image into a text note instead of poisoning the request (review H4)", () => {
		const junk = Buffer.from("this is not an image at all").toString("base64");
		const result = describeContent([{ type: "image", data: junk, mimeType: "image/png" }], "stub");
		expect(result.images).toEqual([]);
		expect(result.text).toBe(mcpText.content.imageUndecodable({ server: "stub", problem: { kind: "unrecognised", claimed: "image/png" }, bytes: 27 }));
	});

	it("renders embedded resources and unknown block types", () => {
		expect(describeContent([{ type: "resource", resource: { text: "body" } }]).text).toBe("body");
		expect(describeContent([{ type: "resource", resource: { uri: "file://x" } }]).text).toBe(mcpText.content.resource("file://x"));
		expect(describeContent([{ type: "audio" }]).text).toBe(mcpText.content.other("audio"));
	});

	it("handles missing content", () => {
		expect(describeContent(undefined)).toEqual({ text: "", images: [] });
	});
});

describe("validateImageData", () => {
	const b64 = (bytes: number[]) => Buffer.from(bytes).toString("base64");
	it("accepts whole png/jpeg/gif/webp images and reports the true mime", () => {
		expect(validateImageData(TINY_PNG, "x")).toEqual({ ok: true, mimeType: "image/png" });
		expect(validateImageData(TINY_JPEG, "x")).toEqual({ ok: true, mimeType: "image/jpeg" });
		expect(validateImageData(TINY_GIF, "x")).toEqual({ ok: true, mimeType: "image/gif" });
		expect(validateImageData(TINY_WEBP, "x")).toEqual({ ok: true, mimeType: "image/webp" });
		// Bytes after a JPEG's end-of-image marker (a vendor trailer, a Motion Photo payload) are allowed.
		const trailed = Buffer.concat([Buffer.from(TINY_JPEG, "base64"), Buffer.from("MotionPhoto_Data")]).toString("base64");
		expect(validateImageData(trailed, "x")).toEqual({ ok: true, mimeType: "image/jpeg" });
	});
	it("rejects a valid signature with a corrupt or truncated body (a poisoned-session shape)", () => {
		const bytes = (value: string) => Buffer.from(value, "base64");
		const withGarbage = Buffer.concat([bytes(TINY_PNG).subarray(0, 8), Buffer.from("ASCII garbage after the signature")]).toString("base64");
		expect(validateImageData(withGarbage, "image/png")).toMatchObject({ ok: false });
		for (const [name, image] of [["png", TINY_PNG], ["jpeg", TINY_JPEG], ["gif", TINY_GIF], ["webp", TINY_WEBP]] as const) {
			const full = bytes(image);
			const truncated = full.subarray(0, full.length - 6).toString("base64");
			expect(validateImageData(truncated, "x"), `${name} truncated`).toMatchObject({ ok: false });
		}
		// A flipped byte inside a PNG chunk fails its checksum.
		const flipped = Buffer.from(bytes(TINY_PNG));
		flipped[45] ^= 0xff;
		expect(validateImageData(flipped.toString("base64"), "x")).toMatchObject({ ok: false, problem: { kind: "png", defect: "checksum" } });
		// The signature-only fixtures the sniff alone used to accept.
		expect(validateImageData(b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "x").ok).toBe(false);
		expect(validateImageData(b64([0xff, 0xd8, 0xff, 0x00]), "x").ok).toBe(false);
		expect(validateImageData(b64([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]), "x").ok).toBe(false);
		expect(validateImageData(Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP")]).toString("base64"), "x").ok).toBe(false);
	});
	it("turns a corrupt image into a text note in describeContent", () => {
		const withGarbage = Buffer.concat([Buffer.from(TINY_PNG, "base64").subarray(0, 8), Buffer.from("garbage")]).toString("base64");
		const result = describeContent([{ type: "image", data: withGarbage, mimeType: "image/png" }], "stub");
		expect(result.images).toEqual([]);
		expect(result.text).toBe(mcpText.content.imageUndecodable({ server: "stub", problem: { kind: "png", defect: "noEnd" }, bytes: 15 }));
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
		expect(capDescription(big)).toBe(mcpText.tool.descriptionCut({ head: big.slice(0, DESCRIPTION_CAP), chars: big.length }));
	});

	it("caps a parameter description inside a converted schema", () => {
		const big = "y".repeat(DESCRIPTION_CAP + 100);
		const schema = jsonSchemaToTypeBox({ type: "object", properties: { q: { type: "string", description: big } } }) as {
			properties: { q: { description: string } };
		};
		expect(schema.properties.q.description).toBe(mcpText.tool.descriptionCut({ head: big.slice(0, DESCRIPTION_CAP), chars: big.length }));
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
		// 4096 base64 characters are 3 KB.
		expect(out).toBe(mcpText.content.binaryResource({ uri: "x://img", mimeType: "image/png", kb: 3 }));
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
		const text = mcpInstructionsReminder([
			{ server: { name: "deepwiki" }, instructions: "Ask questions about repos." },
			{ server: { name: "silent" } },
		]);
		expect(text).toBe(mcpText.instructions([{ name: "deepwiki", text: "Ask questions about repos." }]));
	});

	it("returns undefined when no server has instructions, truncates long ones", async () => {
		expect(mcpInstructionsReminder([{ server: { name: "s" } }])).toBeUndefined();
		const long = mcpInstructionsReminder([{ server: { name: "s" }, instructions: "x".repeat(5000) }]);
		// Instructions are cut at 3,000 characters and the kept head handed to the profile's cut label.
		expect(long).toBe(mcpText.instructions([{ name: "s", text: mcpText.instructionsCut("x".repeat(3000)) }]));
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

