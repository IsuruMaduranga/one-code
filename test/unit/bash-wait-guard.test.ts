import { describe, expect, it } from "vitest";
import { foregroundWaitReason } from "../../extensions/bash/wait-guard.ts";

describe("foregroundWaitReason", () => {
	it("blocks a bare top-level sleep", () => {
		expect(foregroundWaitReason("sleep 60")).toBeDefined();
		expect(foregroundWaitReason("sleep 0.5")).toBeDefined();
	});

	it("blocks a sleep leading a poll chain (&&, ;)", () => {
		// The exact pattern the guard exists to stop — wait, then check.
		expect(foregroundWaitReason("sleep 60 && curl localhost:3000/health")).toBeDefined();
		expect(foregroundWaitReason("sleep 5; cat out.log")).toBeDefined();
	});

	it("leaves a brief sleep INSIDE a larger command alone", () => {
		expect(foregroundWaitReason("npm run build && sleep 2 && npm run smoke")).toBeUndefined();
		expect(foregroundWaitReason("echo start && sleep 1")).toBeUndefined();
	});

	it("does not block commands that merely mention sleep", () => {
		expect(foregroundWaitReason("grep sleep app.log")).toBeUndefined();
		expect(foregroundWaitReason("./sleepy-server --start")).toBeUndefined();
		expect(foregroundWaitReason("cat notes.txt")).toBeUndefined();
	});

	it("lets an unparseable command through (the gate/classifier still applies)", () => {
		// A quote it cannot balance must not throw or hard-block here.
		expect(() => foregroundWaitReason('sleep "unterminated')).not.toThrow();
	});

	it("names the alternatives in its message", () => {
		const reason = foregroundWaitReason("sleep 30") ?? "";
		expect(reason).toContain("run_in_background");
		expect(reason).toContain("monitor");
	});
});
