/**
 * The PowerShell parse server's client (lib/powershell-parser.ts) against a
 * fake child process: the base64 line protocol, the ready handshake,
 * timeouts, crashes and the restart cap, Constrained Language Mode, the idle
 * stop, and the process-wide instance. The real walker against a real
 * PowerShell is powershell-parser-live.test.ts.
 */
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POWERSHELL_PARSE_BOOTSTRAP, POWERSHELL_PARSE_WALKER } from "../../extensions/lib/powershell-parse-script.ts";
import { PowerShellParser, sharedPowerShellParser } from "../../extensions/lib/powershell-parser.ts";

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const unb64 = (text: string) => Buffer.from(text, "base64").toString("utf8");

interface FakeServerBehaviour {
	/** The ready record's language mode. */
	language?: string;
	/** Never send the ready record, nor answer anything. */
	silent?: boolean;
	/** Answer a request; undefined means never answer. */
	answer?: (command: string, id: number) => Record<string, unknown> | string | undefined;
}

interface FakeServer {
	child: ChildProcess;
	bootstrap: string;
	firstLine?: string;
	requests: string[];
	killed: boolean;
	exit: (code: number) => void;
}

function fakeSpawner(behaviour: FakeServerBehaviour = {}) {
	const servers: FakeServer[] = [];
	const spawnServer = (bootstrap: string): ChildProcess => {
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, unref() {}, kill() { server.killed = true; return true; } }) as unknown as ChildProcess;
		const server: FakeServer = { child, bootstrap, requests: [], killed: false, exit: (code) => child.emit("exit", code, null) };
		servers.push(server);
		const send = (record: Record<string, unknown> | string) =>
			stdout.write(`${typeof record === "string" ? record : b64(JSON.stringify(record))}\n`);
		let buffer = "";
		stdin.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("ascii");
			for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (server.firstLine === undefined) {
					server.firstLine = line;
					if (!behaviour.silent) send({ id: 0, ready: true, edition: "Core", version: "7.6.6", language: behaviour.language ?? "FullLanguage" });
					continue;
				}
				const space = line.indexOf(" ");
				const id = Number(line.slice(0, space));
				const command = unb64(line.slice(space + 1));
				server.requests.push(command);
				if (behaviour.silent) continue;
				const answer = (behaviour.answer ?? ((c: string) => ({ nodes: [{ type: "ScriptBlockAst", parent: -1, start: 0, end: c.length }], errors: [] })))(command, id);
				if (answer !== undefined) send(typeof answer === "string" ? answer : { id, ...answer });
			}
		});
		return child;
	};
	return { servers, spawnServer };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("PowerShellParser protocol", () => {
	it("sends the bootstrap on the command line and the walker as the first stdin line", async () => {
		const fake = fakeSpawner();
		const parser = new PowerShellParser({ spawnServer: fake.spawnServer });
		await parser.parse("Get-ChildItem");
		expect(fake.servers[0].bootstrap).toBe(POWERSHELL_PARSE_BOOTSTRAP);
		expect(unb64(fake.servers[0].firstLine!)).toBe(POWERSHELL_PARSE_WALKER);
	});

	it("round-trips a command with Unicode dashes, curly quotes and newlines unchanged", async () => {
		const fake = fakeSpawner();
		const parser = new PowerShellParser({ spawnServer: fake.spawnServer });
		const command = "Get-Item –Recurse ‘a’\nrm x\r\n ls";
		const outcome = await parser.parse(command);
		expect(fake.servers[0].requests).toEqual([command]);
		expect(outcome).toEqual({ ok: true, parse: { nodes: [{ type: "ScriptBlockAst", parent: -1, start: 0, end: command.length }], errors: [] } });
	});

	it("matches answers to requests by id when they arrive out of order", async () => {
		const held: Array<() => void> = [];
		let fakeRef: ReturnType<typeof fakeSpawner>;
		const fake = (fakeRef = fakeSpawner({
			answer: (command, id) => {
				const send = () => fakeRef.servers[0].child.stdout!.emit("data", `${b64(JSON.stringify({ id, nodes: [], errors: [command] }))}\n`);
				held.push(send);
				return undefined;
			},
		}));
		const parser = new PowerShellParser({ spawnServer: fake.spawnServer });
		const first = parser.parse("one");
		const second = parser.parse("two");
		await vi.waitFor(() => expect(held).toHaveLength(2));
		held[1]();
		held[0]();
		expect(await first).toEqual({ ok: true, parse: { nodes: [], errors: ["one"] } });
		expect(await second).toEqual({ ok: true, parse: { nodes: [], errors: ["two"] } });
	});

	it("reads a one-element array written as a bare value, and null as empty", async () => {
		const fake = fakeSpawner({ answer: () => ({ nodes: { type: "ScriptBlockAst", parent: -1, start: 0, end: 0 }, errors: null }) });
		const parser = new PowerShellParser({ spawnServer: fake.spawnServer });
		expect(await parser.parse("")).toEqual({ ok: true, parse: { nodes: [{ type: "ScriptBlockAst", parent: -1, start: 0, end: 0 }], errors: [] } });
	});

	it("passes a parse with errors through as PowerShell's answer", async () => {
		const fake = fakeSpawner({ answer: () => ({ nodes: [], errors: ["TerminatorExpectedAtEndOfString"] }) });
		const parser = new PowerShellParser({ spawnServer: fake.spawnServer });
		expect(await parser.parse("ls ‘a")).toEqual({ ok: true, parse: { nodes: [], errors: ["TerminatorExpectedAtEndOfString"] } });
	});

	it("reports a walker failure as unparsed, keeping the server", async () => {
		const fake = fakeSpawner({ answer: (command) => (command === "bad" ? { failure: "boom" } : { nodes: [], errors: [] }) });
		const parser = new PowerShellParser({ spawnServer: fake.spawnServer });
		expect(await parser.parse("bad")).toEqual({ ok: false, reason: "the PowerShell parser failed: boom" });
		expect((await parser.parse("good")).ok).toBe(true);
		expect(fake.servers).toHaveLength(1);
	});

	it("reuses one server across requests", async () => {
		const fake = fakeSpawner();
		const parser = new PowerShellParser({ spawnServer: fake.spawnServer });
		await parser.parse("a");
		await parser.parse("b");
		expect(fake.servers).toHaveLength(1);
		expect(fake.servers[0].requests).toEqual(["a", "b"]);
	});
});

