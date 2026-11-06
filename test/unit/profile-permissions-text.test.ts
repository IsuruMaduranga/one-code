/**
 * One Code's permission-gate wording (profile/permissions/) where the golden
 * snapshot cannot reach it: the dontAsk and outside-read refusals, the
 * classifier's timeout, the stops and the in-process child gate. The golden
 * snapshot pins the non-interactive, plan-mode, deny-rule and conflicting-path
 * refusals, the classifier's denial and no-verdict blocks, the mode-change
 * announcement and auto mode's standing note.
 */
import { describe, expect, it } from "vitest";
import { permissionsText } from "../../profile/permissions/index.ts";
import { ALL_LIVE } from "./helpers/live.ts";

const permissions = permissionsText(ALL_LIVE);

describe("One Code's permission-gate text", () => {
	it("words each refusal a fixture cannot provoke", () => {
		expect(permissions.refused({ kind: "dontAsk" })).toMatch(/^Permission mode is dontAsk/);
		expect(permissions.refused({ kind: "outsideWorkingDir" })).toContain("e.g. Read(~/dir/**)");
		expect(permissions.refused({ kind: "outsideReadsBlocked" })).toContain("the permissions.blockReadsOutsideWorkingDirectories setting blocks reads");
		expect(permissions.refused({ kind: "userBlockedOutsideReads" })).toMatch(/^The user chose to block reads/);
		expect(permissions.refused({ kind: "toolOff" })).toBe("That tool is not available in this harness, so the call was blocked. Continue with the tools you have.");
		expect(permissions.refused({ kind: "unansweredResume" })).toContain("nobody answered the approval prompt");
		expect(permissions.refused({ kind: "manualApprovalWithheld" })).toContain("Manual approval was not granted");
		expect(permissions.refused({ kind: "stoppedWhileWaiting", who: "turn" })).toBe("The turn was stopped while waiting for the user's approval.");
		expect(permissions.refused({ kind: "stoppedWhileWaiting", who: "agent" })).toBe("The agent was stopped while waiting for the user's approval.");
	});

	it("tells a timeout apart from a denial", () => {
		const timedOut = permissions.refused({ kind: "classifierTimedOut", reason: "R" });
		expect(timedOut).toMatch(/^R\n\nThis was not a judgement that the call is unsafe. Wait a moment/);
		expect(permissions.refused({ kind: "classifierDenied", reason: "R" })).toMatch(/^Permission for this action was denied by the auto-mode approval classifier. Reason: R\n\n/);
	});

	it("words the in-process child gate", () => {
		expect(permissions.refused({ kind: "bridgeFailed", osMessage: "boom" })).toBe("Permission bridge failed (boom); denied to fail safe.");
		expect(permissions.refused({ kind: "childDenied", rule: "Bash(rm:*)" })).toBe("Denied by permission rules (rule: Bash(rm:*)).");
		expect(permissions.refused({ kind: "childDenied" })).toBe("Denied by permission rules.");
		expect(permissions.refused({ kind: "childNoClassifier", outsideWorkingDir: true })).toContain("a call outside the working directory is denied to fail safe");
		expect(permissions.refused({ kind: "childNeedsApproval", outsideWorkingDir: false })).toMatch(/^This action needs interactive approval/);
		expect(permissions.refused({ kind: "childStopped" })).toContain("parent permission session has stopped");
	});

	it("names the plan file in a switch to plan mode only", () => {
		expect(permissions.modeChanged({ mode: "plan", planFile: "/p/plan.md" })).toContain("your plan file at /p/plan.md");
		expect(permissions.modeChanged({ mode: "plan" })).toContain("plus the plan file named in the plan-mode reminder");
		expect(permissions.modeChanged({ mode: "default", planFile: "/p/plan.md" })).toBe('The user\'s permission mode is now "default".');
	});

	it("words a failed run review", () => {
		expect(permissions.reviewFailed({ osMessage: "timeout" })).toBe("the review itself failed (timeout)");
	});
});
