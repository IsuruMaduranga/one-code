#!/usr/bin/env node
/**
 * E2E: Claude Code-compatible hooks, without --dangerously-skip-permissions.
 *
 * A fixture project's .claude/settings.json defines a PreToolUse hook on Bash
 * that writes a marker file and blocks with exit 2. Two runs:
 *
 *   Run 1 — trust confirm answered YES: the hook executes (marker exists),
 *   the bash call is blocked with the hook's stderr as reason, and NO
 *   permission prompt appears for it (the hook short-circuits before the
 *   permission gate).
 *
 *   Run 2 — trust confirm answered NO: the hook never executes (no marker),
 *   and the bash call flows to the ordinary permission prompt instead.
 *
 * Usage: node rpc-hooks-test.mjs [scratch-dir]
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = process.argv[2] ?? mkdtempSync(join(tmpdir(), "cc-hooks-e2e-"));

const REASON = "blocked-by-e2e-hook";

function makeProject(name) {
	const dir = join(scratch, name);
	mkdirSync(join(dir, ".claude"), { recursive: true });
	const marker = join(dir, "hook-ran.marker");
	writeFileSync(
		join(dir, ".claude", "settings.json"),
		JSON.stringify({
			hooks: {
				PreToolUse: [
					{
						matcher: "Bash",
						hooks: [{ type: "command", command: `touch ${marker}; echo ${REASON} >&2; exit 2` }],
					},
				],
			},
		}),
	);
	return { dir, marker };
}

function runScenario({ name, workdir, approve, stateDir }) {
	return new Promise((resolve) => {
		const child = spawn("pi", ["--mode", "rpc", "--no-session"], {
			cwd: workdir,
			stdio: ["pipe", "pipe", "inherit"],
			env: { ...process.env, PINCER_STATE_DIR: stateDir },
		});
		const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);

		const state = { confirms: 0, permissionPrompts: 0, sawReason: false };
		let buffer = "";
		const timeout = setTimeout(() => {
			console.error(`${name}: TIMEOUT`);
			child.kill();
			resolve({ ...state, timedOut: true });
		}, 180_000);

		child.stdout.on("data", (chunk) => {
			buffer += chunk.toString();
			let idx;
			while ((idx = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 1);
				if (!line.trim()) continue;
				if (line.includes(REASON)) state.sawReason = true;
				let event;
				try {
					event = JSON.parse(line);
				} catch {
					continue;
				}
				if (event.type === "extension_ui_request" && event.method === "confirm") {
					state.confirms += 1;
					send({ type: "extension_ui_response", id: event.id, confirmed: approve });
				} else if (event.type === "extension_ui_request" && event.method === "select") {
					state.permissionPrompts += 1;
					// Approve the harmless echo; we only care that the gate asked.
					send({ type: "extension_ui_response", id: event.id, value: "Yes" });
				} else if (event.type === "agent_end") {
					clearTimeout(timeout);
					child.kill();
					resolve(state);
				}
			}
		});

		send({
			id: "req-1",
			type: "prompt",
			message: "Use the bash tool to run exactly: echo hello. If the call is blocked or rejected, do not retry it in any form; reply exactly: DONE",
		});
	});
}

let ok = true;
const check = (name, passed, detail = "") => {
	console.log(`${passed ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!passed) ok = false;
};

// Run 1: approve the project hooks.
{
	const { dir, marker } = makeProject("approved");
	const state = await runScenario({ name: "approved", workdir: dir, approve: true, stateDir: join(scratch, "state-1") });
	check("run1: trust confirm shown", state.confirms === 1, `${state.confirms} confirm(s)`);
	check("run1: hook executed", existsSync(marker));
	check("run1: block reason from hook stderr visible", state.sawReason);
	check("run1: no permission prompt for the blocked call", state.permissionPrompts === 0, `${state.permissionPrompts}`);
}

// Run 2: decline the project hooks.
{
	const { dir, marker } = makeProject("declined");
	const state = await runScenario({ name: "declined", workdir: dir, approve: false, stateDir: join(scratch, "state-2") });
	check("run2: trust confirm shown", state.confirms === 1, `${state.confirms} confirm(s)`);
	check("run2: hook never executed", !existsSync(marker));
	check("run2: call flowed to the normal permission gate", state.permissionPrompts >= 1, `${state.permissionPrompts}`);
}

process.exit(ok ? 0 : 2);
