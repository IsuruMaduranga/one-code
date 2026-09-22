import { describe, expect, it } from "vitest";
import { QueuedDelivery } from "../../extensions/lib/queued-delivery.ts";

describe("QueuedDelivery", () => {
	it("releases each payload once, oldest first for a repeated text, and clears", () => {
		const held = new QueuedDelivery<string>();
		expect(held.isEmpty).toBe(true);
		held.hold("same", "first");
		held.hold("other", "x");
		held.hold("same", "second");
		expect(held.release("missing")).toBeUndefined();
		expect(held.release("same")).toBe("first");
		expect(held.release("same")).toBe("second");
		expect(held.release("same")).toBeUndefined();
		expect(held.isEmpty).toBe(false);
		held.clear();
		expect(held.isEmpty).toBe(true);
	});
});
