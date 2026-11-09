/**
 * One Code's classifier text: Claude Code's ruleset with its rule names and
 * tiers, the stage instructions, the framing of the user's instruction file,
 * and the knob alias Claude Code users already set.
 */
import { describe, expect, it } from "vitest";
import { buildRuleset } from "../../extensions/permissions/auto-mode/classifier-prompt.ts";
import { unattendedPromptTimeoutMs, UNATTENDED_PROMPT_TIMEOUT_MS } from "../../extensions/permissions/auto-mode/pause.ts";
import { buildPayload, indexFor, parseStage2, stage1User, stage2User } from "../../extensions/permissions/auto-mode/prompt.ts";
import { groundCategory } from "../../extensions/permissions/auto-mode/rules.ts";
import { requireText } from "../../extensions/lib/profile/profile.ts";
import { CLEAN_UP_REQUEST, DEFAULT_ENVIRONMENT } from "../../test/unit/helpers/classify-request.ts";

const index = indexFor(DEFAULT_ENVIRONMENT);

describe("One Code's ruleset", () => {
	it("indexes Data Exfiltration as a HARD rule and the destructive/publish rules as SOFT", () => {
		expect(groundCategory(index, "Data Exfiltration")?.tier).toBe("hard_deny");
		for (const name of ["Git Destructive", "Irreversible Local Destruction", "Create Public Surface"]) {
			expect(groundCategory(index, name)?.tier, name).toBe("soft_deny");
		}
		expect(groundCategory(index, "  git destructive.  ")?.name).toBe("Git Destructive");
	});

	it("does not index the ALLOW exception Local Operations as a block category", () => {
		expect(groundCategory(index, "Local Operations")).toBeUndefined();
	});

	it("blocks with the grounded rule's name and tier", () => {
		const hard = parseStage2("<severity>90</severity><category>Data Exfiltration</category>", index);
		expect(hard.tier).toBe("hard_deny");
		expect(hard.reason).toContain("Data Exfiltration");
		const soft = parseStage2("<severity>70</severity><category>Irreversible Local Destruction</category>", index);
		expect(soft.tier).toBe("soft_deny");
		expect(soft.reason).toContain("Irreversible Local Destruction");
	});

	it("says an invented category is not a rule", () => {
		expect(requireText("autoMode").classifierBlock({ kind: "unmatchedRule", category: "Made Up Danger" })).toContain("not a rule");
	});

	it("closes the ALLOW list inside Claude Code's permissions block", () => {
		const built = buildRuleset(DEFAULT_ENVIRONMENT, { allow: ["My allow extra rule"] });
		const beforeClose = built.slice(0, built.indexOf("</cc_automode_permissions>"));
		expect(beforeClose.trimEnd().endsWith("- My allow extra rule")).toBe(true);
	});
});

describe("One Code's classifier prompt", () => {
	it("puts the ruleset and the Session Context in the system prompt", () => {
		const { system } = buildPayload(CLEAN_UP_REQUEST);
		expect(system).toContain("security monitor");
		expect(system).toContain("## HARD BLOCK");
		expect(system).toContain("## Session Context");
		expect(system).toContain("tester");
	});

	it("frames the instruction file as Claude Code does", () => {
		const { userPrefix } = buildPayload({ ...CLEAN_UP_REQUEST, claudeMd: "# CLAUDE.md\nNever force push." });
		expect(userPrefix).toContain("<user_claude_md>");
		expect(userPrefix).toContain("Never force push.");
	});

	it("asks stage 1 for harm only, stage 2 for the full evaluation plus the intent quote", () => {
		const { userPrefix } = buildPayload(CLEAN_UP_REQUEST);
		const s1 = stage1User(userPrefix);
		const s2 = stage2User(userPrefix);
		expect(s1).toContain("Grade HARM ONLY");
		expect(s1).not.toContain("<intent>");
		expect(s2).toContain("Review the classification process");
		expect(s2).toContain("<intent>");
	});

	it("words the circumvention instruction after a rule denial", () => {
		const after = stage2User(buildPayload(CLEAN_UP_REQUEST).userPrefix, true);
		expect(after).toContain("denied_by_permission_rule");
		expect(after).toContain("BLOCK it");
	});
});

describe("the timed resume prompt's knob", () => {
	it("also reads Claude Code's CLAUDE_CODE_TICKLISH_WHISPER_TIMEOUT_MS", () => {
		expect(unattendedPromptTimeoutMs({ CLAUDE_CODE_TICKLISH_WHISPER_TIMEOUT_MS: "30000" } as unknown as NodeJS.ProcessEnv)).toBe(30_000);
		expect(unattendedPromptTimeoutMs({ CLAUDE_CODE_TICKLISH_WHISPER_TIMEOUT_MS: "soon" } as unknown as NodeJS.ProcessEnv)).toBe(UNATTENDED_PROMPT_TIMEOUT_MS);
	});
});
