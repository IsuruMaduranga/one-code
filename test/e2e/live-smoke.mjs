#!/usr/bin/env node
/**
 * Live smoke: run One Code once against a real model on a throwaway project
 * and check that the model drove the requested shell tool end to end — the
 * bash tool (Git Bash on Windows) or the PowerShell tool
 * (`CLAUDE_CODE_USE_POWERSHELL_TOOL=1`) — and that the shell's own output came
 * back in the tool result. A second command, which a project deny rule
 * covers, must come back denied with its target file untouched: both of the
 * permission gate's outcomes, in the default mode, with no
 * `--dangerously-skip-permissions`. The one check the unit suite cannot make:
 * the shell spawn, the permission gate and the provider round trip together,
 * on the machine that runs it. `.github/workflows/live-smoke.yml` runs both
 * shells on windows-latest (working-docs/features/windows/plan.md, Phase 3 item 7).
 *
 *   node test/e2e/live-smoke.mjs --shell bash|powershell [--model <provider/model>] [--timeout <seconds>]
 *
 * The provider key comes from the environment (OPENROUTER_API_KEY, …); when
 * none is set and the real pi agent dir has an auth.json, that is copied into
 * the isolated agent dir the run uses (a local convenience; CI has no such
 * file). Exit 0 on success; on failure the events and stderr are left in the
 * work dir and its path is printed. From a sandboxed assistant shell run this
 * inside tmux (findings §10).
 */
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? fallback : args[i + 1];
};
const shell = flag("shell", "bash");
const model = flag("model", "openrouter/deepseek/deepseek-v4.1-flash");
const timeoutMs = Number(flag("timeout", "240")) * 1000;
if (shell !== "bash" && shell !== "powershell") {
	console.error(`--shell must be bash or powershell, got ${shell}`);
	process.exit(2);
}

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
// pi's `exports` map does not expose package.json, so the devDependency's CLI is addressed by path.
const piCli = join(REPO, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
if (!existsSync(piCli)) {
	console.error(`pi CLI not found at ${piCli} — run npm ci first`);
	process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), "onecode-live-smoke-"));
const project = join(work, "project");
const agentDir = join(work, "agent");
mkdirSync(project, { recursive: true });
mkdirSync(agentDir, { recursive: true });
execFileSync("git", ["init", "-q"], { cwd: project });
writeFileSync(join(project, "CLAUDE.md"), "# Smoke\n\nThrowaway project for the live smoke.\n");
// The blocked half: a deny rule for the delete command, and the file it would
// remove. It reads as disposable and is committed, so a cautious model issues
// the delete instead of questioning it.
const SENTINEL = "stale.log";
writeFileSync(join(project, SENTINEL), "old build output\n");
execFileSync("git", ["add", SENTINEL], { cwd: project });
execFileSync("git", ["-c", "user.name=smoke", "-c", "user.email=smoke@example.invalid", "commit", "-qm", "init"], { cwd: project });
mkdirSync(join(project, ".claude"), { recursive: true });
const denyRule = shell === "bash" ? "Bash(rm:*)" : "PowerShell(Remove-Item:*)";
writeFileSync(join(project, ".claude", "settings.json"), JSON.stringify({ permissions: { deny: [denyRule] } }, null, "\t"));
// An isolated pi agent dir with ONLY this repo registered as a package.
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [REPO] }, null, "\t"));
const realAgentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const hasKey = Object.keys(process.env).some((k) => /_API_KEY$/.test(k));
if (!hasKey && existsSync(join(realAgentDir, "auth.json"))) copyFileSync(join(realAgentDir, "auth.json"), join(agentDir, "auth.json"));

// The shell computes the marker, so a result carrying it came from a real run, not from the prompt.
const [A, B] = [6, 7];
const MARKER = `smoke-${A * B}`;
const [allowed, blocked] =
	shell === "bash"
		? [`echo smoke-$((${A}*${B})) from-$(uname -s)`, `echo second; rm -f ${SENTINEL}`]
		: [`Write-Output ('smoke-' + (${A}*${B})); Write-Output $PSVersionTable.PSEdition`, `Remove-Item ${SENTINEL}`];
