import { describe, expect, it } from "vitest";
import { BackgroundRegistry, type BackgroundTask, generateTaskId } from "../../extensions/background/registry.ts";
import { buildWakeupMessage, clampDelaySeconds, describeSchedule } from "../../extensions/background/wakeup.ts";

function makeTask(id: string, status: BackgroundTask["status"] = "running"): BackgroundTask & { stopped: boolean } {
	const task = {
		id,
		kind: "monitor",
		description: `task ${id}`,
		status,
		startedAt: Date.now(),
		stopped: false,
		output: () => "",
		stop() {
			task.stopped = true;
		},
		finished: Promise.resolve(),
	};
	return task;
}

describe("BackgroundRegistry", () => {
	it("resolves by exact id and by unique prefix", () => {
		const registry = new BackgroundRegistry();
		registry.register(makeTask("b1234567"));
		registry.register(makeTask("b1239999"));
		expect(registry.get("b1234567")?.id).toBe("b1234567");
		expect(registry.get("b1234")?.id).toBe("b1234567");
		expect(registry.get("b123")).toBeUndefined(); // ambiguous
		expect(registry.get("nope")).toBeUndefined();
	});

	it("stopAll stops only running tasks and survives a throwing stop", () => {
		const registry = new BackgroundRegistry();
		const running = makeTask("b0000001");
		const done = makeTask("b0000002", "completed");
		const bad = makeTask("b0000003");
		bad.stop = () => {
			throw new Error("boom");
		};
		registry.register(running);
		registry.register(done);
		registry.register(bad);
		registry.stopAll();
		expect(running.stopped).toBe(true);
		expect(done.stopped).toBe(false);
	});

	it("generates b-prefixed short ids", () => {
		expect(generateTaskId()).toMatch(/^b[0-9a-f]{7}$/);
	});
});

describe("schedule_wakeup helpers", () => {
	it("clamps the delay to [60, 3600]", () => {
		expect(clampDelaySeconds(5)).toBe(60);
		expect(clampDelaySeconds(600)).toBe(600);
		expect(clampDelaySeconds(999999)).toBe(3600);
		expect(clampDelaySeconds(Number.NaN)).toBe(60);
	});

	it("frames the fired message as a system notification carrying the prompt", () => {
		const message = buildWakeupMessage({ delaySeconds: 120, prompt: "check the deploy", reason: "deploy takes ~2min" });
		expect(message).toContain("SYSTEM NOTIFICATION — NOT USER INPUT");
		expect(message).toContain("check the deploy");
		expect(message).toContain("deploy takes ~2min");
	});

	it("says so when the requested delay was clamped", () => {
		expect(describeSchedule({ delaySeconds: 5, prompt: "p", reason: "r" })).toContain("adjusted from 5s");
		expect(describeSchedule({ delaySeconds: 999999, prompt: "p", reason: "r" })).toContain("adjusted from 999999s");
		expect(describeSchedule({ delaySeconds: 600, prompt: "p", reason: "r" })).not.toContain("adjusted");
	});
});

describe("systemNotification framing", () => {
	it("carries the anti-confabulation preamble before the body", async () => {
		const { systemNotification } = await import("../../extensions/lib/notifications.ts");
		const text = systemNotification("Background bash b1 completed.");
		expect(text.startsWith("SYSTEM NOTIFICATION — NOT USER INPUT")).toBe(true);
		expect(text).toContain("not a message from the user");
		expect(text).toContain("acknowledgement, confirmation, or approval");
		expect(text.endsWith("Background bash b1 completed.")).toBe(true);
	});
});
