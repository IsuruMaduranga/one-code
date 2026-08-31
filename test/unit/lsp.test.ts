import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	filterDiagnostics,
	formatDiagnostic,
	formatDiagnostics,
	type LspDiagnostic,
	severityName,
} from "../../extensions/lsp/format.ts";
import { describeStartFailure, INSTALL_HINTS } from "../../extensions/lsp/install-hints.ts";
import { withKeepAlive } from "../../extensions/lsp/keep-alive.ts";
import { createReaderState, encodeMessage, readMessages } from "../../extensions/lsp/protocol.ts";
import {
	findProjectRoot,
	languageIdForPath,
	serverForPath,
	SERVERS,
	typescriptPreflight,
} from "../../extensions/lsp/servers.ts";

const diag = (message: string, severity = 1, line = 0, character = 0): LspDiagnostic => ({
	range: { start: { line, character } },
	severity,
	message,
});

describe("protocol framing", () => {
	it("round-trips a message", () => {
		const state = createReaderState();
		const messages = readMessages(state, encodeMessage({ method: "test", params: { a: 1 } }));
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({ jsonrpc: "2.0", method: "test", params: { a: 1 } });
	});

	it("reads several messages from one chunk", () => {
		const state = createReaderState();
		const chunk = Buffer.concat([encodeMessage({ method: "a" }), encodeMessage({ method: "b" })]);
		expect(readMessages(state, chunk).map((m) => m.method)).toEqual(["a", "b"]);
	});

	it("buffers a message split across chunks", () => {
		const state = createReaderState();
		const full = encodeMessage({ method: "split", params: { text: "hello world" } });
		const mid = Math.floor(full.length / 2);
		expect(readMessages(state, full.subarray(0, mid))).toEqual([]);
		const messages = readMessages(state, full.subarray(mid));
		expect(messages).toHaveLength(1);
		expect(messages[0].method).toBe("split");
	});

	it("counts Content-Length in bytes, not characters", () => {
		const state = createReaderState();
		const messages = readMessages(state, encodeMessage({ method: "unicode", params: { s: "héllo — ✓" } }));
		expect((messages[0].params as { s: string }).s).toBe("héllo — ✓");
	});

	it("skips an unparseable header and stays aligned", () => {
		const state = createReaderState();
		const chunk = Buffer.concat([Buffer.from("Garbage-Header: x\r\n\r\n"), encodeMessage({ method: "after" })]);
		expect(readMessages(state, chunk).map((m) => m.method)).toEqual(["after"]);
	});

	it("ignores a body that is not JSON without wedging the stream", () => {
		const state = createReaderState();
		const bad = Buffer.from("Content-Length: 3\r\n\r\nnot", "utf-8");
		const chunk = Buffer.concat([bad, encodeMessage({ method: "next" })]);
		expect(readMessages(state, chunk).map((m) => m.method)).toEqual(["next"]);
	});
});

describe("server detection", () => {
	it("maps file extensions to language ids", () => {
		expect(languageIdForPath("a/b.ts")).toBe("typescript");
		expect(languageIdForPath("a/b.tsx")).toBe("typescriptreact");
		expect(languageIdForPath("a/b.py")).toBe("python");
		expect(languageIdForPath("a/b.rs")).toBe("rust");
		expect(languageIdForPath("a/b.txt")).toBeUndefined();
	});

	it("resolves a server config for known languages only", () => {
		expect(serverForPath("x.ts")?.config.command).toBe("typescript-language-server");
		expect(serverForPath("x.go")?.config.args).toEqual(["serve"]);
		expect(serverForPath("x.md")).toBeUndefined();
	});
});

describe("project root and preflight", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "cc-lsp-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("walks up to the nearest marker", () => {
		mkdirSync(join(dir, "pkg", "src"), { recursive: true });
		writeFileSync(join(dir, "pkg", "tsconfig.json"), "{}");
		expect(findProjectRoot(join(dir, "pkg", "src", "a.ts"), ["tsconfig.json"], dir)).toBe(join(dir, "pkg"));
	});

	it("falls back when no marker exists", () => {
		mkdirSync(join(dir, "src"), { recursive: true });
		expect(findProjectRoot(join(dir, "src", "a.ts"), ["nonexistent.json"], dir)).toBe(dir);
	});

	it("flags a local TypeScript without tsserver.js", () => {
		mkdirSync(join(dir, "node_modules", "typescript", "lib"), { recursive: true });
		expect(typescriptPreflight(dir)).toMatch(/tsserver\.js/);
	});

	it("passes when tsserver.js is present or typescript is absent", () => {
		expect(typescriptPreflight(dir)).toBeUndefined();
		mkdirSync(join(dir, "node_modules", "typescript", "lib"), { recursive: true });
		writeFileSync(join(dir, "node_modules", "typescript", "lib", "tsserver.js"), "");
		expect(typescriptPreflight(dir)).toBeUndefined();
	});
});

