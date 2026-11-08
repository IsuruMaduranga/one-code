/** One Code's words when the classifier's transcript outgrows its window. */
import { describe, expect, it } from "vitest";
import { requireText } from "../../extensions/lib/profile.ts";

describe("classifier context overflow wording", () => {
	it("names the overflow and the way on", () => {
		const reason = requireText("autoMode").classifierBlock({ kind: "transcriptTooLong", model: "openai-codex/gpt-6-sol" });
		expect(reason).toContain("Classifier transcript exceeded context window");
		expect(reason).toContain("Compact the session (/compact) and continue.");
		expect(reason).not.toContain("choose a classifier");
	});
});