describe("PowerShellParser failures fail closed", () => {
	it("times out a server that never becomes ready, using the start timeout", async () => {
		vi.useFakeTimers();
		const fake = fakeSpawner({ silent: true });
		const parser = new PowerShellParser({ spawnServer: fake.spawnServer, startTimeoutMs: 5_000, requestTimeoutMs: 100 });
		const outcome = parser.parse("ls");
		await vi.advanceTimersByTimeAsync(4_999);
		let settled = false;
		void outcome.then(() => (settled = true));
		await Promise.resolve();
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(await outcome).toEqual({ ok: false, reason: "the PowerShell parser did not answer within 5000 ms" });
		expect(fake.servers[0].killed).toBe(true);
	});

	it("times out a request once ready, kills the server and starts a fresh one next time", async () => {
		vi.useFakeTimers();
		let hang = false;
		const fake = fakeSpawner({ answer: () => (hang ? undefined : { nodes: [], errors: [] }) });
		const parser = new PowerShellParser({ spawnServer: fake.spawnServer, requestTimeoutMs: 2_000 });
		expect((await parser.parse("warm")).ok).toBe(true);
		hang = true;
		const outcome = parser.parse("ls");
		await vi.advanceTimersByTimeAsync(2_000);
		expect(await outcome).toEqual({ ok: false, reason: "the PowerShell parser did not answer within 2000 ms" });
		hang = false;
		expect((await parser.parse("ls")).ok).toBe(true);
		expect(fake.servers.length).toBeGreaterThanOrEqual(2);
	});

	it("settles every waiting request when the server exits", async () => {
		const fake = fakeSpawner({ answer: () => undefined });
		const parser = new PowerShellParser({ spawnServer: fake.spawnServer });
		const a = parser.parse("a");
		const b = parser.parse("b");
		await vi.waitFor(() => expect(fake.servers[0].requests).toHaveLength(2));
		fake.servers[0].exit(1);
		expect(await a).toEqual({ ok: false, reason: "the PowerShell parser exited (code 1)" });
		expect(await b).toEqual({ ok: false, reason: "the PowerShell parser exited (code 1)" });
	});

	it("treats a spawn error as unparsed", async () => {
		const parser = new PowerShellParser({
			spawnServer: () => {
				const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), unref() {}, kill() { return true; } }) as unknown as ChildProcess;
				queueMicrotask(() => child.emit("error", new Error("spawn pwsh ENOENT")));
				return child;
			},
		});
		expect(await parser.parse("ls")).toEqual({ ok: false, reason: "PowerShell could not start: spawn pwsh ENOENT" });
	});

	it("treats a synchronous spawn throw as unparsed", async () => {
		const parser = new PowerShellParser({ spawnServer: () => { throw new Error("EACCES"); } });
		expect(await parser.parse("ls")).toEqual({ ok: false, reason: "PowerShell could not start: EACCES" });
	});

	it("treats output outside the protocol as a crash", async () => {
		const fake = fakeSpawner({ answer: () => "not base64 json!" });
		const parser = new PowerShellParser({ spawnServer: fake.spawnServer });
		expect(await parser.parse("ls")).toEqual({ ok: false, reason: "the PowerShell parser wrote a line that is not part of its protocol" });
		expect(fake.servers[0].killed).toBe(true);
	});

	it("stays off after more failures than maxRestarts, even when each restart becomes ready", async () => {
		const fake = fakeSpawner({ answer: () => "garbage" });
		const parser = new PowerShellParser({ spawnServer: fake.spawnServer, maxRestarts: 2 });
		for (let i = 0; i < 3; i++) expect((await parser.parse("ls")).ok).toBe(false);
		expect(parser.unavailable()).toMatch(/^the PowerShell parser is off after 3 failures/);
		const spawned = fake.servers.length;
		expect(await parser.parse("ls")).toEqual({ ok: false, reason: parser.unavailable() });
		expect(fake.servers).toHaveLength(spawned);
	});

	it("turns off for good under Constrained Language Mode", async () => {
		const fake = fakeSpawner({ language: "ConstrainedLanguage" });
		const parser = new PowerShellParser({ spawnServer: fake.spawnServer });
		const outcome = await parser.parse("ls");
		expect(outcome).toEqual({ ok: false, reason: "PowerShell runs in ConstrainedLanguage mode, where the parser is not available" });
		expect(parser.unavailable()).toBe("PowerShell runs in ConstrainedLanguage mode, where the parser is not available");
		await parser.parse("ls");
		expect(fake.servers).toHaveLength(1);
	});
});

