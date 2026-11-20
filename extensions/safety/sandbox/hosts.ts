/**
 * Who decides a host the sandbox's settings do not list (pure).
 *
 * The sandbox's proxy asks once per connection. The answer follows the
 * permission mode, as the gate's own answers do:
 * - bypassPermissions judges nothing, so the host is allowed (Claude Code's
 *   behaviour).
 * - Auto mode never raises a per-action prompt: the host is refused with a
 *   reason that sends the model to the command's own `allowed_domains`
 *   list, which the classifier reviews with the command.
 * - dontAsk refuses.
 * - The other modes ask the user, one prompt at a time. "Yes" and "No" hold
 *   until the agent's run ends, so one `npm install` is one question and a
 *   refused host is not asked again by the retry; a session grant holds for
 *   the session. With no one to ask, the host is refused.
 */

import type { SandboxHostAsk } from "../../lib/shell-run/sandbox.ts";

/** The user's answer to a host prompt; undefined when there was no one to ask or the prompt was dismissed. */
export type HostAnswer = "once" | "session" | "no" | undefined;

export interface HostGate {
	ask: SandboxHostAsk;
	/** The agent's run ended: its one-run answers no longer hold. */
	endRun(): void;
	/** The hosts the user allowed for the session, for `/sandbox`. */
	sessionHosts(): string[];
}

export function createHostGate(opts: { mode: () => string; notListed: string; prompt: (host: string, port: number | undefined) => Promise<HostAnswer> }): HostGate {
	const session = new Set<string>();
	const run = new Map<string, boolean>();
	let queue: Promise<unknown> = Promise.resolve();
	const known = (host: string): boolean | undefined => (session.has(host) ? true : run.get(host));
	return {
		ask: async ({ host, port }) => {
			const mode = opts.mode();
			if (mode === "bypassPermissions") return true;
			if (mode === "auto") return { allow: false, reason: opts.notListed };
			if (mode === "dontAsk") return false;
			const name = host.toLowerCase();
			// One prompt at a time; a connection that waited behind the same host's prompt takes its answer.
			const answer = queue.then(async () => {
				const earlier = known(name);
				if (earlier !== undefined) return earlier;
				const choice = await opts.prompt(host, port).catch(() => undefined);
				if (choice === "session") session.add(name);
				// A dismissed prompt is not an answer: the next connection asks again.
				if (choice === "once" || choice === "no") run.set(name, choice === "once");
				return choice === "once" || choice === "session";
			});
			queue = answer.catch(() => undefined);
			return answer;
		},
		endRun: () => run.clear(),
		sessionHosts: () => [...session],
	};
}
