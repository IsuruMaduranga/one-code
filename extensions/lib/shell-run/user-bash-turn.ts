/**
 * A user's `!` command starts a model turn, as Claude Code's does (pure; no pi
 * values). pi runs and records a `!` run, as a `bashExecution` message it
 * sends as `` Ran `cmd` ``, but starts no turn: the record waits for the next
 * prompt. The bash feature's `user_bash` handler runs the command through
 * operations wrapped by `withTurnAfterRun`, so pi still runs and records it
 * exactly once, and learns when the run settled; the bash-turn feature then
 * starts a turn with an empty message that sends nothing (the record is the
 * last thing the model reads and carries the tail's reminders:
 * lib/request/reminders.ts).
 *
 * The two features talk over `USER_BASH_CHANNEL`: the bash handler emits a
 * `UserBashTurnRequest` for each `!` run, and the bash-turn feature, when it
 * wants a turn after this run, sets `onSettled` on it before the emit returns.
 * The bash handler is the only `user_bash` handler that returns operations:
 * pi takes the first handler's result, so a second one would never run, or
 * would skip the bundled app's environment restore.
 *
 * Only in the bundled app's terminal (`turnAfterBashAllowed`). The app already
 * owns `user_bash`, so wrapping its operations takes nothing from anyone.
 * Under a plain pi install, returning operations would shadow every later
 * extension's `user_bash` handler (a remote or sandboxed shell), so the
 * handler returns nothing there and the record rides the next prompt, as pi
 * does. An RPC client's `bash` command and a print or JSON run start no turn
 * either: the client did not ask for one.
 */

import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { brandedId } from "../profile/brand.mjs";

/** Whether a `!` run may start a turn: under the bundled app (`LAUNCHER_ENV_VAR` set), typed in its terminal (pi's `ctx.mode` is "tui"). */
export function turnAfterBashAllowed(run: { app: boolean; mode: string }): boolean {
	return run.app && run.mode === "tui";
}

/** The bash handler emits a `UserBashTurnRequest` here for every `!` run, at `user_bash` time. */
export const USER_BASH_CHANNEL = brandedId("user-bash");

/** The `customType` of the empty message that starts the turn. It sends nothing (`withoutSilentMessages`). */
export const BASH_TURN_MESSAGE = brandedId("bash-turn");

export interface UserBashTurnRequest {
	command: string;
	/** A `!!` run: pi keeps it out of the context. */
	excludeFromContext: boolean;
	/** Set by a listener that wants a turn once this run settles and pi has recorded it. */
	onSettled?: (outcome: RunOutcome) => void;
}

/** How a `!` run ended, as the wrapped operations saw it. */
export interface RunOutcome {
	exitCode: number | null | undefined;
	/** The user cancelled it (pi aborted the run's signal). */
	cancelled: boolean;
	/** The shell could not run it: pi records nothing and reports the error. */
	failed: boolean;
}

/**
 * `operations` that run each command through `ops` and, once it settles, call
 * `onSettled` a macrotask later: pi records the run synchronously after the
 * operations' promise resolves (`AgentSession.executeBash`, pi 1.5.2), so the
 * record is on the branch by then. The result and any error pass through
 * unchanged.
 */
export function withTurnAfterRun(ops: BashOperations, onSettled: (outcome: RunOutcome) => void, defer: (run: () => void) => void = setImmediate): BashOperations {
	return {
		exec: async (command, cwd, options) => {
			const settle = (outcome: Omit<RunOutcome, "cancelled">) => defer(() => onSettled({ ...outcome, cancelled: options.signal?.aborted ?? false }));
			try {
				const result = await ops.exec(command, cwd, options);
				settle({ exitCode: result.exitCode, failed: false });
				return result;
			} catch (error) {
				// pi reads an exec error under an aborted signal as a cancel, and records it.
				settle({ exitCode: undefined, failed: !options.signal?.aborted });
				throw error;
			}
		},
	};
}

/** Whether a settled `!` run starts a turn: not after a cancel or a failed run, and only while the session is idle and still the one the run started in. */
export function startsTurn(outcome: RunOutcome, session: { idle: boolean; current: boolean }): boolean {
	return !outcome.cancelled && !outcome.failed && session.idle && session.current;
}
