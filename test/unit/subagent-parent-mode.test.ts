/**
 * A fork is told the parent's permission mode when it changes from what the
 * fork's history shows (lifecycle-grid-hunt round 3, R3-L15).
 */
import { describe, expect, it } from "vitest";
import { makeRecord, RECORD } from "../../extensions/lib/ledger/records.ts";
import { parentModeExtension } from "../../extensions/subagents/parent-mode.ts";
import { createFakeCtx, createFakePi, renderRequest } from "./helpers/fake-pi.ts";

const modeEntry = (mode: string) => ({ type: "custom", id: "m", parentId: null, customType: RECORD.state, data: makeRecord("state", "test", { key: "permission-mode", value: mode }) });

describe("a fork's parent mode", () => {
	it("says nothing while the parent's mode is the one the fork inherited, and says a change once", async () => {
		let mode = "auto";
		const fake = createFakePi();
		parentModeExtension(() => mode)(fake.pi as never);
		await fake.fire("session_start", {}, createFakeCtx({ sessionManager: { getBranch: () => [modeEntry("auto")] } }));
		expect(renderRequest(fake.events)).toEqual([]);
		mode = "plan";
		const blocks = renderRequest(fake.events);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].text).toContain('permission mode is now "plan"');
		expect(renderRequest(fake.events, { facts: blocks[0].facts })).toEqual([]);
	});
});
