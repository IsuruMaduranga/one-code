import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	finishAuth: vi.fn(),
	closeTransport: vi.fn(async () => {}),
	closeCallback: vi.fn(),
}));

vi.mock("../../extensions/mcp/client.ts", async (importOriginal) => ({
	...await importOriginal<typeof import("../../extensions/mcp/client.ts")>(),
	beginInteractiveAuth: vi.fn(async () => ({ transport: { finishAuth: mocks.finishAuth, close: mocks.closeTransport } })),
}));
vi.mock("../../extensions/mcp/oauth/callback.ts", () => ({
	startCallbackServer: vi.fn(async () => ({ redirectUrl: "http://127.0.0.1:5000/callback", waitForCode: async () => ({ code: "authorization-code" }), close: mocks.closeCallback })),
}));

import { authenticate } from "../../extensions/mcp/oauth/flow.ts";

afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe("interactive MCP OAuth lifecycle", () => {
	it("times out a hanging token exchange and closes its transport", async () => {
		vi.useFakeTimers();
		mocks.finishAuth.mockImplementation(() => new Promise(() => {}));
		let error: unknown;
		void authenticate({ server: { kind: "http", name: "audit", url: "https://mcp.example.test", source: "test" } }).catch((caught: unknown) => { error = caught; });
		await vi.advanceTimersByTimeAsync(20_001);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("timed out");
		expect(mocks.closeTransport).toHaveBeenCalled();
		expect(mocks.closeCallback).toHaveBeenCalledOnce();
	});

	it("closes its transport when the token exchange fails", async () => {
		mocks.finishAuth.mockRejectedValue(new Error("invalid authorization code"));
		await expect(authenticate({ server: { kind: "http", name: "audit", url: "https://mcp.example.test", source: "test" } })).rejects.toThrow("invalid authorization code");
		expect(mocks.closeTransport).toHaveBeenCalled();
		expect(mocks.closeCallback).toHaveBeenCalledOnce();
	});
});
