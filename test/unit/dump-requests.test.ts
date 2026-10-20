import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import dump from "../e2e/dump-requests.ts";

describe("dump-requests", () => {
	const originalFetch = globalThis.fetch;
	const originalWireDump = process.env.WIRE_DUMP;
	const originalMeta = process.env.WIRE_DUMP_META;
	/** A pi stand-in that keeps its `before_provider_request` handlers, so a test can fire them. */
	const fakePi = () => {
		const hooks: Array<() => void> = [];
		return { pi: { on: (_event: string, handler: () => void) => hooks.push(handler) } as never, fire: () => hooks.forEach((hook) => hook()) };
	};
	let directory: string | undefined;

	afterEach(() => {
		globalThis.fetch = originalFetch;
		if (originalWireDump === undefined) delete process.env.WIRE_DUMP;
		else process.env.WIRE_DUMP = originalWireDump;
		if (originalMeta === undefined) delete process.env.WIRE_DUMP_META;
		else process.env.WIRE_DUMP_META = originalMeta;
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
		dump(fakePi().pi);
		await globalThis.fetch("https://example.invalid/backend-api/codex/responses", {
			method: "POST",
			headers: { "content-encoding": "zstd" },
			body: foreignBytes,
		});

		expect(sent).toHaveBeenCalledOnce();
		expect(readFileSync(wire, "utf8")).toBe(`${request}\n`);
	});

	it("tags session requests in the meta file and wraps fetch once across a reload", async () => {
		directory = mkdtempSync(join(process.cwd(), ".dump-requests-"));
		const wire = join(directory, "wire.jsonl");
		const meta = join(directory, "wire.meta.jsonl");
		process.env.WIRE_DUMP = wire;
		process.env.WIRE_DUMP_META = meta;
		globalThis.fetch = vi.fn(async () => new Response());
		const first = fakePi();
		dump(first.pi);
		// A /reload runs the factory again in the same process.
		const second = fakePi();
		dump(second.pi);
		const body = (text: string) => ({ method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: text }] }) });
		second.fire();
		await globalThis.fetch("https://example.invalid/v1/messages", body("session"));
		await globalThis.fetch("https://example.invalid/v1/messages", body("side call"));

		expect(readFileSync(wire, "utf8").trim().split("\n")).toHaveLength(2);
		const tags = readFileSync(meta, "utf8").trim().split("\n").map((line) => JSON.parse(line).session);
		expect(tags).toEqual([true, false]);
	});
});
