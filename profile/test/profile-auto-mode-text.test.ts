/**
 * One Code's auto-mode wording (profile/text/auto-mode/) where the golden
 * snapshot cannot reach it: both wordings of the system note, the retry note,
 * the classifier reasons a fixture cannot provoke (a provider error, a
 * timeout, an action too long, a refusal stop, a transcript that outgrew the
 * window), the floor's pattern, catalog and permission-file wording, and the
 * setup prompt. The golden snapshot pins the note, three classifier verdicts
 * and the floor's block of a settings write.
 */
import { describe, expect, it } from "vitest";
import { requireText } from "../../extensions/lib/profile.ts";
import { autoModeText } from "../text/auto-mode/index.ts";
import { ALL_LIVE } from "../../test/unit/helpers/live.ts";

const autoMode = autoModeText(ALL_LIVE);

describe("One Code's auto-mode text", () => {
	it("gives the firmer note only when asked", () => {
		expect(autoMode.systemNote({ firm: true })).toContain("Fall back to a dedicated tool only when bash genuinely cannot do the job.");
		expect(autoMode.systemNote({ firm: false })).toContain("The choice is yours");
	});

	it("words the retry note for one call and for several", () => {
		expect(autoMode.permissionGranted({ displays: ["bash(ls)"] })).toBe("Permission granted for: bash(ls). You may now retry this command if you would like.");
		expect(autoMode.permissionGranted({ displays: ["a", "b"] })).toContain("retry these commands");
	});

	it("names the classifiers that could not be used", () => {
		expect(autoMode.classifierBlock({ kind: "noClassifierLeft", refused: ["a/x"], unusable: [{ model: "b/y", error: "401" }] })).toBe(
			"Auto mode has no classifier: a/x refused the classifier's prompt as a possible usage-policy violation. b/y cannot be used (401).",
		);
		expect(autoMode.classifierBlock({ kind: "unavailable", tool: "bash", model: "m", networkError: "ECONNRESET" })).toBe(
			"Auto mode could not screen this bash call — the approval classifier (m) is temporarily unavailable (network error: ECONNRESET), so the call was not judged either way.",
		);
		expect(autoMode.classifierBlock({ kind: "unavailable", tool: "bash" })).toContain("this bash call in time — the approval classifier is temporarily unavailable (timed out)");
		expect(autoMode.classifierBlock({ kind: "actionTooLong", chars: 90000, max: 80000 })).toContain("Split it into smaller calls.");
	});

	it("words the floor's pattern and catalog reasons", () => {
		const pattern = autoMode.floorBlock({ kind: "pattern", token: "./node_modules/*" });
		expect(pattern).toContain("its pattern ./node_modules/* can select a file");
		expect(pattern).toContain("rewrite it without the wildcard or negated pattern");
		expect(autoMode.floorReason({ kind: "catalog", token: "models-dev.json" })).toContain("a model catalog that decides the model tier");
	});
});

describe("auto mode system note wording", () => {
	it("gives the firm and the plain wording, naming One Code's tools", () => {
		const { systemNote } = requireText("autoMode");
		const firm = systemNote({ firm: true });
		const plain = systemNote({ firm: false });
		expect(firm.startsWith("While auto mode is active:\n\nDo your work through the bash tool wherever it can accomplish the job")).toBe(true);
		expect(plain.startsWith("While auto mode is active:\n\nYou can do much of your work through the bash tool when it is the simpler route")).toBe(true);
		for (const note of [firm, plain]) expect(note).not.toMatch(/\b(Bash|Read|Edit|Write) tool/);
	});
});

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

	it("names the overflow when the classifier's transcript outgrows its window, and the way on", () => {
		const reason = block({ kind: "transcriptTooLong", model: "openai-codex/gpt-6-sol" });
		expect(reason).toContain("Classifier transcript exceeded context window");
		expect(reason).toContain("Compact the session (/compact) and continue.");
		expect(reason).not.toContain("choose a classifier");
	});
});

describe("consent store floor wording", () => {
	it("says a file that grants permissions holds permission rules", () => {
		expect(requireText("autoMode").floorReason({ kind: "control", token: "/home/u/.onecode/hooks/project-approvals.json" })).toContain("permission rules");
	});
});

describe("auto mode setup prompt wording", () => {
	it("demands strict JSON and says the lists append", () => {
		const { system } = requireText("autoModeSetup");
		expect(system).toContain("ONLY a JSON object");
		expect(system).toContain("append-only");
	});
});
