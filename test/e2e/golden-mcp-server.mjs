#!/usr/bin/env node
/**
 * The golden snapshot's MCP server (golden-requests.mjs writes it into the
 * tools scenario's ~/.claude.json; golden-fixture.ts MCP_ROUNDS calls it).
 * Plain newline-delimited JSON-RPC over stdio, no SDK: every reply is fixed,
 * and the two calls that change the connection order their messages so the
 * client has seen the change before the call's result comes back.
 *
 *   echo     text plus structured content
 *   nodesc   no description; a text, an undecodable image, a blob resource
 *            and an audio block
 *   fail     a JSON-RPC error
 *   mutate   drops echo, changes nodesc's schema, adds added; answers after
 *            the client re-listed the tools
 *   quit     exits without answering (the connection closes mid-call)
 *
 * Resources: a text and a binary resource, a URI template, and the
 * non-standard resources/directory/read for golden://dir and golden://empty.
 */

const INSTRUCTIONS = "Use the golden tools for golden checks. Resources live under golden://.";

let tools = [
	{ name: "echo", description: "Echo the text back.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
	{ name: "nodesc", inputSchema: { type: "object", properties: {} } },
	{ name: "fail", description: "Always fails.", inputSchema: { type: "object", properties: {} } },
	{ name: "mutate", description: "Change the tool list.", inputSchema: { type: "object", properties: {} } },
	{ name: "quit", description: "Stop the server.", inputSchema: { type: "object", properties: {} } },
];

const RESOURCES = [
	{ uri: "golden://notes", name: "Notes", description: "The golden notes", mimeType: "text/plain" },
	{ uri: "golden://logo", name: "Logo", mimeType: "image/png" },
];
const TEMPLATES = [{ uriTemplate: "golden://items/{id}", name: "Item", description: "One golden item" }];
const CONTENTS = {
	"golden://notes": [{ uri: "golden://notes", mimeType: "text/plain", text: "Golden notes." }],
	"golden://logo": [{ uri: "golden://logo", mimeType: "image/png", blob: "AAAAAAAA" }],
};
const DIRECTORIES = {
	"golden://dir": [
		{ uri: "golden://dir/a.txt", name: "a.txt", mimeType: "text/plain" },
		{ uri: "golden://dir/sub", name: "sub", mimeType: "inode/directory" },
	],
	"golden://empty": [],
};

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const reply = (id, result) => send({ id, result });
const fail = (id, code, message) => send({ id, error: { code, message } });

/** Run once the client asks for the tool list again (mutate's ordering). */
let onToolsListed;

function callTool(id, name, args) {
	switch (name) {
		case "echo":
			return reply(id, { content: [{ type: "text", text: `echo: ${args.text}` }], structuredContent: { echoed: args.text } });
		case "nodesc":
			return reply(id, {
				content: [
					{ type: "text", text: "Mixed content." },
					{ type: "image", data: "AAAAAAAA", mimeType: "image/png" },
					{ type: "resource", resource: { uri: "golden://logo", mimeType: "image/png", blob: "AAAAAAAA" } },
					{ type: "audio", data: "AAAA", mimeType: "audio/wav" },
				],
			});
		case "fail":
			return fail(id, -32603, "golden failure");
		case "mutate":
			tools = [
				{ name: "nodesc", inputSchema: { type: "object", properties: { mode: { type: "string" } } } },
				...tools.filter((tool) => tool.name !== "echo" && tool.name !== "nodesc"),
				{ name: "added", description: "Added by mutate.", inputSchema: { type: "object", properties: {} } },
			];
			// The client handles the re-listed tools before this call's result arrives.
			onToolsListed = () => setTimeout(() => reply(id, { content: [{ type: "text", text: "Tool list changed." }] }), 300);
			return send({ method: "notifications/tools/list_changed" });
		case "quit":
			return process.exit(0);
		default:
			return fail(id, -32602, `Unknown tool: ${name}`);
	}
}

function handle(message) {
	const { id, method, params = {} } = message;
	if (id === undefined) return; // a notification
	switch (method) {
		case "initialize":
			return reply(id, {
				protocolVersion: params.protocolVersion,
				capabilities: { tools: { listChanged: true }, resources: {} },
				serverInfo: { name: "golden", version: "1.0.0" },
				instructions: INSTRUCTIONS,
			});
		case "ping":
			return reply(id, {});
		case "tools/list": {
			reply(id, { tools });
			const listed = onToolsListed;
			onToolsListed = undefined;
			return listed?.();
		}
		case "tools/call":
			return callTool(id, params.name, params.arguments ?? {});
		case "resources/list":
			return reply(id, { resources: RESOURCES });
		case "resources/templates/list":
			return reply(id, { resourceTemplates: TEMPLATES });
		case "resources/read":
			return CONTENTS[params.uri] ? reply(id, { contents: CONTENTS[params.uri] }) : fail(id, -32002, `Resource not found: ${params.uri}`);
		case "resources/directory/read":
			return DIRECTORIES[params.uri] ? reply(id, { resources: DIRECTORIES[params.uri] }) : fail(id, -32002, `Not a directory: ${params.uri}`);
		default:
			return fail(id, -32601, "Method not found");
	}
}

let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffered += chunk;
	let newline;
	while ((newline = buffered.indexOf("\n")) >= 0) {
		const line = buffered.slice(0, newline).trim();
		buffered = buffered.slice(newline + 1);
		if (line) handle(JSON.parse(line));
	}
});
