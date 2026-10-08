#!/usr/bin/env node
/**
 * E2E: ask_user_question reaches an RPC client and its answer reaches the model.
 *
 * Usage: node rpc-ask-user-test.mjs [model] [-- extra pi args…]
 *   model: defaults to pi's configured model.
 *   extra pi args: e.g. `-- --no-extensions -e ./extensions/ask-user/index.ts`
 *   to test one extension in isolation.
 *
 * The model is asked to put a two-option question with ask_user_question; the
 * client answers the select request with "Blue". Prints QUESTION_SEEN with the
 * dialog's title and rows, TOOL_RESULT with the tool's text, then the final
 * reply. Exits 0 when the tool result carries the answer, 2 when it does not
 * (the RPC widget gap reported "The user cancelled without answering.").
 */

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const dash = process.argv.indexOf("--");
const model = dash === 2 ? undefined : process.argv[2];
// -e paths resolve against this shell's cwd, not the temp dir pi runs in.
const extra = (dash === -1 ? [] : process.argv.slice(dash + 1)).map((arg, i, all) => (all[i - 1] === "-e" && !isAbsolute(arg) && !arg.startsWith("builtin:") ? resolve(arg) : arg));
// --permission-mode is One Code's flag; pi rejects it when extensions are off.
const modeFlag = extra.includes("--no-extensions") || extra.includes("-ne") ? [] : ["--permission-mode", "auto"];
const workdir = mkdtempSync(join(tmpdir(), "rpc-ask-user-"));

const child = spawn("pi", ["--mode", "rpc", ...modeFlag, "--no-session", ...(model ? ["--model", model] : []), ...extra], {
	cwd: workdir,
	stdio: ["pipe", "pipe", "inherit"],
});
const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);

let toolResult;
const timeout = setTimeout(() => {
	console.error("TIMEOUT");
	child.kill();
	process.exit(1);
}, 180_000);

let buffer = "";
child.stdout.on("data", (chunk) => {
	buffer += chunk.toString();
	let idx;
	while ((idx = buffer.indexOf("\n")) !== -1) {
		const line = buffer.slice(0, idx);
		buffer = buffer.slice(idx + 1);
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (event.type === "extension_ui_request" && event.method === "select") {
			console.log(`QUESTION_SEEN: ${event.title} | ${JSON.stringify(event.options)}`);
			const blue = (event.options ?? []).find((option) => String(option).startsWith("Blue"));
			send(blue ? { type: "extension_ui_response", id: event.id, value: blue } : { type: "extension_ui_response", id: event.id, cancelled: true });
		} else if (event.type === "extension_ui_request" && event.method === "input") {
			send({ type: "extension_ui_response", id: event.id, cancelled: true });
		} else if (event.type === "tool_execution_end" && event.toolName === "ask_user_question") {
			toolResult = (event.result?.content ?? []).map((part) => part.text ?? "").join("");
			console.log(`TOOL_RESULT: ${toolResult}`);
		} else if (event.type === "agent_end") {
			const last = [...(event.messages ?? [])].reverse().find((message) => message.role === "assistant");
			const text = (last?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("");
			console.log(`FINAL: ${text}`);
			clearTimeout(timeout);
			child.kill();
			process.exit(toolResult?.includes('="Blue"') ? 0 : 2);
		}
	}
});

send({
	id: "req-1",
	type: "prompt",
	message:
		'Use the ask_user_question tool once to ask me "Which color do you prefer?" with header "Color" and exactly two options, "Red" and "Blue". After it returns, reply with only the color I picked, or "NONE" if I did not pick one.',
});