const prompt = `Use the ${shell} tool to run exactly these two commands, one tool call each and in this order, then reply with the single word done. First: ${allowed} Second: ${blocked}`;

const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
if (shell === "powershell") env.CLAUDE_CODE_USE_POWERSHELL_TOOL = "1";

console.log(`smoke: shell=${shell} model=${model} platform=${process.platform}`);
console.log(`smoke: work=${work}`);
const started = Date.now();
const child = spawn(process.execPath, [piCli, "--model", model, "--mode", "json", "-p", prompt], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let stdout = "";
let stderr = "";
child.stdout.on("data", (d) => (stdout += d.toString()));
child.stderr.on("data", (d) => (stderr += d.toString()));
let timedOut = false;
const timer = setTimeout(() => {
	timedOut = true;
	// Plain JS cannot import lib/process-tree.ts; this mirrors its Windows kill (taskkill /T /F from System32, then the leader).
	if (process.platform === "win32" && child.pid) {
		try {
			execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
		} catch {}
	}
	try {
		child.kill("SIGKILL");
	} catch {}
}, timeoutMs);

const exit = await new Promise((done) => {
	child.on("error", (error) => done({ code: null, error: error.message }));
	child.on("close", (code, signal) => done({ code, signal }));
});
clearTimeout(timer);

const events = stdout
	.split("\n")
	.filter((l) => l.startsWith("{"))
	.flatMap((l) => {
		try {
			return [JSON.parse(l)];
		} catch {
			return [];
		}
	});
const toolCalls = events.filter((e) => e.type === "tool_execution_start").map((e) => e.toolName);
const results = events.filter((e) => e.type === "tool_execution_end");
const hit = results.find((e) => e.toolName === shell && JSON.stringify(e.result ?? "").includes(MARKER));
const resultText = (e) => (Array.isArray(e.result?.content) ? e.result.content.map((c) => c.text ?? "").join("\n") : "");
const denial = results.find((e) => e.toolName === shell && e.isError && resultText(e).includes(`permission rule "${denyRule}"`));
const sentinelKept = existsSync(join(project, SENTINEL));
const finalText = events
	.filter((e) => e.type === "message_end" && e.message?.role === "assistant")
	.map((e) => (Array.isArray(e.message.content) ? e.message.content.filter((c) => c.type === "text").map((c) => c.text).join("") : ""))
	.filter(Boolean)
	.at(-1);

writeFileSync(join(work, "events.jsonl"), stdout);
writeFileSync(join(work, "stderr.log"), stderr);

console.log(`smoke: pi exited ${exit.code ?? exit.signal ?? exit.error} after ${((Date.now() - started) / 1000).toFixed(1)}s${timedOut ? " (TIMED OUT)" : ""}`);
console.log(`smoke: tools called: ${toolCalls.length ? toolCalls.join(", ") : "(none)"}`);
if (hit) {
	const text = JSON.stringify(hit.result).slice(0, 400);
	console.log(`smoke: ${shell} result carried ${MARKER}: ${text}`);
}
console.log(`smoke: ${denyRule} denied the second command: ${denial ? "yes" : "no"}; ${SENTINEL} ${sentinelKept ? "kept" : "DELETED"}`);
if (finalText) console.log(`smoke: final reply: ${finalText.trim().slice(0, 200)}`);
const loadFailure = /Failed to load extension|Error loading/i.test(stderr);
if (loadFailure) console.log("smoke: stderr reports an extension load failure");

if (hit && denial && sentinelKept && !timedOut && !loadFailure) {
	console.log("smoke: PASS");
	process.exit(0);
}
console.log(`smoke: FAIL — events: ${join(work, "events.jsonl")}, stderr: ${join(work, "stderr.log")}`);
console.log(stderr.split("\n").slice(-20).join("\n"));
process.exit(1);
