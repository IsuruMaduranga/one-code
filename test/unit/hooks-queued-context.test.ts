import { describe, expect, it } from "vitest";
import { messageText, QueuedPromptContext } from "../../extensions/hooks/queued-context.ts";

describe("hooks queued-context", () => {
	it("reads a message's text the way pi compares queued messages", () => {
		expect(messageText("plain")).toBe("plain");
		expect(
			messageText([
				{ type: "text", text: "a" },
				{ type: "image", data: "x", mimeType: "image/png" },
				{ type: "text", text: "b" },
			]),
		).toBe("ab");
		expect(messageText(undefined)).toBe("");
	});

	it("takes each context once, oldest first for a repeated text", () => {
		const queue = new QueuedPromptContext();
		queue.add("same", "first");
		queue.add("other", "x");
		queue.add("same", "second");
		expect(queue.take("missing")).toBeUndefined();
		expect(queue.take("same")).toBe("first");
		expect(queue.take("same")).toBe("second");
		expect(queue.take("same")).toBeUndefined();
		expect(queue.size).toBe(1);
		queue.clear();
		expect(queue.size).toBe(0);
	});
});
