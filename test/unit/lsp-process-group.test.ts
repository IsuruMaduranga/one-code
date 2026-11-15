/**
 * A server behind a launcher script, that ignores `exit` and a closed stdin
 * (as a JVM server started by a shell script does): the client must end the
 * real process, not only the script, both when `stop()` falls back to a kill
 * and when this process exits without stopping it (a crash, where pi calls
 * `process.exit` without a `session_shutdown`).
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LspClient } from "../../extensions/tools/lsp/client.ts";

/** Answers `initialize` and `shutdown`, writes its pid, and never exits on its own. */
const STUBBORN_SERVER = `
const { writeFileSync } = require("node:fs");
writeFileSync(process.env.PID_FILE, String(process.pid));
setInterval(() => {}, 1000);
let buffer = Buffer.alloc(0);
const send = (message) => {
	const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }));
	process.stdout.write(Buffer.concat([Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n"), body]));
};
process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	for (;;) {
		const end = buffer.indexOf("\\r\\n\\r\\n");
		if (end < 0) return;
		const length = Number(/Content-Length: (\\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
		if (buffer.length < end + 4 + length) return;
		const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
		buffer = buffer.subarray(end + 4 + length);
		if (message.method === "initialize" || message.method === "shutdown") send({ id: message.id, result: message.method === "initialize" ? { capabilities: {} } : null });
	}
});
process.stdin.on("error", () => {});
`;

/** `; :` keeps the shell from replacing itself with node: the server is the script's child. */
const launcher = (pidFile: string) => ({
	config: { command: "/bin/sh", args: ["-c", `"${process.execPath}" -e "$STUBBORN_SERVER"; :`] },
	env: { STUBBORN_SERVER: STUBBORN_SERVER, PID_FILE: pidFile },
});

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const until = async (condition: () => boolean, tries = 80) => {
	for (let i = 0; i < tries && !condition(); i++) await new Promise((done) => setTimeout(done, 50));
	return condition();
};

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

	it("is ended by stop() when it ignores exit", async () => {
		const { config, env } = launcher(pidFile);
		const client = new LspClient(config, dir, { env });
		await client.start();
		expect(await until(() => existsSync(pidFile))).toBe(true);
		serverPid = Number(readFileSync(pidFile, "utf8"));
		expect(alive(serverPid)).toBe(true);

		await client.stop();
		expect(await until(() => !alive(serverPid!))).toBe(true);
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
		const owner = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["pipe", "pipe", "pipe"] });
		let stderr = "";
		owner.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		const exited = once(owner, "exit");
		try {
			const [chunk] = await Promise.race([once(owner.stdout, "data"), exited.then(() => Promise.reject(new Error(`owner exited before ready: ${stderr}`)))]);
			expect(String(chunk)).toContain("ready");
			expect(await until(() => existsSync(pidFile))).toBe(true);
			serverPid = Number(readFileSync(pidFile, "utf8"));
			expect(alive(serverPid)).toBe(true);

			owner.stdin.write("crash\n");
			const [code] = await exited;
			expect(code).toBe(1);
			expect(await until(() => !alive(serverPid!))).toBe(true);
		} finally {
			if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
		}
	});
});