describe("PowerShellParser lifecycle", () => {
	it("stops after the idle time without counting a failure, and restarts on the next request", async () => {
		vi.useFakeTimers();
		const fake = fakeSpawner();
		const parser = new PowerShellParser({ spawnServer: fake.spawnServer, idleMs: 1_000, maxRestarts: 0 });
		expect((await parser.parse("a")).ok).toBe(true);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(fake.servers[0].killed).toBe(true);
		fake.servers[0].exit(0);
		expect((await parser.parse("b")).ok).toBe(true);
		expect(fake.servers).toHaveLength(2);
		expect(parser.unavailable()).toBeUndefined();
	});

	it("stop() settles waiting requests and ignores the server's late exit", async () => {
		const fake = fakeSpawner({ answer: () => undefined });
		const parser = new PowerShellParser({ spawnServer: fake.spawnServer, maxRestarts: 0 });
		const outcome = parser.parse("ls");
		await vi.waitFor(() => expect(fake.servers[0].requests).toHaveLength(1));
		parser.stop();
		expect(await outcome).toEqual({ ok: false, reason: "the PowerShell parser was stopped" });
		fake.servers[0].exit(0);
		expect(parser.unavailable()).toBeUndefined();
	});
});

describe("sharedPowerShellParser", () => {
	it("keeps one parser per executable for the whole process", () => {
		const create = vi.fn(() => new PowerShellParser({ spawnServer: fakeSpawner().spawnServer }));
		const a = sharedPowerShellParser("/test/shared/pwsh", create);
		const b = sharedPowerShellParser("/test/shared/pwsh", create);
		const c = sharedPowerShellParser("/test/shared/powershell.exe", create);
		expect(a).toBe(b);
		expect(a).not.toBe(c);
		expect(create).toHaveBeenCalledTimes(2);
	});
});
