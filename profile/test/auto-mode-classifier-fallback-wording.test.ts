/** One Code's words for a call the classifier could not judge. */
import { describe, expect, it } from "vitest";
import { requireText } from "../../extensions/lib/profile.ts";

const block = (b: Parameters<ReturnType<typeof requireText<"autoMode">>["classifierBlock"]>[0]) => requireText("autoMode").classifierBlock(b);

describe("classifier block wording", () => {
	it("words a provider error as no verdict, and a truncated reply by its output limit", () => {
		expect(block({ kind: "providerError", summary: "500 internal server error" })).toContain("returned no verdict");
		expect(block({ kind: "truncated" })).toContain("output limit");
	});

	it("names the tool and the model on a timeout, never as a provider error", () => {
		const reason = block({ kind: "unavailable", tool: "bash", model: "gpt-5.1-mini" });
		expect(reason).toContain("in time");
		expect(reason).toContain("bash");
		expect(reason).toContain("temporarily unavailable");
		expect(reason).not.toContain("returned no verdict");
		const network = block({ kind: "unavailable", tool: "bash", model: "gpt-5.1-mini", networkError: "fetch failed" });
		expect(network).toContain("temporarily unavailable (network error: fetch failed)");
		expect(network).not.toContain("returned no verdict");
	});

	it("names an action's size and asks to split it", () => {
		expect(block({ kind: "actionTooLong", chars: 100_012, max: 100_000 })).toMatch(/characters.*Split it/);
	});

	it("words a refusal stop without the provider's advice, naming any other model's own error", () => {
		const refused = block({ kind: "noClassifierLeft", refused: ["openai/gpt-5.1-mini"], unusable: [] });
		expect(refused).toBe("Auto mode has no classifier: openai/gpt-5.1-mini refused the classifier's prompt as a possible usage-policy violation.");
		expect(refused).not.toMatch(/try again|different prompt/i);
		const both = block({
			kind: "noClassifierLeft",
			refused: ["openai/gpt-5-mini"],
			unusable: [{ model: "openai/gpt-5.1-mini", error: "The 'gpt-5.1-mini' model is not supported when using Codex with a ChatGPT account." }],
		});
		expect(both).toMatch(/^Auto mode has no classifier: openai\/gpt-5-mini refused/);
		expect(both).toContain("cannot be used (");
		expect(both).toContain("not supported when using Codex");
	});
});
