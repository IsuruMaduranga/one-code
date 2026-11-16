/**
 * A stdio MCP server behind a launcher that does not exec it (`npx` then node,
 * `uvx` then python, a start script), and that ignores a closed stdin: the
 * transport must end the real process, not only the launcher, when it closes,
 * when the launcher dies mid-session, and when this process exits without
 * closing it (a crash, where pi exits without `session_shutdown`). The SDK's
 * own transport failed all three (test/e2e/exit-probe.mjs).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProcessGroupStdioTransport } from "../../extensions/tools/mcp/stdio-transport.ts";
import { alive, parentAndGroup, startOwner, until } from "./helpers/process-alive.ts";

/** Answers every request with an empty result; with EXIT_PROBE_STUBBORN it outlives a closed stdin (test/e2e/stubborn.mjs). */
const SERVER = `
if (process.env.PID_FILE) require("node:fs").writeFileSync(process.env.PID_FILE, String(process.pid));
require(${JSON.stringify(resolve("test/e2e/stubborn.mjs"))});
let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffered += chunk;
	let at;
	while ((at = buffered.indexOf("\\n")) >= 0) {
		const message = JSON.parse(buffered.slice(0, at));
		buffered = buffered.slice(at + 1);
		if (message.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { echoed: message.method } }) + "\\n");
	}
});
`;

const framing = { ReadBuffer, serializeMessage };
/** `; :` keeps the shell from replacing itself with node: the server is the script's child. */
const launcherParams = (pidFile: string) => ({
	command: "/bin/sh",
	args: ["-c", `"${process.execPath}" -e "$SERVER"; :`],
	env: { ...process.env, SERVER, PID_FILE: pidFile, EXIT_PROBE_STUBBORN: "1" },
});

describe.skipIf(process.platform === "win32")("a stdio MCP server behind a launcher", () => {
	let dir: string;
	let pidFile: string;
	let serverPid: number | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "mcp-group-"));
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

	it("carries messages both ways", async () => {
		const transport = new ProcessGroupStdioTransport(launcherParams(pidFile), framing);
		const received = new Promise((resolveMessage) => {
			transport.onmessage = resolveMessage;
		});
		await transport.start();
		await transport.send({ jsonrpc: "2.0", id: 1, method: "ping" });
		expect(await received).toEqual({ jsonrpc: "2.0", id: 1, result: { echoed: "ping" } });
		await readServerPid();
		await transport.close();
	}, 15_000);

	it("is ended by close() when it ignores a closed stdin", async () => {
		const transport = new ProcessGroupStdioTransport(launcherParams(pidFile), framing);
		const closed = new Promise<void>((resolveClose) => {
			transport.onclose = resolveClose;
		});
		await transport.start();
		const pid = await readServerPid();

		await transport.close();
		// close() waits for the group to empty; a loaded runner can still take seconds to reap the server.
		expect(await until(() => !alive(pid), 140)).toBe(true);
		await closed;
	}, 15_000);

	it("gets one SIGTERM, and close() waits for it, when the launcher exits on the closed stdin", async () => {
		// The launcher exits once its stdin closes and leaves the server, which
		// takes half a second in its SIGTERM handler: the launcher's exit already
		// stopped the group, so close() must not signal it again or return early.
		const log = join(dir, "terms.log");
		const server = [
			`require("node:fs").writeFileSync(process.env.PID_FILE, String(process.pid));`,
			`process.on("SIGTERM", () => { require("node:fs").appendFileSync(process.env.TERM_LOG, "TERM\\n"); setTimeout(() => process.exit(0), 500); });`,
			`setInterval(() => {}, 1000);`,
		].join("\n");
		const transport = new ProcessGroupStdioTransport(
			{ command: "/bin/sh", args: ["-c", `"${process.execPath}" -e "$SERVER" & cat >/dev/null`], env: { ...process.env, SERVER: server, PID_FILE: pidFile, TERM_LOG: log } },
			framing,
		);
		await transport.start();
		const pid = await readServerPid();

		await transport.close();
		expect(alive(pid)).toBe(false);
		expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["TERM"]);
	}, 15_000);

	it("is ended when its launcher dies mid-session", async () => {
		const transport = new ProcessGroupStdioTransport(launcherParams(pidFile), framing);
		await transport.start();
		const pid = await readServerPid();
		const { ppid: launcherPid, pgid: group } = parentAndGroup(pid);
		// The server's parent is the launcher, which leads the server's own group.
		expect(group).toBe(launcherPid);

		process.kill(launcherPid, "SIGKILL");
		expect(await until(() => !alive(pid))).toBe(true);
		await transport.close();
	}, 15_000);

	it("is ended when its owner crashes without closing it", async () => {
		// Loaded through jiti, as pi loads an extension.
		const jitiPath = createRequire(resolve("node_modules/@earendil-works/pi-coding-agent/dist/index.js")).resolve("jiti");
		const script = [
			`import { createRequire } from "node:module";`,
			`const { createJiti } = createRequire(import.meta.url)(${JSON.stringify(jitiPath)});`,
			`const jiti = createJiti(import.meta.url);`,
			`const { ProcessGroupStdioTransport } = await jiti.import(${JSON.stringify(resolve("extensions/tools/mcp/stdio-transport.ts"))});`,
			`const { ReadBuffer, serializeMessage } = await jiti.import("@modelcontextprotocol/sdk/shared/stdio.js");`,
			`const transport = new ProcessGroupStdioTransport(${JSON.stringify(launcherParams(pidFile))}, { ReadBuffer, serializeMessage });`,
			`await transport.start();`,
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
	}, 15_000);
});
