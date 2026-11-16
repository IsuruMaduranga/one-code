#!/usr/bin/env node
/**
 * The exit probe's stand-in processes (test/e2e/exit-probe.mjs). The second
 * argument is `<tag>:<role>`, so the probe can find the process by its command
 * line on every platform and name the spawner it came from.
 *
 *   sleep <tag>:<role>  live until killed; ignore SIGINT (a `&` job in a
 *                       non-interactive shell does) and SIGHUP (a daemon
 *                       does); SIGTERM ends it
 *   fork <tag>:<role>   start a `sleep` child in this process group with no
 *                       stdio, then exit at once, as a daemonizing program
 *                       (`docker compose up -d`, a dev server's supervisor)
 *                       leaves its worker behind
 *   sleep-noterm, fork-noterm
 *                       the same, with a worker that ignores SIGTERM too (a
 *                       server stuck in its shutdown handler); only SIGKILL
 *                       ends it
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { holdOn } from "./stubborn.mjs";

const [mode, label] = process.argv.slice(2);
if (!label?.includes(":")) {
	process.stderr.write("usage: exit-probe-proc.mjs sleep|fork|sleep-noterm|fork-noterm <tag>:<role>\n");
	process.exit(2);
}

if (mode === "sleep" || mode === "sleep-noterm") {
	holdOn(["SIGINT", "SIGHUP", ...(mode === "sleep-noterm" ? ["SIGTERM"] : [])]);
} else if (mode === "fork" || mode === "fork-noterm") {
	const worker = mode === "fork" ? "sleep" : "sleep-noterm";
	const child = spawn(process.execPath, [fileURLToPath(import.meta.url), worker, label], { stdio: "ignore", windowsHide: true });
	child.unref();
	process.stdout.write(`started ${child.pid}\n`);
} else {
	process.stderr.write(`unknown mode ${mode}\n`);
	process.exit(2);
}
