#!/usr/bin/env node
/**
 * Fork cache check over one pi run (cache-probe.sh's fork phase): a fork's
 * first request extends its parent's last one, so it must read the parent's
 * cached prompt (decisions/caching.md, "How forks do it"). The things that
 * broke it before: a fork tool declared with a schema other than the
 * parent's (the ledger then declares the fork's in its place, mid-array), and
 * on Codex the fork's own session id, which pi-ai puts in the header and the
 * cache key (findings §75).
 *
 *   node test/e2e/cache-probe-fork.mjs <session-dir> --model <provider/model>
 *
 * Reads the run's session files: the main session (top level) and the fork's
 * (`subagents/<task>/`). The parent's request is its reply that called
 * Agent; the fork's first reply is the first assistant entry in the fork's file
 * timestamped after that call (the fork's file opens with copies of the
 * parent's entries). The fork must read the parent's whole prompt, less one
 * implicit-cache block (`DEFAULT_BLOCK`, as the other probes allow). On
 * OpenAI's models with explicit breakpoints that holds only because the
 * context message after the first user message carries one (findings §95):
 * without it the parent's first request caches only up to the user message.
 * A miss is a FAIL, except on OpenRouter, which can route the fork to another
 * upstream host than the parent's: a WARN there.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_BLOCK } from "./cache-hosts.mjs";

const args = process.argv.slice(2);
const dir = args[0];
const modelAt = args.indexOf("--model");
const model = modelAt >= 0 ? args[modelAt + 1] ?? "" : "";
if (!dir) {
	console.error("usage: cache-probe-fork.mjs <session-dir> --model <provider/model>");
	process.exit(2);
}

/** The .jsonl files directly in `folder`. */
function jsonlIn(folder) {
	try {
		return readdirSync(folder)
			.map((name) => join(folder, name))
			.filter((path) => path.endsWith(".jsonl") && statSync(path).isFile());
	} catch {
		return [];
	}
}

/** Every assistant message of a session file, in order, with its entry timestamp. */
function assistants(file) {
	const out = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const message = entry.message;
		if (message?.role !== "assistant" || !message.usage) continue;
		out.push({ at: Date.parse(entry.timestamp ?? "") || message.timestamp || 0, message });
	}
	return out;
}

const prompt = (usage) => (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
const fail = (text) => {
	console.log(`FAIL  fork: ${text}`);
	process.exit(1);
};

const mainFiles = jsonlIn(dir);
if (mainFiles.length === 0) fail(`no main session file in ${dir}`);
if (mainFiles.length > 1) fail(`${mainFiles.length} main session files in ${dir}: one run per session dir`);
const mainFile = mainFiles[0];
const spawn = assistants(mainFile).find(({ message }) => Array.isArray(message.content) && message.content.some((block) => block?.type === "toolCall" && block.name === "Agent"));
if (!spawn) fail("the parent never called Agent (the model did not fork)");

const subagents = join(dir, "subagents");
let forkFiles = [];
try {
	forkFiles = readdirSync(subagents).flatMap((task) => jsonlIn(join(subagents, task)));
} catch {
	// no subagents folder: no fork ran
}
const forkReplies = forkFiles.flatMap((file) => assistants(file)).filter(({ at }) => at > spawn.at).sort((a, b) => a.at - b.at);
if (forkReplies.length === 0) fail("no fork reply after the Agent call (the fork did not run)");

const parent = spawn.message.usage;
const parentPrompt = prompt(parent);
const first = forkReplies[0].message.usage;
const read = first.cacheRead ?? 0;
const line = `fork's first request read ${read} of the parent's ${parentPrompt}-token prompt (parent wrote ${parent.cacheWrite ?? 0}; fork prompt ${prompt(first)}, wrote ${first.cacheWrite ?? 0})`;
if (read >= parentPrompt - DEFAULT_BLOCK) {
	console.log(`PASS  fork: ${line}`);
	process.exit(0);
}
if (model.startsWith("openrouter/")) {
	console.log(`WARN  fork: ${line}; OpenRouter may have routed the fork to another host`);
	process.exit(0);
}
fail(line);
