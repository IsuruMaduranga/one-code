import { afterEach, describe, expect, it, vi } from "vitest";
import { close, type Connection } from "../../extensions/tools/mcp/client.ts";
import { STDIO_CLOSE_MAX_MS } from "../../extensions/tools/mcp/stdio-transport.ts";

afterEach(() => vi.useRealTimers());

// A stubborn stdio server's transport takes its stdin grace, then its TERM
// grace, to close (stdio-transport.ts); the client's close must outwait both,
// or it abandons the server in the middle of its escalation.
describe("closing an MCP connection", () => {
	it("waits out the longest a stdio transport's close takes", async () => {
		vi.useFakeTimers();
		let closed = false;
		const connection = {
			server: { name: "stubborn" },
			client: { close: () => new Promise<void>((resolve) => setTimeout(() => ((closed = true), resolve()), STDIO_CLOSE_MAX_MS)) },
		} as unknown as Connection;
		let settled = false;
		const closing = close(connection).then(() => (settled = true));
		await vi.advanceTimersByTimeAsync(STDIO_CLOSE_MAX_MS - 1);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await closing;
		expect(closed).toBe(true);
		expect(connection.closing).toBe(true);
	});
});
