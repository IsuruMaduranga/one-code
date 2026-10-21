/**
 * A fork is told the parent's permission mode when it changes from what the
 * fork's history shows (lifecycle-grid-hunt round 3, R3-L15).
 */
import { describe, expect, it } from "vitest";
import { PERMISSION_MODE_STATE } from "../../extensions/permissions/modes.ts";
import { parentModeExtension } from "../../extensions/subagents/parent-mode.ts";
import { createFakeCtx, createFakePi, renderRequest } from "./helpers/fake-pi.ts";
import { stateEntry } from "./helpers/state-entry.ts";

describe("a fork's parent mode", () => {
	it("says nothing while the parent's mode is the one the fork inherited, and says a change once", async () => {
		let mode = "auto";
		const fake = createFakePi();
		parentModeExtension(() => mode)(fake.pi as never);
		await fake.fire("session_start", {}, createFakeCtx({ sessionManager: { getBranch: () => [stateEntry(PERMISSION_MODE_STATE, "auto")] } }));
		expect(renderRequest(fake.events)).toEqual([]);
		mode = "plan";
		const blocks = renderRequest(fake.events);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].text).toContain('permission mode is now "plan"');
		expect(renderRequest(fake.events, { facts: blocks[0].facts })).toEqual([]);
	});

	it("tells the live mode on an epoch, whose history no longer shows the mode inherited at spawn", async () => {
		let mode = "auto";
		const fake = createFakePi();
		parentModeExtension(() => mode)(fake.pi as never);
		await fake.fire("session_start", {}, createFakeCtx({ sessionManager: { getBranch: () => [stateEntry(PERMISSION_MODE_STATE, "auto")] } }));
		mode = "plan";
		expect(renderRequest(fake.events)).toHaveLength(1);
		// Back to the spawn mode, then a compaction: the summary may still say plan.
		mode = "auto";
		const blocks = renderRequest(fake.events, { epoch: true });
		expect(blocks).toHaveLength(1);
		expect(blocks[0].text).toContain('permission mode is now "auto"');
		expect(renderRequest(fake.events, { facts: blocks[0].facts })).toEqual([]);
	});
});
