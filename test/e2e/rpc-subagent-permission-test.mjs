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
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = process.argv[2] ?? mkdtempSync(join(tmpdir(), "cc-subperm-e2e-"));
const MODEL = process.env.MODEL ?? "anthropic/claude-haiku-4-5";
const workdir = join(scratch, "work");
const sessionDir = join(scratch, "sessions");
// The child's command creates this file; the stream is no evidence, since the prompt echoes it.
const marker = join(workdir, "subagent-ran.txt");
mkdirSync(workdir, { recursive: true });
rmSync(marker, { force: true }); // a reused scratch dir must not pass on an old run's marker
mkdirSync(sessionDir, { recursive: true });
execFileSync("git", ["init", "-q"], { cwd: workdir });
execFileSync("git", ["config", "user.email", "e@x.com"], { cwd: workdir });
execFileSync("git", ["config", "user.name", "e"], { cwd: workdir });

// DEFAULT (manual) permission mode — NOT auto, NOT skip-permissions.
const child = spawn("pi", ["--mode", "rpc", "--permission-mode", "default", "--session-dir", sessionDir, "--model", MODEL], {
	cwd: workdir,
	stdio: ["pipe", "pipe", "inherit"],
});
const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);

let buffer = "";
let sawSubagentPrompt = false;
let promptTitle = "";
let answered = false;
let sawCompletion = false;

const timeout = setTimeout(() => {
	console.error("TIMEOUT");
	finish(true);
}, 240_000);

child.stdout.on("data", (chunk) => {
	buffer += chunk.toString();
	let idx;
	while ((idx = buffer.indexOf("\n")) !== -1) {
		const line = buffer.slice(0, idx);
		buffer = buffer.slice(idx + 1);
		if (!line.trim()) continue;
		// The prompt never contains this tag, so only the harness's frame can match.
		if (line.includes("<task-notification>")) sawCompletion = true;
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
			// Agent runs in the background in rpc mode: the first agent_end is the
			// main turn handing off, before the child has called bash. Finish on the
			// turn its completion notification starts.
			if (sawCompletion) finish();
		}
	}
});

let done = false;
function finish(timedOut = false) {
	if (done) return;
	done = true;
	clearTimeout(timeout);
	const markerRan = existsSync(marker);
	const ok = !timedOut && sawSubagentPrompt && answered && markerRan;
	console.log(`${sawSubagentPrompt ? "PASS" : "FAIL"} subagent permission prompt bubbled to main session${promptTitle ? ` — "${promptTitle}"` : ""}`);
	console.log(`${answered ? "PASS" : "FAIL"} prompt was answerable over rpc`);
	console.log(`${markerRan ? "PASS" : "FAIL"} approved child command ran (marker file ${markerRan ? "created" : "missing"})`);
	console.log(`\n${ok ? "ALL PASS" : "FAILED"}`);
	console.log(`scratch: ${scratch}`);
	try { child.kill(); } catch {}
	process.exit(timedOut ? 1 : ok ? 0 : 2);
}

send({
	id: "req-1",
	type: "prompt",
	message:
		"Use the Agent tool with subagent_type 'general-purpose' and task: \"Run exactly this bash command: touch subagent-ran.txt — then report that it ran.\" Do not run the command yourself. When the agent returns, tell me what it output.",
});
