#!/usr/bin/env node
/**
 * Keyless smoke for one pi version: load this checkout as a pi package on the
 * given pi CLI and run one real turn against a local mock model, so a pi in
 * the tested range (extensions/lib/pi-version.ts) is shown to load the whole
 * extension set, start a session and run a tool. The mock speaks the OpenAI
 * chat-completions stream: its first reply calls the bash tool with a marker
 * command, its second answers with a done marker once the tool result is back.
 * No network, no provider key. CI runs it against TESTED_PI_MIN.
 *
 *   node test/e2e/pi-floor-smoke.mjs <path to pi's dist/cli.js> [--timeout <seconds>]
 *
 * Exit 0 when the tool ran and the turn finished; otherwise the events and
 * stderr are left in the work dir and its path is printed. From a sandboxed
 * assistant shell run this inside tmux (findings §10).
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const cli = args[0] && !args[0].startsWith("--") ? resolve(args[0]) : undefined;
const timeoutIndex = args.indexOf("--timeout");
const timeoutMs = Number(timeoutIndex === -1 ? "180" : args[timeoutIndex + 1]) * 1000;
if (!cli) {
	console.error("usage: node test/e2e/pi-floor-smoke.mjs <path to pi's dist/cli.js> [--timeout <seconds>]");
	process.exit(2);
}
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const piVersion = JSON.parse(readFileSync(join(dirname(dirname(cli)), "package.json"), "utf8")).version;

const TOOL_MARKER = "PI_FLOOR_TOOL_RAN";
const DONE_MARKER = "PI_FLOOR_DONE";

// --- the mock model ---------------------------------------------------------
const requests = [];
const server = createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => (body += chunk));
	req.on("end", () => {
		let request = {};
		try {
			request = JSON.parse(body);
		} catch {}
		const messages = request.messages ?? [];
		const last = messages[messages.length - 1] ?? {};
		const tools = (request.tools ?? []).map((tool) => tool.function?.name);
		requests.push({ last: last.role, tools: tools.length });
		res.writeHead(200, { "content-type": "text/event-stream" });
		const send = (payload) => res.write(`data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model: request.model, ...payload })}\n\n`);
		const delta = (d, finish = null) => send({ choices: [{ index: 0, delta: d, finish_reason: finish }] });
		if (last.role === "tool" || !tools.includes("bash")) {
			delta({ role: "assistant", content: DONE_MARKER });
			delta({}, "stop");
		} else {
			const call = { command: `echo ${TOOL_MARKER}`, description: "Print the smoke marker" };
			delta({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: JSON.stringify(call) } }] });
			delta({}, "tool_calls");
		}
		send({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
		res.end("data: [DONE]\n\n");
	});
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const port = server.address().port;

// --- an isolated pi with this checkout as its one package -------------------
const work = mkdtempSync(join(tmpdir(), "pi-floor-"));
const home = join(work, "home");
const agentDir = join(home, "agent");
const project = join(work, "project");
mkdirSync(agentDir, { recursive: true });
mkdirSync(project, { recursive: true });
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [repo], quietStartup: true }));
const mockModel = { id: "mock-1", name: "Mock", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({ providers: { mock: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "mock-key", models: [mockModel] } } }),
);

const env = { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir };
const child = spawn(
	process.execPath,
	[cli, "--provider", "mock", "--model", "mock-1", "--mode", "json", "--dangerously-skip-permissions", "-p", "Run the smoke marker command."],
	{ cwd: project, env, stdio: ["ignore", "pipe", "pipe"] },
);
let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => (stdout += chunk));
child.stderr.on("data", (chunk) => (stderr += chunk));
const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
const code = await new Promise((done) => child.on("close", done));
clearTimeout(timer);
server.close();
writeFileSync(join(work, "events.jsonl"), stdout);
writeFileSync(join(work, "stderr.txt"), stderr);

// --- verdict ----------------------------------------------------------------
const events = stdout
	.split("\n")
	.filter(Boolean)
	.map((line) => {
		try {
			return JSON.parse(line);
		} catch {
			return undefined;
		}
	})
	.filter(Boolean);
const toolEnd = events.find((event) => event.type === "tool_execution_end" && event.toolName === "bash");
const toolText = JSON.stringify(toolEnd?.result ?? "");
const failures = [];
if (code !== 0) failures.push(`pi exited ${code}`);
if (/Failed to load extension/.test(stderr)) failures.push("an extension failed to load");
if (!toolText.includes(TOOL_MARKER)) failures.push("the bash tool result lacks the marker");
if (!stdout.includes(DONE_MARKER)) failures.push("the turn did not reach the final answer");
if (requests.length < 2) failures.push(`the model saw ${requests.length} request(s), expected 2`);

if (failures.length > 0) {
	console.error(`pi ${piVersion}: FAIL (${failures.join("; ")})`);
	console.error(stderr.split("\n").slice(-15).join("\n"));
	console.error(`work dir: ${work}`);
	process.exit(1);
}
console.log(`pi ${piVersion}: loaded the extension set and ran a bash tool turn (${requests.length} model requests)`);
