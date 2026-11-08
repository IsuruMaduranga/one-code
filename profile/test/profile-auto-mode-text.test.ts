/**
 * One Code's auto-mode wording (profile/text/auto-mode/) where the golden
 * snapshot cannot reach it: the firmer note, the retry note, the classifier
 * reasons a fixture cannot provoke, and the floor's pattern and catalog
 * wording. The golden snapshot pins the note, three classifier verdicts and
 * the floor's block of a settings write.
 */
import { describe, expect, it } from "vitest";
import { autoModeText } from "../../profile/text/auto-mode/index.ts";
import { ALL_LIVE } from "./helpers/live.ts";

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
