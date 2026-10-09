import { describe, expect, it, vi } from "vitest";
import { canShowCustomUi, notifyRpcReadOnly } from "../../extensions/lib/headless-output.ts";

describe("canShowCustomUi", () => {
	it("is true only for a TUI session: RPC has UI but no custom components, one-shot modes have no UI", () => {
		expect(canShowCustomUi({ hasUI: true, mode: "tui" })).toBe(true);
		expect(canShowCustomUi({ hasUI: true, mode: "rpc" })).toBe(false);
		expect(canShowCustomUi({ hasUI: false, mode: "print" })).toBe(false);
		expect(canShowCustomUi({ hasUI: false, mode: "json" })).toBe(false);
	});
});

describe("notifyRpcReadOnly", () => {
	it("tells an RPC client the listing is read-only, and says nothing elsewhere", () => {
		const notify = vi.fn();
		notifyRpcReadOnly({ mode: "rpc", ui: { notify } } as never, "/mcp", "reconnect, authenticate, enable or disable servers");
		expect(notify).toHaveBeenCalledWith("/mcp in RPC is read-only; use the TUI to reconnect, authenticate, enable or disable servers.", "info");
		notify.mockClear();
		notifyRpcReadOnly({ mode: "print", ui: { notify } } as never, "/mcp", "manage servers");
		expect(notify).not.toHaveBeenCalled();
	});
});
