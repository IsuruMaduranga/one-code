import { describe, expect, it } from "vitest";
import { LEDGER_VERSION, makeRecord, readRecord, RECORD } from "../../extensions/lib/ledger/records.ts";

const custom = (customType: string, data: unknown, id = "e1") => ({ type: "custom", id, parentId: null, customType, data });

describe("ledger records", () => {
	it("stamps every record with the format version and the writing One Code version", () => {
		const data = makeRecord("state", "0.6.0", { key: "permission-mode", value: "acceptEdits" });
		expect(data).toEqual({ v: LEDGER_VERSION, by: "0.6.0", key: "permission-mode", value: "acceptEdits" });
	});

	it("reads each record kind back from its custom entry", () => {
		const state = makeRecord("state", "0.6.0", { key: "ultracode", value: true });
		expect(readRecord(custom(RECORD.state, state, "s1"))).toEqual({ kind: "state", entryId: "s1", data: state });
		const branch = makeRecord("branch", "0.6.0", { fromLeafId: "x9" });
		expect(readRecord(custom(RECORD.branch, branch))?.kind).toBe("branch");
	});

	it("ignores a record of another format version instead of reading part of it", () => {
		const future = { ...makeRecord("state", "9.0.0", { key: "permission-mode", value: "plan" }), v: LEDGER_VERSION + 1 };
		expect(readRecord(custom(RECORD.state, future))).toBeUndefined();
		const unversioned = { key: "permission-mode", value: "plan", by: "0.5.0" };
		expect(readRecord(custom(RECORD.state, unversioned))).toBeUndefined();
	});

	it("ignores malformed records, other custom entries and non-custom entries", () => {
		expect(readRecord(custom(RECORD.state, { v: LEDGER_VERSION, by: "0.6.0" }))).toBeUndefined();
		expect(readRecord(custom(RECORD.request, { v: LEDGER_VERSION, by: "0.6.0", keep: "x" }))).toBeUndefined();
		expect(readRecord(custom("one-code:context-stack", { version: 1 }))).toBeUndefined();
		expect(readRecord({ type: "message", id: "m1", message: { role: "user" } })).toBeUndefined();
	});

	it("never reads the pre-redesign snapshot entries as records", () => {
		expect(readRecord(custom("one-code:context-state", { version: 1, sticky: [], baselines: {} }))).toBeUndefined();
	});
});
