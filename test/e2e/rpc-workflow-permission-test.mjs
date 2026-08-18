#!/usr/bin/env node
/**
 * E2E: a WORKFLOW agent's permission prompt bubbles to the main session — the
 * workflow runner threads the same parent permission bridge the subagent
 * runner uses (before this, workflow agents hit the fail-closed local gate and
 * every bash call in a gated session was denied). Drives a `--mode rpc` main
 * session in DEFAULT (manual) permission mode, asks the model to run a
 * one-agent sync workflow whose agent runs a bash command, and asserts:
 *
 *   - a permission prompt (`extension_ui_request` / select) appears on the
 *     MAIN session's stream — the workflow child's gate routed through the
 *     parent's real pipeline;
 *   - answering "Yes" lets the child's command run (marker appears).
 *
 * Real model calls — run manually.
 *
 * Usage: node rpc-workflow-permission-test.mjs [scratch-dir]
 * Env:   MODEL (default anthropic/claude-haiku-4-5)
 */

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = process.argv[2] ?? mkdtempSync(join(tmpdir(), "cc-wfperm-e2e-"));
const MODEL = process.env.MODEL ?? "anthropic/claude-haiku-4-5";
const workdir = join(scratch, "work");
const sessionDir = join(scratch, "sessions");
mkdirSync(workdir, { recursive: true });
mkdirSync(sessionDir, { recursive: true });
execFileSync("git", ["init", "-q"], { cwd: workdir });
execFileSync("git", ["config", "user.email", "e@x.com"], { cwd: workdir });
execFileSync("git", ["config", "user.name", "e"], { cwd: workdir });

// DEFAULT (manual) permission mode — NOT auto, NOT skip-permissions.
const child = spawn("pi", ["--mode", "rpc", "--session-dir", sessionDir, "--model", MODEL], {
	cwd: workdir,
	stdio: ["pipe", "pipe", "inherit"],
});
const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);

let buffer = "";
let raw = "";
let sawPrompt = false;
let promptTitle = "";
let answered = false;

const timeout = setTimeout(() => {
	console.error("TIMEOUT");
	try { child.kill(); } catch {}
	process.exit(1);
}, 240_000);

child.stdout.on("data", (chunk) => {
	raw += chunk.toString();
	buffer += chunk.toString();
	let idx;
	while ((idx = buffer.indexOf("\n")) !== -1) {
		const line = buffer.slice(0, idx);
		buffer = buffer.slice(idx + 1);
		if (!line.trim()) continue;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (event.type === "extension_ui_request" && event.method === "select") {
			const title = String(event.title ?? "");
			// The workflow child's bash prompt — approve it so the command runs.
			if (/subagent|bash/i.test(title)) {
				sawPrompt = true;
				promptTitle = title.split("\n")[0];
			}
			send({ type: "extension_ui_response", id: event.id, value: "Yes" });
			answered = true;
		} else if (event.type === "extension_ui_request") {
			// Any other UI request (e.g. input) — answer to not hang.
			send({ type: "extension_ui_response", id: event.id, value: "Yes", confirmed: true });
		} else if (event.type === "agent_end") {
			finish();
		}
	}
});

let done = false;
function finish() {
	if (done) return;
	done = true;
	clearTimeout(timeout);
	const markerRan = raw.includes("WORKFLOW_BASH_RAN");
	const ok = sawPrompt && answered && markerRan;
	console.log(`${sawPrompt ? "PASS" : "FAIL"} workflow-agent permission prompt bubbled to main session${promptTitle ? ` — "${promptTitle}"` : ""}`);
	console.log(`${answered ? "PASS" : "FAIL"} prompt was answerable over rpc`);
	console.log(`${markerRan ? "PASS" : "FAIL"} approved workflow-agent command ran (marker ${markerRan ? "seen" : "not seen"})`);
	console.log(`\n${ok ? "ALL PASS" : "FAILED"}`);
	console.log(`scratch: ${scratch}`);
	try { child.kill(); } catch {}
	process.exit(ok ? 0 : 2);
}

const script = [
	"export const meta = { name: 'perm-probe', description: 'one agent runs a marker command', phases: [{ title: 'Probe' }] }",
	"phase('Probe')",
	"const out = await agent('Run exactly this bash command: echo WORKFLOW_BASH_RAN — then report its raw output as your final message.')",
	"return { out }",
].join("\n");

send({
	id: "req-1",
	type: "prompt",
	message:
		"Run a workflow. Call the workflow tool with sync: true and exactly this script (verbatim, do not edit it):\n\n" +
		"```js\n" + script + "\n```\n\n" +
		"Do not run any command yourself. When the workflow finishes, tell me the result verbatim.",
});