describe("start-failure install hints", () => {
	const enoent = (command: string) => `Could not start ${command}: spawn ${command} ENOENT`;

	it("rewrites a missing built-in server into its install command", () => {
		expect(describeStartFailure(enoent("pyright-langserver"), "pyright-langserver")).toBe(
			"pyright-langserver is not installed. Install it with: npm install -g pyright",
		);
	});

	it("names the plugin when a plugin configured a known command", () => {
		expect(describeStartFailure(enoent("pyright-langserver"), "pyright-langserver", "pyright")).toBe(
			"pyright-langserver is not installed (configured by the pyright plugin). Install it with: npm install -g pyright",
		);
	});

	it("gives PATH guidance for a plugin command it has no hint for", () => {
		const message = describeStartFailure(enoent("mi-lemminx"), "mi-lemminx", "mi-ls");
		expect(message).toContain("configured by the mi-ls plugin");
		expect(message).toContain("on your PATH");
		expect(message).toContain("plugin's documentation");
	});

	it("reports a vendored absolute path as missing, not uninstalled", () => {
		const command = "/plugins/mi-ls/bin/server";
		expect(describeStartFailure(enoent(command), command, "mi-ls")).toBe(
			"/plugins/mi-ls/bin/server does not exist (configured by the mi-ls plugin). Check the plugin's installation.",
		);
	});

	it("covers every built-in table server with a hint", () => {
		// Iterate the real table so adding a server without its hint fails here.
		const commands = new Set(Object.values(SERVERS).map((config) => config.command));
		expect(commands.size).toBeGreaterThan(0);
		for (const command of commands) {
			expect(INSTALL_HINTS[command], command).toBeTruthy();
			expect(describeStartFailure(enoent(command), command)).toContain(INSTALL_HINTS[command]);
		}
	});

	it("passes non-ENOENT failures through unchanged", () => {
		const crash = "language server stopped unexpectedly";
		expect(describeStartFailure(crash, "pyright-langserver")).toBe(crash);
		const protocolError = "Could not start jdtls: initialize timed out after 10000ms";
		expect(describeStartFailure(protocolError, "jdtls", "java-tools")).toBe(protocolError);
	});
});

describe("diagnostic formatting", () => {
	it("names severities with error as the default", () => {
		expect(severityName(1)).toBe("error");
		expect(severityName(2)).toBe("warning");
		expect(severityName(undefined)).toBe("error");
	});

	it("filters by minimum severity", () => {
		const list = [diag("e", 1), diag("w", 2), diag("i", 3)];
		expect(filterDiagnostics(list, "error").map((d) => d.message)).toEqual(["e"]);
		expect(filterDiagnostics(list, "warning").map((d) => d.message)).toEqual(["e", "w"]);
		expect(filterDiagnostics(list, "all")).toHaveLength(3);
	});

	it("formats one diagnostic with 1-indexed position, code and source", () => {
		const d: LspDiagnostic = {
			range: { start: { line: 4, character: 29 } },
			severity: 1,
			code: 2345,
			source: "typescript",
			message: "Argument of type 'number' is not assignable to parameter of type 'string'.",
		};
		expect(formatDiagnostic("src/index.ts", d)).toBe(
			"src/index.ts:5:30 error: Argument of type 'number' is not assignable to parameter of type 'string'. (2345) [typescript]",
		);
	});

	it("summarises counts and truncates long lists", () => {
		const many = Array.from({ length: 25 }, (_, i) => diag(`e${i}`, 1, i));
		const out = formatDiagnostics("a.ts", many, 10);
		expect(out).toContain("25 errors");
		expect(out).toContain("… 15 more");
		expect(out.split("\n").filter((l) => l.startsWith("a.ts:"))).toHaveLength(10);
	});

	it("reports a clean file", () => {
		expect(formatDiagnostics("a.ts", [])).toBe("No diagnostics.");
	});

	it("counts errors and warnings separately", () => {
		expect(formatDiagnostics("a.ts", [diag("e", 1), diag("w", 2), diag("w2", 2)])).toContain(
			"1 error, 2 warnings",
		);
	});
});

describe("withKeepAlive", () => {
	// The drain can only be observed in a process whose loop is otherwise
	// empty, so these run a bare node child. The awaited promise is backed by
	// nothing but an unref'd timer — the shape of every LspClient await
	// (unref'd child process, pipes, timeout timers).
	// docs/one-shot-lsp-event-loop-drain.md.
	const keepAliveUrl = new URL("../../extensions/lsp/keep-alive.ts", import.meta.url).href;
	const unrefdWork = `
		const work = () => new Promise((resolve) => {
			const timer = setTimeout(() => resolve("settled"), 200);
			timer.unref();
		});
	`;
	const runChild = (body: string) =>
		execFileSync(process.execPath, ["--input-type=module", "-e", `${unrefdWork}\n${body}`], {
			encoding: "utf-8",
			timeout: 15_000,
		});

	it("without it, the loop drains and node exits 0 mid-await (the bug)", () => {
		// .then rather than top-level await: node warns and exits nonzero on an
		// unsettled TLA, but the real await lives inside pi's promise chains,
		// where the drain is a silent exit 0 (execFileSync throws on nonzero,
		// so the clean exit code is asserted implicitly).
		const out = runChild(`console.log("before await");\nwork().then((v) => console.log("after await:", v));`);
		expect(out).toContain("before await");
		expect(out).not.toContain("after await");
	});

	it("holds the process alive until the awaited work settles", () => {
		const out = runChild(
			`const { withKeepAlive } = await import(${JSON.stringify(keepAliveUrl)});\nwithKeepAlive(work).then((v) => console.log("after await:", v));`,
		);
		expect(out).toContain("after await: settled");
	});

	it("returns the work's value and propagates rejections", async () => {
		await expect(withKeepAlive(async () => 42)).resolves.toBe(42);
		await expect(
			withKeepAlive(async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
	});
});
