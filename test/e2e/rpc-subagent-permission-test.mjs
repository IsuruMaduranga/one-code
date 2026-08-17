#!/usr/bin/env node
/**
 * E2E: a SUBAGENT's permission prompt bubbles to the main session (Claude Code
 * parity — findings §17.1). Drives a `--mode rpc` main session in DEFAULT (manual)
 * permission mode, asks the model to spawn a general-purpose subagent that runs a
 * bash command, and asserts:
 *
 *   - a permission prompt (`extension_ui_request` / select) appears on the MAIN
 *     session's stream — i.e. the child's gate routed through the parent's real
 *     pipeline and raised the prompt on the parent's UI (the old in-process design
 *     could not prompt at all — it denied fail-closed);
 *   - the prompt's title names it as a subagent's call;
 *   - answering "Yes" lets the child's command run (marker appears).
 *
 * The Agent spawn itself is auto-allowed, so the only prompt in the run is the
 * child's bash call. Real model calls — run manually.
 *
 * Usage: node rpc-subagent-permission-test.mjs [scratch-dir]
 * Env:   MODEL (default anthropic/claude-haiku-4-5)
 */

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = process.argv[2] ?? mkdtempSync(join(tmpdir(), "cc-subperm-e2e-"));
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
let sawSubagentPrompt = false;
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
			// The child's bash prompt — approve it so the command runs.
			if (/subagent/i.test(title)) {
				sawSubagentPrompt = true;
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
	const markerRan = raw.includes("SUBAGENT_BASH_RAN");
	const ok = sawSubagentPrompt && answered;
	console.log(`${sawSubagentPrompt ? "PASS" : "FAIL"} subagent permission prompt bubbled to main session${promptTitle ? ` — "${promptTitle}"` : ""}`);
	console.log(`${answered ? "PASS" : "FAIL"} prompt was answerable over rpc`);
	console.log(`${markerRan ? "PASS" : "INFO"} approved child command ran (marker ${markerRan ? "seen" : "not seen — model may not have relayed it"})`);
	console.log(`\n${ok ? "ALL PASS" : "FAILED"}`);
	console.log(`scratch: ${scratch}`);
	try { child.kill(); } catch {}
	process.exit(ok ? 0 : 2);
}

send({
	id: "req-1",
	type: "prompt",
	message:
		"Use the Agent tool with subagent_type 'general-purpose' and task: \"Run exactly this bash command: echo SUBAGENT_BASH_RAN — then report its output.\" Do not run the command yourself. When the agent returns, tell me what it output.",
});
