/**
 * run-status extension — a one-shot run that failed exits non-zero.
 *
 * A required feature: a script or CI job reads the exit code, so a profile
 * that turns the `/exit` command off must not lose it (it lived in the exit
 * extension until 2026-11-10).
 */

import { feature } from "../../lib/profile/feature.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ONE_SHOT_COMMAND_FAILED_CHANNEL, type RunOutcome, RunOutcomeLatch, TURN_FAILED_CHANNEL } from "../../lib/notify/interrupt.ts";

function runStatusExtension(pi: ExtensionAPI) {
	const outcome = new RunOutcomeLatch();
	let settled: RunOutcome | undefined;
	// The harness stopped the turn in progress: its run ends "aborted", which
	// must not read as a user cancel when the turn settles.
	let turnFailed = false;
	pi.on("agent_end", (event, ctx) => {
		outcome.record(event.messages, ctx.signal?.aborted);
	});
	pi.on("agent_settled", () => {
		const run = outcome.take();
		settled = turnFailed ? "error" : run ?? settled;
		turnFailed = false;
	});
	pi.events.on(ONE_SHOT_COMMAND_FAILED_CHANNEL, () => {
		settled = "error";
	});
	pi.events.on(TURN_FAILED_CHANNEL, () => {
		turnFailed = true;
	});
	pi.on("session_shutdown", (event, ctx) => {
		if (ctx.mode !== "print" && ctx.mode !== "json") return;
		if (event.reason !== "quit" || (settled !== "error" && !turnFailed)) return;
		// pi 1.0.1 checks provider errors for text output, but not JSON. A print
		// run may submit several prompts or replace the session (/clear), so a
		// settled turn is not yet the process's final outcome. Commit only at
		// final disposal, after retries/compaction and every prompt. main preserves
		// this code when runPrintMode returns zero; never clear another failure.
		if (process.exitCode === undefined || Number(process.exitCode) === 0) process.exitCode = 1;
	});
}

export default feature("run-status", runStatusExtension);
