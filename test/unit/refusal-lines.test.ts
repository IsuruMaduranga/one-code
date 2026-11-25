import { describe, expect, it } from "vitest";
import { REFUSAL_LEADS, refusalLine } from "../../extensions/lib/rules/refusal-lines.ts";
import { refusalText, type PermissionRefusal } from "../../extensions/lib/rules/permission-text.ts";
import { autoModeResultText } from "../../extensions/safety/permissions/auto-mode/text.ts";
import { worktreeGuardText } from "../../extensions/lib/rules/worktree-guard-text.ts";
import { worktreeResultText } from "../../extensions/safety/worktree/text.ts";
import { toolResultsText } from "../../extensions/lib/request/tool-results-text.ts";
import { toolCallCorruptionText } from "../../extensions/request/tool-call-corruption/text.ts";

describe("refusalLine", () => {
	it("draws the permission gate's refusals as a short line, never the model's guidance", () => {
		const cases: Array<[PermissionRefusal, string]> = [
			[{ kind: "nonInteractive" }, "Needs approval, but this session cannot ask for it"],
			[{ kind: "planMode" }, "Blocked in plan mode"],
			[{ kind: "toolOff" }, "Tool not available"],
			[{ kind: "dontAsk" }, "Denied in dontAsk mode"],
			[{ kind: "protectedPath" }, "Blocked: protected path"],
			[{ kind: "outsideWorkingDir" }, "Denied in dontAsk mode: outside the working directory"],
			[{ kind: "outsideReadsBlocked" }, "Blocked: outside the working directories"],
			[{ kind: "userBlockedOutsideReads" }, "Blocked: outside the working directories"],
			[{ kind: "unansweredResume" }, "Denied: the approval prompt went unanswered"],
			[{ kind: "rule", rule: 'Bash(echo "x":*)' }, 'Denied by permission rule Bash(echo "x":*)'],
			[{ kind: "classifierDenied", reason: "PII" }, "Blocked by auto mode"],
			[{ kind: "childNoClassifier", outsideWorkingDir: true }, "Denied: this agent cannot reach auto mode's classifier"],
			[{ kind: "childNeedsApproval", outsideWorkingDir: false }, "Needs approval, which an agent cannot ask for"],
			[{ kind: "childNeedsApproval", outsideWorkingDir: true }, "Needs approval, which an agent cannot ask for"],
		];
		for (const [refusal, line] of cases) expect(refusalLine(refusalText(refusal))?.text, refusal.kind).toBe(line);
		// A product may word the secret-file refusal itself (`secretFileRefusal`); its words then show whole.
		const secret = refusalText({ kind: "secretFile" });
		expect(refusalLine(secret)?.text).toBe(secret.startsWith(REFUSAL_LEADS.secretFile) ? "Blocked: the file holds secrets" : undefined);
	});

	it("keeps a not-judged classifier's reason, in the error colour", () => {
		const reason = "The auto-mode classifier returned no verdict (Codex error: overloaded).";
		expect(refusalLine(refusalText({ kind: "classifierNoVerdict", reason }))).toEqual({ text: reason, color: "error" });
		expect(refusalLine(refusalText({ kind: "classifierTimedOut", reason: "Timed out." }))).toEqual({ text: "Timed out.", color: "error" });
	});

	it("keeps the fact before the guidance of the other guards' refusals", () => {
		for (const target of [
			{ kind: "pattern", token: "*" },
			{ kind: "control", token: "/p/.claude/settings.json" },
			{ kind: "catalog", token: "/p/models.json" },
		] as const) {
			expect(refusalLine(autoModeResultText.floorBlock(target))?.text, target.kind).toBe(`Auto mode blocked this call without consulting the classifier: ${autoModeResultText.floorReason(target)}.`);
		}
		expect(refusalLine(worktreeGuardText.refusal({ kind: "gitTarget", worktreePath: "/wt", problem: { kind: "tooComplex" } } as never))?.text).toBe(
			"This session is isolated in the worktree /wt, but this command is too complex to verify that its git operations stay inside the worktree.",
		);
		expect(refusalLine(worktreeGuardText.refusal({ kind: "stash", command: "git stash pop", risk: "pop" } as never))?.text).toMatch(/^Blocked: `git stash pop` — the git stash stack is shared .*another session's entry\.$/);
		expect(refusalLine(worktreeGuardText.refusal({ kind: "sharedCheckoutWrite", worktreePath: "/wt", target: "/s/x", inCommand: false, sharedRoot: "/s", mapped: "/wt/x" } as never))?.text).toBe(
			"This agent is isolated in the worktree /wt, but /s/x is in the shared checkout /s.",
		);
		expect(refusalLine(worktreeResultText.activeMissing({ path: "/wt", originalCwd: "/o" } as never))?.text).toBe("The active worktree at /wt no longer exists.");
		expect(refusalLine(toolResultsText.secretPlaceholderWrite)?.text).toBe("This write contains a [secret] placeholder.");
		expect(refusalLine(toolCallCorruptionText.suspectBlock({ reason: "Cut off." }))).toEqual({ text: "Cut off.", color: "error" });
		expect(refusalLine(toolCallCorruptionText.corruptBlock({ reason: "Broken.", repeat: false }))).toEqual({ text: "OpenRouter tool-call corruption: Broken.", color: "error" });
	});

	it("leaves a failed command's output whole when it only quotes a refusal's phrase", () => {
		const output = "FAIL test/unit/x.test.ts\n  expected 'Writes to the gate's own configuration are never auto-approved. Do not…' to match\n\nThis was not a judgement that the call is unsafe: …\n 1 failed";
		expect(refusalLine(output)).toBeUndefined();
		expect(refusalLine(`log line\n${refusalText({ kind: "classifierNoVerdict", reason: "R." })}\nmore output`)).toBeUndefined();
		expect(refusalLine(`echo: ${toolCallCorruptionText.suspectBlock({ reason: "Cut off." })}`)).toBeDefined(); // ends like the refusal: still drawn short
	});

	it("leaves other text alone", () => {
		expect(refusalLine("exit 1")).toBeUndefined();
		expect(refusalLine(refusalText({ kind: "conflictingPaths", fields: ["a", "b"] }))).toBeUndefined();
		expect(refusalLine(" It was not run. Send the complete command again;")).toBeUndefined();
	});
});
