import { describe, expect, it } from "vitest";
import { actionsFor, type McpEntry, statusText } from "../../extensions/mcp/panel/model.ts";
import { applyMcpKey, initialMcpState, type McpPanelState } from "../../extensions/mcp/panel/state.ts";
import { decodeMcpKey } from "../../extensions/mcp/panel/keys.ts";

function entry(overrides: Partial<McpEntry>): McpEntry {
	return {
		name: "srv",
		group: "User MCPs (~/.claude.json)",
		status: "connected",
		configLocation: "~/.claude.json",
		canAuthenticate: false,
		...overrides,
	};
}

describe("actionsFor", () => {
	it("connected/failed servers offer Reconnect + Disable", () => {
		expect(actionsFor(entry({ status: "connected" })).map((a) => a.key)).toEqual(["reconnect", "disable"]);
		expect(actionsFor(entry({ status: "failed" })).map((a) => a.key)).toEqual(["reconnect", "disable"]);
	});

	it("an OAuth-capable needs-auth server offers Authenticate + Disable", () => {
		const actions = actionsFor(entry({ status: "authNeeded", canAuthenticate: true }));
		expect(actions.map((a) => a.key)).toEqual(["authenticate", "disable"]);
		expect(actions[0].label).toBe("Authenticate");
	});

	it("an env-missing needs-auth server falls back to Reconnect (Authenticate can't help)", () => {
		expect(actionsFor(entry({ status: "authNeeded", canAuthenticate: false })).map((a) => a.key)).toEqual([
			"reconnect",
			"disable",
		]);
	});

	it("a disabled server offers only Enable", () => {
		expect(actionsFor(entry({ status: "disabled" })).map((a) => a.key)).toEqual(["enable"]);
	});
});

describe("statusText", () => {
	it("maps each status to a width-1 glyph", () => {
		for (const status of ["connected", "failed", "authNeeded", "connecting", "disabled"] as const) {
			const { glyph } = statusText(entry({ status }));
			expect([...glyph]).toHaveLength(1);
		}
	});
});

describe("decodeMcpKey", () => {
	it("decodes arrows, enter, esc, and digits", () => {
		expect(decodeMcpKey("\x1b[A")).toEqual({ kind: "up" });
		expect(decodeMcpKey("\x1b[B")).toEqual({ kind: "down" });
		expect(decodeMcpKey("\r")).toEqual({ kind: "enter" });
		expect(decodeMcpKey("\x1b")).toEqual({ kind: "back" });
		expect(decodeMcpKey("2")).toEqual({ kind: "digit", value: 2 });
		expect(decodeMcpKey("x")).toBeUndefined();
	});
});

describe("applyMcpKey — list view", () => {
	const entries = [entry({ name: "a" }), entry({ name: "b" }), entry({ name: "c" })];

	it("moves the cursor within bounds", () => {
		const state = initialMcpState();
		applyMcpKey(state, { kind: "down" }, entries);
		applyMcpKey(state, { kind: "down" }, entries);
		applyMcpKey(state, { kind: "down" }, entries); // clamped at last
		expect(state.cursor).toBe(2);
		applyMcpKey(state, { kind: "up" }, entries);
		expect(state.cursor).toBe(1);
	});

	it("Enter opens the detail view for the selected server", () => {
		const state = initialMcpState();
		applyMcpKey(state, { kind: "down" }, entries);
		applyMcpKey(state, { kind: "enter" }, entries);
		expect(state.detail).toEqual({ name: "b", actionCursor: 0 });
	});

	it("Esc closes the panel from the list", () => {
		expect(applyMcpKey(initialMcpState(), { kind: "back" }, entries)).toEqual({ kind: "close" });
	});
});

describe("applyMcpKey — detail view", () => {
	const entries = [entry({ name: "a", status: "failed" })];
	const inDetail = (): McpPanelState => ({ cursor: 0, detail: { name: "a", actionCursor: 0 } });

	it("Enter on the first action of a failed server reconnects", () => {
		const effect = applyMcpKey(inDetail(), { kind: "enter" }, entries);
		expect(effect).toMatchObject({ kind: "reconnect", entry: { name: "a" } });
	});

	it("digit selects an action directly", () => {
		expect(applyMcpKey(inDetail(), { kind: "digit", value: 2 }, entries)).toMatchObject({ kind: "disable" });
	});

	it("down then Enter selects the second action", () => {
		const state = inDetail();
		applyMcpKey(state, { kind: "down" }, entries);
		expect(state.detail?.actionCursor).toBe(1);
		expect(applyMcpKey(state, { kind: "enter" }, entries)).toMatchObject({ kind: "disable" });
	});

	it("Authenticate is emitted for an OAuth-capable server", () => {
		const authEntries = [entry({ name: "a", status: "authNeeded", canAuthenticate: true })];
		expect(applyMcpKey(inDetail(), { kind: "enter" }, authEntries)).toMatchObject({ kind: "authenticate" });
	});

	it("Esc returns to the list, not close", () => {
		const state = inDetail();
		expect(applyMcpKey(state, { kind: "back" }, entries)).toBeUndefined();
		expect(state.detail).toBeUndefined();
	});

	it("a vanished server drops back to the list on Esc", () => {
		const state = inDetail();
		expect(applyMcpKey(state, { kind: "back" }, [])).toBeUndefined();
		expect(state.detail).toBeUndefined();
	});
});
