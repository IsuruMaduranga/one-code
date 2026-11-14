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
import { failureOf, LspFailureError, lspErrorDetail } from "../../extensions/tools/lsp/failure.ts";
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
