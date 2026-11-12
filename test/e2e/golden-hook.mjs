#!/usr/bin/env node
/**
 * The golden snapshot's hook command (golden-requests.mjs writes it into the
 * user settings of the tools and session scenarios; golden-fixture.ts
 * HOOK_ROUNDS makes the calls it answers). The first argument names the hook;
 * a tool hook answers only a call whose Bash command or Write path carries a
 * case marker and passes every other call through untouched, so the rest of
 * the scenario runs as if no hook were configured.
 *
 *   pre          PreToolUse on Bash: hook-reason (exit 2 with a reason),
 *                hook-exit2 (exit 2, no reason), hook-deny, hook-ask,
 *                hook-halt (continue: false), hook-block (decision: block),
 *                hook-flood (stdout past the output limit), hook-context
 *   slow         PreToolUse on Bash with a one-second timeout: hook-timeout sleeps
 *   post         PostToolUse on Bash and Write: hook-post-block,
 *                hook-post-context, hook-post-empty (an empty replacement
 *                result), and a write to hooked.txt rewritten like a formatter
 *   session      SessionStart: plain stdout context
 *   prompt       UserPromptSubmit: plain stdout context
 *   stop         Stop: blocks once (stop_hook_active false), then lets it stop
 *   precompact   PreCompact: plain stdout, the summarizer's extra instructions
 *   postcompact  PostCompact: JSON additionalContext
 */
import { readFileSync, writeFileSync } from "node:fs";

const kind = process.argv[2];
const payload = JSON.parse(readFileSync(0, "utf8") || "{}");
const input = payload.tool_input ?? {};
const marker = /hook-[a-z0-9-]+/.exec(String(input.command ?? ""))?.[0];

const json = (value) => process.stdout.write(JSON.stringify(value));
const pre = (fields) => json({ hookSpecificOutput: { hookEventName: "PreToolUse", ...fields } });
const post = (fields) => json({ hookSpecificOutput: { hookEventName: "PostToolUse", ...fields } });

function preToolUse() {
	switch (marker) {
		case "hook-reason":
			process.stderr.write("Golden hook refuses this command.\n");
			process.exit(2);
		case "hook-exit2":
			process.exit(2);
		case "hook-deny":
			return pre({ permissionDecision: "deny" });
		case "hook-ask":
			return pre({ permissionDecision: "ask" });
		case "hook-halt":
			return json({ continue: false });
		case "hook-block":
			return json({ decision: "block" });
		case "hook-flood":
			return process.stdout.write("x".repeat(1_000_001));
		case "hook-context":
			return pre({ additionalContext: "Golden pre-tool context." });
	}
}

function postToolUse() {
	if (String(input.file_path ?? "").endsWith("hooked.txt")) return writeFileSync(input.file_path, "formatted by the golden hook\n");
	switch (marker) {
		case "hook-post-block":
			return json({ decision: "block", reason: "Golden post-tool objection." });
		case "hook-post-context":
			return post({ additionalContext: "Golden post-tool context." });
		case "hook-post-empty":
			return post({ updatedToolResult: "" });
	}
}

switch (kind) {
	case "pre":
		preToolUse();
		break;
	case "slow":
		if (marker === "hook-timeout") await new Promise((resolve) => setTimeout(resolve, 5_000));
		break;
	case "post":
		postToolUse();
		break;
	case "session":
		process.stdout.write("Golden session-start context.\n");
		break;
	case "prompt":
		process.stdout.write("Golden prompt context.\n");
		break;
	case "stop":
		if (!payload.stop_hook_active) json({ decision: "block", reason: "Golden stop: check once more." });
		break;
	case "precompact":
		process.stdout.write("Golden compaction instructions.\n");
		break;
	case "postcompact":
		json({ hookSpecificOutput: { hookEventName: "PostCompact", additionalContext: "Golden post-compaction context." } });
		break;
}
