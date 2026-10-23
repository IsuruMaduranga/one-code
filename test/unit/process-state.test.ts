import { describe, expect, it, vi } from "vitest";
import { processState, resetProcessStateForTest, setProcessState } from "../../extensions/lib/process-state.ts";

describe("process state", () => {
	it("is created once per key and shared by every caller in the process", () => {
		resetProcessStateForTest();
		const grants = processState("test:grants", () => new Set<string>());
		grants.add("bash:npm test");
		expect(processState("test:grants", () => new Set<string>())).toBe(grants);
		setProcessState("test:grants", new Set(["other"]));
		expect([...processState("test:grants", () => new Set<string>())]).toEqual(["other"]);
	});

	it("survives a module being evaluated again (pi's /reload): the store lives on globalThis", async () => {
		resetProcessStateForTest();
		processState("test:notice", () => ({ text: "stopped 2 tasks" }));
		vi.resetModules();
		const fresh = await import("../../extensions/lib/process-state.ts");
		expect(fresh.processState("test:notice", () => ({ text: "" }))).toEqual({ text: "stopped 2 tasks" });
	});
});
