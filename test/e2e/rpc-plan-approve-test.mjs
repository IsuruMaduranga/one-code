#!/usr/bin/env node
/**
 * E2E: exit_plan_mode's approval reaches an RPC client and approving it works.
 *
 * Usage: node rpc-plan-approve-test.mjs [model]
 *
 * Starts in plan mode, asks for a one-step plan, and answers the plan's select
 * request with its first "Approve" choice. Prints PLAN_SEEN with the choices,
 * TOOL_RESULT with exit_plan_mode's text, then the final reply. Exits 0 when
 * the plan was approved, 2 when it was not (RPC's custom() gap rejected every
 * plan as dismissed).
 */

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const model = process.argv[2];
const workdir = mkdtempSync(join(tmpdir(), "rpc-plan-"));
const child = spawn("pi", ["--mode", "rpc", "--permission-mode", "plan", "--no-session", ...(model ? ["--model", model] : [])], {
	cwd: workdir,
	stdio: ["pipe", "pipe", "inherit"],
});
const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);

let approved;
const timeout = setTimeout(() => {
	console.error("TIMEOUT");
	child.kill();
	process.exit(1);
}, 240_000);

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
			const approve = String(event.title).startsWith("Plan (") ? (event.options ?? []).find((option) => String(option).startsWith("Approve")) : undefined;
			console.log(`${approve ? "PLAN_SEEN" : "SELECT_SEEN"}: ${String(event.title).split("\n")[0]} | ${JSON.stringify(event.options)}`);
			send(approve ? { type: "extension_ui_response", id: event.id, value: approve } : { type: "extension_ui_response", id: event.id, cancelled: true });
		} else if (event.type === "extension_ui_request" && (event.method === "input" || event.method === "confirm")) {
			send({ type: "extension_ui_response", id: event.id, cancelled: true });
		} else if (event.type === "tool_execution_end" && event.toolName === "exit_plan_mode") {
			const text = (event.result?.content ?? []).map((part) => part.text ?? "").join("");
			approved = event.result?.details?.approved === true;
			console.log(`TOOL_RESULT approved=${approved}: ${text.slice(0, 200)}`);
		} else if (event.type === "agent_end") {
			const last = [...(event.messages ?? [])].reverse().find((message) => message.role === "assistant");
			console.log(`FINAL: ${(last?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("").slice(0, 200)}`);
			clearTimeout(timeout);
			child.kill();
			process.exit(approved ? 0 : 2);
		}
	}
});

send({
	id: "req-1",
	type: "prompt",
	message:
		"Plan this task: create hello.txt containing the word hi. Write a one-step plan to the plan file, then call exit_plan_mode to ask for approval. After approval, reply APPROVED and stop without doing the task.",
});
