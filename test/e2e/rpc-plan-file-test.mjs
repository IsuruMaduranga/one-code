#!/usr/bin/env node
/**
 * E2E: plan mode's file carve-out, without --dangerously-skip-permissions.
 *
 * Drives pi in RPC mode: the model enters plan mode, attempts a normal write
 * (must be blocked, with no permission prompt — plan mode denies, it doesn't
 * ask), then writes its plan file (must succeed, also with no prompt).
 *
 * Usage: node rpc-plan-file-test.mjs <workdir>
 * Prints PASS/FAIL lines; exits 0 only if all assertions hold. Cleans up the
 * plan file it caused to be created.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const workdir = process.argv[2] ?? process.cwd();
const MARKER = "E2E plan marker 7431";

const child = spawn("pi", ["--mode", "rpc", "--no-session"], {
	cwd: workdir,
	stdio: ["pipe", "pipe", "inherit"],
});

const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);

let prompts = 0;
let planFilePath;
let buffer = "";

const timeout = setTimeout(() => {
	console.error("TIMEOUT");
	child.kill();
	process.exit(1);
}, 180_000);

const finish = () => {
	clearTimeout(timeout);
	child.kill();

	let ok = true;
	const check = (name, passed, detail = "") => {
		console.log(`${passed ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
		if (!passed) ok = false;
	};

	check("no permission prompts in plan mode", prompts === 0, `${prompts} prompt(s)`);
	check("blocked write did not land", !existsSync(join(workdir, "blocked.txt")));
	check("plan file path announced", Boolean(planFilePath), planFilePath ?? "not seen in event stream");
	if (planFilePath) {
		const written = existsSync(planFilePath);
		check("plan file written", written, planFilePath);
		if (written) {
			check("plan file has the model's content", readFileSync(planFilePath, "utf8").includes(MARKER));
			rmSync(planFilePath);
		}
	}
	process.exit(ok ? 0 : 2);
};

child.stdout.on("data", (chunk) => {
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

		// Any UI request is a failure: plan mode must deny or allow, never ask.
		if (event.type === "extension_ui_request" && (event.method === "select" || event.method === "confirm")) {
			prompts += 1;
			console.log(`UNEXPECTED_PROMPT: ${String(event.title).split("\n")[0]}`);
			send({ type: "extension_ui_response", id: event.id, value: undefined });
		}

		const match = line.match(/[/\\][^"\\ ]*\.pincer[/\\]plans[/\\][a-z]+-[a-z]+-[a-z]+\.md/);
		if (match && !planFilePath) planFilePath = match[0];

		if (event.type === "agent_end") finish();
	}
});

send({
	id: "req-1",
	type: "prompt",
	message: [
		"Call enter_plan_mode. Then, as a deliberate test, try to write a file named blocked.txt with content 'x' in the current directory and expect that call to be blocked — do not retry it.",
		`Then use the write tool to write exactly '# ${MARKER}' to your plan file (the path enter_plan_mode told you).`,
		"Do NOT call exit_plan_mode. Reply exactly: DONE",
	].join(" "),
});
