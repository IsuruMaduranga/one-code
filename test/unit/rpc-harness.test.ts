/**
 * The offline e2e harness's RPC client (test/e2e/lib/harness.mjs rpcClient):
 * it reads pi's JSONL events from the child's stdout.
 */
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { rpcClient } from "../e2e/lib/harness.mjs";

describe("rpcClient", () => {
	it("keeps a UTF-8 character whole when stdout splits it across two chunks", async () => {
		const stdout = new PassThrough();
		const client = rpcClient({ stdout, stdin: new PassThrough() });
		const event = client.waitFor((e) => e.type === "probe", 2_000);
		const line = Buffer.from(`${JSON.stringify({ type: "probe", title: "café" })}\n`, "utf8");
		const cut = line.indexOf(0xa9); // the second byte of "é" (C3 A9)
		stdout.write(line.subarray(0, cut));
		stdout.write(line.subarray(cut));
		expect((await event).title).toBe("café");
	});
});
