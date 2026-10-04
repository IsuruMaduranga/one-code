#!/usr/bin/env node
/**
 * Live RPC proof for external instruction consent, using this checkout's extensions.
 * Run with TMPDIR pointing outside the checkout; fixtures and request dumps stay there.
 *   node test/e2e/rpc-external-includes-test.mjs [anthropic/claude-haiku-4-5]
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const model = process.argv[2] ?? "anthropic/claude-haiku-4-5";
const root = mkdtempSync(join(tmpdir(), "rpc-external-includes-"));
const marker = "EXTERNAL_IMPORT_PROOF_COBALT_7391";
console.log(`EVIDENCE: ${root}`);

async function run(approved) {
	const dir = join(root, approved ? "yes" : "no");
	const cwd = join(dir, "project");
	mkdirSync(cwd, { recursive: true });
	writeFileSync(join(cwd, "CLAUDE.md"), "Project instructions.\n@../shared.md\n");
	writeFileSync(join(dir, "shared.md"), `The external instruction marker is ${marker}.\n`);
	const wire = join(dir, "wire.jsonl");
	const extensions = ["extensions/system-reminder/index.ts", "extensions/claude-context/index.ts", "test/e2e/dump-requests.ts"];
	const child = spawn("perl", ["-e", "alarm 180; exec @ARGV", "pi", "--no-extensions", ...extensions.flatMap((path) => ["-e", join(repo, path)]), "--mode", "rpc", "--no-session", "--no-tools", "--model", model, "--thinking", "off"], {
		cwd,
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, WIRE_DUMP: wire, CLAUDE_CONFIG_DIR: join(dir, "claude-config"), ONECODE_STATE_DIR: join(dir, "state"), ONECODE_CONFIG_MODE: "claude-compatible" },
	});
	const send = (data) => child.stdin.write(`${JSON.stringify(data)}\n`);
	let buffer = "", output = "", stderr = "", seen = 0;
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	return await new Promise((resolveRun, reject) => {
		let finished = false;
		const finish = (error) => {
			if (finished) return;
			finished = true;
			clearTimeout(timeout);
			child.kill();
			writeFileSync(join(dir, "events.jsonl"), output);
			writeFileSync(join(dir, "stderr.log"), stderr);
			if (error) reject(error); else resolveRun();
		};
		const timeout = setTimeout(() => finish(new Error("RPC approval timed out")), 185_000);
		child.on("error", finish);
		child.on("exit", (code, signal) => { if (!finished) finish(new Error(`pi exited ${code}/${signal}: ${stderr}`)); });
		child.stdout.on("data", (chunk) => {
			output += chunk;
			buffer += chunk;
			let at;
			while ((at = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, at);
				buffer = buffer.slice(at + 1);
				let event;
				try { event = JSON.parse(line); } catch { continue; }
				if (event.type === "extension_ui_request" && event.method === "select") {
					if (!event.title.startsWith("Allow external CLAUDE.md file imports?")) { finish(new Error(`Unexpected dialog: ${event.title}`)); return; }
					seen++;
					const value = approved ? "Yes, allow external imports" : "No, disable external imports";
					console.log(`DIALOG ${approved ? "yes" : "no"}: ${event.title} | ${JSON.stringify(event.options)}`);
					send({ type: "extension_ui_response", id: event.id, value });
				} else if (event.type === "extension_error") {
					finish(new Error(JSON.stringify(event))); return;
				} else if (event.type === "agent_end") {
					try {
						const requests = readFileSync(wire, "utf8").trim().split("\n").map(JSON.parse);
						const included = JSON.stringify(requests).includes(marker);
						const last = [...(event.messages ?? [])].reverse().find((message) => message.role === "assistant");
						if (last?.stopReason === "error") throw new Error(`Model error: ${last.errorMessage}`);
						if (seen !== 1 || included !== approved) throw new Error(`Expected one dialog and included=${approved}; got ${seen}/${included}`);
						const reply = (last?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("").trim();
						if (reply.includes(marker) !== approved) throw new Error(`Unexpected model reply: ${reply}`);
						console.log(`PASS ${approved ? "yes" : "no"}: dialogs=${seen}, request_contains_external_marker=${included}, response=${JSON.stringify(last?.content)}`);
						finish();
					} catch (error) { finish(error); }
				}
			}
		});
		send({ id: "first", type: "prompt", message: "Do not use tools. Reply with the token following the exact sentence 'The external instruction marker is' in loaded instruction text. If that sentence is absent from the instruction text, reply NONE. A file reference is not a marker." });
	});
}

try {
	await run(true);
	await run(false);
} catch (error) {
	console.error(error);
	process.exitCode = 1;
}
