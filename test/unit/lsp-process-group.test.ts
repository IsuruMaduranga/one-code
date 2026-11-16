/**
 * A server behind a launcher script, that ignores `exit` and a closed stdin
 * (as a JVM server started by a shell script does): the client must end the
 * real process, not only the script, when `stop()` falls back to a kill,
 * when the script exits (on stop or mid-session) and leaves the server
 * running, and when this
 * process exits without stopping it (a crash, where pi calls `process.exit`
 * without a `session_shutdown`).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LspClient } from "../../extensions/tools/lsp/client.ts";
import { alive, parentAndGroup, startOwner, until } from "./helpers/process-alive.ts";
import { RECORDING_SERVER } from "./helpers/recording-lsp-server.ts";

/** `; :` keeps the shell from replacing itself with node: the server is the script's child. */
const launcher = (pidFile: string, stubborn: "1" | "launcher" = "1") => ({
	config: { command: "/bin/sh", args: ["-c", `"${process.execPath}" -e "$SERVER"; :`] },
	env: { SERVER: RECORDING_SERVER, PID_FILE: pidFile, STUBBORN: stubborn },
});

describe.skipIf(process.platform === "win32")("a language server behind a launcher script", () => {
	let dir: string;
	let pidFile: string;
	let serverPid: number | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "lsp-group-"));
		pidFile = join(dir, "server.pid");
		serverPid = undefined;
	});
	afterEach(() => {
		if (serverPid && alive(serverPid)) process.kill(serverPid, "SIGKILL");
		rmSync(dir, { recursive: true, force: true });
	});

	const readServerPid = async () => {
		expect(await until(() => existsSync(pidFile))).toBe(true);
		serverPid = Number(readFileSync(pidFile, "utf8"));
		expect(alive(serverPid)).toBe(true);
		return serverPid;
	};

	it.each([
		["ignores exit", "1"],
		["outlives its launcher", "launcher"],
	] as const)("is ended by stop() when it %s", async (_, stubborn) => {
		const { config, env } = launcher(pidFile, stubborn);
		const client = new LspClient(config, dir, { env });
		await client.start();
		const pid = await readServerPid();

		await client.stop();
		expect(await until(() => !alive(pid))).toBe(true);
	});

	it("is ended when its launcher dies mid-session", async () => {
		const { config, env } = launcher(pidFile);
		const client = new LspClient(config, dir, { env });
		await client.start();
		const pid = await readServerPid();
		const launcherPid = parentAndGroup(pid).ppid;

		process.kill(launcherPid, "SIGKILL");
		expect(await until(() => !alive(pid))).toBe(true);
		expect(client.isRunning).toBe(false);
		await client.stop();
	});

	// The next server for the workspace starts once stop() resolves (the
	// respawn in lsp/index.ts): the launcher's exit is not the server's, and a
	// server still in its TERM grace would run beside its replacement.
	it.each([
		["on stop()", false],
		["after its launcher died", true],
	] as const)("is gone when stop() resolves, though it ignores SIGTERM, %s", async (_, launcherDies) => {
		const { config, env } = launcher(pidFile, "launcher");
		const client = new LspClient(config, dir, { env: { ...env, SLOW_TERM: "1" } });
		await client.start();
		const pid = await readServerPid();
		if (launcherDies) {
			const launcherPid = parentAndGroup(pid).ppid;
			process.kill(launcherPid, "SIGKILL");
			expect(await until(() => !client.isRunning)).toBe(true);
		}

		await client.stop();
		expect(alive(pid)).toBe(false);
	});

	it("is ended when its owner crashes without stopping it", async () => {
		const { config, env } = launcher(pidFile);
		// Loaded through jiti, as pi loads an extension: Node's own type
		// stripping cannot run the client's parameter properties.
		const jitiPath = createRequire(resolve("node_modules/@earendil-works/pi-coding-agent/dist/index.js")).resolve("jiti");
		const script = [
			`import { createRequire } from "node:module";`,
			`const { createJiti } = createRequire(import.meta.url)(${JSON.stringify(jitiPath)});`,
			`const { LspClient } = await createJiti(import.meta.url).import(${JSON.stringify(resolve("extensions/tools/lsp/client.ts"))});`,
			`const client = new LspClient(${JSON.stringify(config)}, ${JSON.stringify(dir)}, { env: ${JSON.stringify(env)} });`,
			// The client unrefs its handles: the owner keeps itself alive, as pi does.
			`setInterval(() => {}, 1000);`,
			`await client.start();`,
			`process.stdout.write("ready\\n");`,
			`process.stdin.once("data", () => { throw new Error("crash"); });`,
		].join("\n");
		const run = await startOwner(script);
		try {
			expect(run.ready).toContain("ready");
			const pid = await readServerPid();

			run.owner.stdin.write("crash\n");
			const [code] = await run.exited;
			expect(code).toBe(1);
			expect(await until(() => !alive(pid))).toBe(true);
		} finally {
			run.kill();
		}
	});
});
