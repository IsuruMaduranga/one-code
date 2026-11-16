/**
 * bash-turn extension: a user's `!` command starts a model turn once pi has
 * recorded it, so the model reacts to the output with nothing typed, as in
 * Claude Code (lib/shell-run/user-bash-turn.ts has the route).
 *
 * For each `!` run typed in the bundled app's terminal (not under a plain pi
 * install, not from an RPC client's `bash` command) the bash feature's
 * `user_bash` handler emits a request on USER_BASH_CHANNEL; this extension
 * sets its `onSettled` when the run should start a turn: not for a `!!` run (kept out of the context) and not while the
 * model is working (pi queues that record until the turn ends, and the next
 * prompt carries it). When the run settles it checks again: no turn after a
 * cancel or a failed run, while the session is busy, or once the session that
 * ran it has ended or been replaced. The turn opens with an empty, hidden
 * message that sends nothing, so the request ends in the record itself, which
 * carries the tail's reminders (lib/request/reminders.ts).
 */

import { feature } from "../../lib/profile/feature.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sessionAlive } from "../../lib/notify/session-lifecycle.ts";
import { BASH_TURN_MESSAGE, startsTurn, USER_BASH_CHANNEL, type UserBashTurnRequest } from "../../lib/shell-run/user-bash-turn.ts";

function bashTurnExtension(pi: ExtensionAPI) {
	const alive = sessionAlive(pi);
	let ctx: ExtensionContext | undefined;
	/** Bumped at every session start and end, so a run that settles in another session starts nothing. */
	let generation = 0;
	pi.on("session_start", (_event, next) => {
		ctx = next;
		generation++;
	});
	pi.on("session_shutdown", () => {
		ctx = undefined;
		generation++;
	});

	pi.events.on(USER_BASH_CHANNEL, (data) => {
		const request = data as UserBashTurnRequest;
		const session = ctx;
		if (request.excludeFromContext || !session || !alive() || !session.isIdle()) return;
		const started = generation;
		request.onSettled = (outcome) => {
			const current = alive() && generation === started;
			if (!startsTurn(outcome, { idle: current && session.isIdle(), current })) return;
			pi.sendMessage({ customType: BASH_TURN_MESSAGE, content: [], display: false }, { triggerTurn: true });
		};
	});
}

export default feature("bash-turn", bashTurnExtension);
