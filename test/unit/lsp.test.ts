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
import { createReaderState, encodeMessage, readMessages } from "../../extensions/lsp/protocol.ts";
import {
	findProjectRoot,
	languageIdForPath,
	serverForPath,
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
