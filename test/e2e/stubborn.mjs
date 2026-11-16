/**
 * Stub processes that refuse to end politely, for the tests of how One Code
 * ends what it starts (test/e2e/exit-probe.mjs, the process-group unit tests).
 *
 * Imported for its side effect: with `EXIT_PROBE_STUBBORN` set (the exit
 * probe's launcher scripts set it), the importing process stays alive and
 * ignores a closed stdin, SIGINT and SIGHUP, as a JVM server behind a
 * launcher script can. SIGTERM still ends it. A server whose protocol has an
 * `exit` message ignores that too when `stubborn` is true.
 */

export const stubborn = Boolean(process.env.EXIT_PROBE_STUBBORN);

/**
 * Stay alive until killed and ignore `signals`: SIGINT (a `&` job in a
 * non-interactive shell does), SIGHUP (a daemon does), and SIGTERM for a
 * process stuck in its shutdown handler. Errors on a closed stdin or stdout
 * are ignored, so a vanished peer does not end the process either.
 */
export function holdOn(signals = ["SIGINT", "SIGHUP"]) {
	setInterval(() => {}, 60_000);
	for (const signal of signals) process.on(signal, () => {});
	process.stdin.on("error", () => {});
	process.stdout.on("error", () => {});
}

if (stubborn) holdOn();
