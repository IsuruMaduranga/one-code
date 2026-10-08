import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import dump from "../e2e/dump-requests.ts";

describe("dump-requests", () => {
	const originalFetch = globalThis.fetch;
	const originalWireDump = process.env.WIRE_DUMP;
	let directory: string | undefined;

	afterEach(() => {
		globalThis.fetch = originalFetch;
		if (originalWireDump === undefined) delete process.env.WIRE_DUMP;
		else process.env.WIRE_DUMP = originalWireDump;
		if (directory) rmSync(directory, { recursive: true, force: true });
		directory = undefined;
	});

	it("records a zstd Codex body whose Uint8Array came from the provider VM", async () => {
		directory = mkdtempSync(join(process.cwd(), ".dump-requests-"));
		const wire = join(directory, "wire.jsonl");
		process.env.WIRE_DUMP = wire;
		const request = JSON.stringify({ input: [{ role: "user", content: "final provider payload" }] });
		const foreignBytes = runInNewContext("new Uint8Array(compressed)", {
			compressed: zstdCompressSync(request),
		});
		expect(foreignBytes instanceof Uint8Array).toBe(false);
		expect(ArrayBuffer.isView(foreignBytes)).toBe(true);

		const sent = vi.fn(async () => new Response());
		globalThis.fetch = sent;
		dump({} as never);
		await globalThis.fetch("https://example.invalid/backend-api/codex/responses", {
			method: "POST",
			headers: { "content-encoding": "zstd" },
			body: foreignBytes,
		});

		expect(sent).toHaveBeenCalledOnce();
		expect(readFileSync(wire, "utf8")).toBe(`${request}\n`);
	});
});
