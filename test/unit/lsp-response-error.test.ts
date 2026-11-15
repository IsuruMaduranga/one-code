/**
 * A server's refusal of a request (tools/lsp/failure.ts `LspResponseError`,
 * `lspErrorDetail`): the client keeps the JSON-RPC code and data beside the
 * message, and a product extension reads them by shape, since its copy of
 * the module is not the one the client threw from. The start-failure words
 * built from the message do not change.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LspClient } from "../../extensions/tools/lsp/client.ts";
import { failureOf, isMethodNotFound, LspFailureError, LspResponseError, lspErrorDetail } from "../../extensions/tools/lsp/failure.ts";
import { RECORDING_SERVER } from "./helpers/recording-lsp-server.ts";

describe("a server's refusal of a request", () => {
	let dir: string;
	let client: LspClient;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "lsp-refuse-"));
		client = new LspClient({ command: process.execPath, args: ["-e", RECORDING_SERVER] }, dir);
		await client.start();
	});
	afterEach(async () => {
		await client.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	it("keeps the JSON-RPC code and data beside the message", async () => {
		const error = await client.request("test/refuse", {}).then(
			() => undefined,
			(rejection: unknown) => rejection,
		);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("Internal error.");
		expect(lspErrorDetail(error)).toEqual({ method: "test/refuse", code: -32601, message: "Internal error.", data: { detail: "Unsupported request: test/refuse" } });
		// Worded as before where a start failure shows it: the server's message only.
		expect(failureOf(error)).toEqual({ kind: "error", osMessage: "Internal error." });
	});
});

describe("lspErrorDetail", () => {
	it("reads another module copy's error by its shape", () => {
		const copy = Object.assign(new Error("Unhandled method x/y"), { name: "LspResponseError", method: "x/y", code: -32601 });
		expect(lspErrorDetail(copy)).toEqual({ method: "x/y", code: -32601, message: "Unhandled method x/y" });
	});

	it("is undefined for anything that is not a server's refusal", () => {
		expect(lspErrorDetail(new Error("x"))).toBeUndefined();
		expect(lspErrorDetail(new LspFailureError({ kind: "timedOut", method: "x/y", ms: 10 }))).toBeUndefined();
		expect(lspErrorDetail(Object.assign(new Error("x"), { name: "LspResponseError" }))).toBeUndefined();
		expect(lspErrorDetail("Internal error.")).toBeUndefined();
	});
});

describe("isMethodNotFound", () => {
	const lsp4j = (method: string, data: unknown) => ({ method, code: -32603, message: "Internal error.", data });
	const unknown = (method: string) => `java.lang.UnsupportedOperationException: The json request '${method}' is unknown.\n\tat org.eclipse.lsp4j.jsonrpc.services.GenericEndpoint.request(GenericEndpoint.java:101)`;

	it("is true for JSON-RPC's method-not-found code", () => {
		expect(isMethodNotFound({ method: "x/y", code: -32601, message: "Unhandled method x/y" })).toBe(true);
	});

	it("is true for lsp4j's internal error that names the method asked", () => {
		expect(isMethodNotFound(lsp4j("x/y", unknown("x/y")))).toBe(true);
		// The data may arrive as an object around the same text.
		expect(isMethodNotFound(lsp4j("x/y", { detail: unknown("x/y") }))).toBe(true);
	});

	it("is false when lsp4j names another method", () => {
		expect(isMethodNotFound(lsp4j("x/y", unknown("x/other")))).toBe(false);
	});

	it("is false for any other failure", () => {
		expect(isMethodNotFound(lsp4j("x/y", "java.lang.NullPointerException"))).toBe(false);
		expect(isMethodNotFound({ method: "x/y", code: -32603, message: "Internal error." })).toBe(false);
		expect(isMethodNotFound({ method: "x/y", code: -32602, message: "Invalid params", data: unknown("x/y") })).toBe(false);
	});

	it("reads an error through lspErrorDetail", () => {
		const error = new LspResponseError("x/y", -32603, "Internal error.", unknown("x/y"));
		expect(isMethodNotFound(lspErrorDetail(error)!)).toBe(true);
	});
});
