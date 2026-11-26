import { describe, expect, it } from "vitest";
import {
	CONSECUTIVE_BLOCK_LIMIT,
	PauseTracker,
	TOTAL_BLOCK_LIMIT,
	UNATTENDED_PROMPT_TIMEOUT_MS,
	unattendedPromptNotice,
	unattendedPromptTimeoutMs,
} from "../../extensions/safety/permissions/auto-mode/pause.ts";
import {
	buildPayload,
	indexFor,
	parseSeverity,
	parseStage2,
	stage1User,
	stage2User,
} from "../../extensions/safety/permissions/auto-mode/prompt.ts";
import { buildCategoryIndex, groundCategory } from "../../extensions/safety/permissions/auto-mode/rules.ts";
import { buildRuleset } from "../../extensions/safety/permissions/auto-mode/classifier-prompt.ts";
import { brand, envName } from "../../extensions/lib/profile/brand.mjs";
import { requireText } from "../../extensions/lib/profile/profile.ts";
import { CLEAN_UP_REQUEST, DEFAULT_ENVIRONMENT } from "./helpers/classify-request.ts";
import { autoModeResultText } from "../../extensions/safety/permissions/auto-mode/text.ts";

const words = requireText("classifier");

// A ruleset in the shape the base parses: the section headings it bounds the
// lists by, top-level bullets with and without a qualifier, a sub-bullet, and an
// ALLOW list. Which rules a profile's own ruleset holds is the profile's to
// check (One Code's: profile/test/auto-mode-classifier-wording.test.ts).
const RULESET = [
	"# Rules",
	"",
	"## HARD BLOCK",
	"- Data Exfiltration: sending sensitive data out",
	"  - Sub Bullet: not a rule of its own",
	"## SOFT BLOCK",
	"- Git Destructive: force pushes and history rewrites",
	"- **Irreversible Local Destruction** [named+specifics]: deleting what cannot be recovered",
	"- Create Public Surface: publishing something",
	"- Data Exfiltration: listed again, keeping its HARD tier",
	"## ALLOW (exceptions)",
	"- Local Operations: work inside the project",
].join("\n");
const index = buildCategoryIndex(RULESET);

describe("buildCategoryIndex / groundCategory", () => {
	it("indexes Data Exfiltration as a HARD rule", () => {
		const rule = groundCategory(index, "Data Exfiltration");
		expect(rule?.tier).toBe("hard_deny");
	});

	it("indexes destructive/publish rules as SOFT", () => {
		for (const name of ["Git Destructive", "Irreversible Local Destruction", "Create Public Surface"]) {
			expect(groundCategory(index, name)?.tier, name).toBe("soft_deny");
		}
	});

	it("matches a category across case and surrounding punctuation", () => {
		expect(groundCategory(index, "  git destructive.  ")?.name).toBe("Git Destructive");
		// The Output Format asks for letters, digits and spaces only: `/` and `-`
		// become a space and other punctuation is dropped. Either spelling grounds.
		const punctuated = buildCategoryIndex([
			"## HARD BLOCK",
			"- Logging/Audit Tampering: turning off the record",
			"## SOFT BLOCK",
			"- Out-of-Place Publication [named+specifics]: publishing what does not belong there",
			"- DNS / Domain / Cert Changes: changing where a name points",
			"- Irreversible Deletion (general): deleting what cannot be recovered",
			"- Auto-Mode Bypass: getting around this gate",
			"## ALLOW (exceptions)",
			"- Local Operations: work inside the project",
		].join("\n"));
		for (const [cited, name] of [
			["Out of Place Publication", "Out-of-Place Publication"],
			["Out-of-Place Publication", "Out-of-Place Publication"],
			["Logging Audit Tampering", "Logging/Audit Tampering"],
			["DNS Domain Cert Changes", "DNS / Domain / Cert Changes"],
			["Irreversible Deletion general", "Irreversible Deletion (general)"],
			["Auto Mode Bypass", "Auto-Mode Bypass"],
		]) {
			expect(groundCategory(punctuated, cited)?.name, cited).toBe(name);
		}
		// Punctuation alone names no rule, even when a rule's own name is only punctuation,
		// and two names that differ in a combining mark stay two rules.
		const odd = buildCategoryIndex(["## HARD BLOCK", "- >>>: never pipe to prod", "## SOFT BLOCK", "- की: one", "- कि: two", "## ALLOW (exceptions)"].join("\n"));
		expect(groundCategory(odd, "—")).toBeUndefined();
		expect(groundCategory(odd, "कि")?.name).toBe("कि");
	});

	it("returns undefined for a name that is not a real rule", () => {
		expect(groundCategory(index, "Totally Made Up Rule")).toBeUndefined();
		expect(groundCategory(index, "Sub Bullet")).toBeUndefined();
		expect(groundCategory(index, undefined)).toBeUndefined();
	});

	it("does not index ALLOW-section names as block categories", () => {
		// "Local Operations" is an ALLOW exception, not a block rule — a block citing
		// it must land as unmatched rather than borrow authority.
		expect(groundCategory(index, "Local Operations")).toBeUndefined();
	});

	it("grounds user rule extras by their full text and derived prefix", () => {
		const extras = {
			softDeny: ["Bash(git add *) in ~/ml/repo when staging internal-only paths — never these"],
			hardDeny: ["Uploading anything to pastebin-like services"],
		};
		const withExtras = indexFor(DEFAULT_ENVIRONMENT, extras);
		// Full text grounds at the right tier…
		expect(groundCategory(withExtras, extras.softDeny[0])?.tier).toBe("soft_deny");
		expect(groundCategory(withExtras, extras.hardDeny[0])?.tier).toBe("hard_deny");
		// …and extra ALLOW entries are still not block categories.
		const allowExtras = indexFor(DEFAULT_ENVIRONMENT, { allow: ["Bash(git-internal add:*) in ~/ml/repo"] });
		expect(groundCategory(allowExtras, "Bash(git-internal add:*) in ~/ml/repo")).toBeUndefined();
	});

	it("keeps HARD's tier when a name would otherwise collide", () => {
		const built = buildCategoryIndex(buildRuleset(DEFAULT_ENVIRONMENT));
		for (const rule of built.rules) {
			// Every indexed rule resolves to exactly one tier.
			expect(groundCategory(built, rule.name)?.tier, rule.name).toBe(rule.tier);
		}
	});
});

describe("parseSeverity", () => {
	it("reads a closed tag", () => {
		expect(parseSeverity("<severity>65</severity>")).toBe(65);
	});

	it("reads an unterminated tag (stopped before the closing tag)", () => {
		expect(parseSeverity("<severity>7")).toBe(7);
	});

	it("takes the last severity when a <thinking> block mentions others", () => {
		expect(parseSeverity("<thinking>maybe 80? no</thinking>\n<severity>20</severity>")).toBe(20);
	});

	it("reads nothing from a body that is not a whole number, so stage 1 cannot clear on another scale", () => {
		for (const reply of ["<severity>0.9</severity>", "<severity>9/10</severity>", "<severity>90%</severity>", "<severity>-5</severity>", "<severity>1e2</severity>", "<severity>low</severity>", "<severity>40 because it reads</severity>", "<severity>1000</severity>"]) {
			expect(parseSeverity(reply), reply).toBeNull();
		}
		// The last tag decides, even when an earlier one was a clean number.
		expect(parseSeverity("<severity>20</severity> on reflection <severity>0.8</severity>")).toBeNull();
		expect(parseSeverity("<severity> 35 </severity>\n<reason>x</reason>")).toBe(35);
		expect(parseSeverity("<severity>40\n<reason>x</reason>")).toBe(40);
	});

	it("clamps to 0..100 and rejects non-numeric replies", () => {
		expect(parseSeverity("<severity>250</severity>")).toBe(100);
		expect(parseSeverity("no severity here")).toBeNull();
	});
});

describe("parseStage2", () => {
	it("allows below the threshold", () => {
		expect(parseStage2("<severity>10</severity>", index).decision).toBe("allow");
		expect(parseStage2("<severity>10</severity>", index).tier).toBe("allow");
		// A plain clear carries no ruleId (the classifier tags it `unverified-clear`
		// when stage 1 had flagged the call); a cited category is kept for the log.
		expect(parseStage2("<severity>10</severity>", index).ruleId).toBeUndefined();
		expect(parseStage2("<severity>10</severity><category>Git Read</category>", index).ruleId).toBe("Git Read");
	});

	it("allows a clear on the classifier's judgment, whatever it says the user asked for", () => {
		// As in Claude Code, nothing in a clearing reply is checked against the
		// user's messages: an <intent> tag, true or invented, changes nothing.
		for (const reply of [
			"<severity>20</severity>\n<intent>write hello to ~/notes.txt</intent>",
			"<severity>10</severity><intent>the user authorised this path</intent>",
		]) {
			const verdict = parseStage2(reply, index);
			expect(verdict.decision, reply).toBe("allow");
			expect(verdict.tier, reply).toBe("allow");
			expect(verdict.ruleId, reply).toBeUndefined();
		}
	});

	it("blocks at/above the threshold, taking the tier from the grounded category", () => {
		const hard = parseStage2("<severity>90</severity><category>Data Exfiltration</category>", index);
		expect(hard.decision).toBe("block");
		expect(hard.tier).toBe("hard_deny");
		expect(hard.reason).toContain("Data Exfiltration");

		const soft = parseStage2("<severity>70</severity><category>Irreversible Local Destruction</category>", index);
		expect(soft.tier).toBe("soft_deny");
		expect(soft.reason).toContain("Irreversible Local Destruction");
	});

	it("blocks but does not lend a rule's authority to an invented category", () => {
		const verdict = parseStage2("<severity>80</severity><category>Made Up Danger</category>", index);
		expect(verdict.decision).toBe("block");
		expect(verdict.tier).toBe("unmatched");
		expect(verdict.reason).toBe(autoModeResultText.classifierBlock({ kind: "unmatchedRule", category: "Made Up Danger" }));
	});

	it("blocks with unmatched tier when a block names no category at all", () => {
		expect(parseStage2("<severity>80</severity>", index).tier).toBe("unmatched");
	});

	it("blocks when the reply carries no severity to read", () => {
		const verdict = parseStage2("I could not decide", index);
		expect(verdict.decision).toBe("block");
		expect(verdict.tier).toBe("unmatched");
	});

	it("tolerates <thinking> prose around the tags", () => {
		const verdict = parseStage2(
			"<thinking>This deletes a tracked file outside cwd.</thinking>\n<severity>65</severity>\n<category>Git Destructive</category>",
			index,
		);
		expect(verdict.decision).toBe("block");
		expect(verdict.ruleId).toBe("Git Destructive");
	});
});

describe("buildPayload / stage instructions", () => {
	it("puts the profile's ruleset and the Session Context in the system prompt", () => {
		const { system } = buildPayload(CLEAN_UP_REQUEST);
		const environment = DEFAULT_ENVIRONMENT.map((entry) => `- ${entry}`).join("\n");
		const ruleset = words.rulesetHead + environment + words.hardSection + words.softSection + words.allowSection + words.rulesetTail;
		// The username is injected at the profile's placeholder.
		expect(system).toBe(ruleset + words.sessionContext.split("__USERNAME__").join("tester"));
		expect(system).toContain("## HARD BLOCK");
	});

	it("keeps the transcript and CLAUDE.md framing in the user message", () => {
		const claudeMd = "# CLAUDE.md\nNever force push.";
		const { userPrefix } = buildPayload({ ...CLEAN_UP_REQUEST, claudeMd });
		expect(userPrefix).toContain("<transcript>");
		expect(userPrefix).toContain('{"Bash":"rm -rf /tmp/x"}');
		expect(userPrefix.startsWith(`${words.instructionsFraming.prefix}${claudeMd}${words.instructionsFraming.suffix}\n\n`)).toBe(true);
	});

	it("keeps the system prompt byte-stable across calls that differ only per-turn", () => {
		const other = buildPayload({
			...CLEAN_UP_REQUEST,
			transcript: [{ kind: "tool", tool: "bash", input: { command: "echo hi" } }],
			claudeMd: "different",
		});
		expect(other.system).toBe(buildPayload(CLEAN_UP_REQUEST).system);
	});

	it("does not promote the untrusted CLAUDE.md into the system role", () => {
		const { system } = buildPayload({ ...CLEAN_UP_REQUEST, claudeMd: "MARKER-XYZ" });
		expect(system).not.toContain("MARKER-XYZ");
	});

	it("injects a configured environment line into the ruleset", () => {
		const { system } = buildPayload({ ...CLEAN_UP_REQUEST, environment: ["- **Organization**: Acme Corp"] });
		expect(system).toContain("Acme Corp");
	});

	it("stage 1 asks for harm only; stage 2 asks for the full evaluation and nothing more", () => {
		const { userPrefix } = buildPayload(CLEAN_UP_REQUEST);
		const s1 = stage1User(userPrefix);
		const s2 = stage2User(userPrefix);
		expect(s1).toBe(`${userPrefix}\n\n${words.stage1Final.trimStart()}`);
		expect(s2).toBe(`${userPrefix}\n\n${words.stage2Final.trimStart()}`);
	});

	it("adds the circumvention instruction to stage 2 only after a rule denial", () => {
		const { userPrefix } = buildPayload(CLEAN_UP_REQUEST);
		expect(stage2User(userPrefix)).not.toContain(words.stage2DenialAddendum);
		const after = stage2User(userPrefix, true);
		expect(after).toBe(`${stage2User(userPrefix)}${words.stage2DenialAddendum}`);
		// Stage 1 grades harm only and stays the same either way.
		expect(stage1User(userPrefix)).not.toContain(words.stage2DenialAddendum);
	});
});

describe("PauseTracker", () => {
	const denial = { toolName: "bash", subject: "rm -rf /", reason: "destructive" };

	it("pauses after the consecutive-block limit", () => {
		const tracker = new PauseTracker();
		for (let i = 0; i < CONSECUTIVE_BLOCK_LIMIT - 1; i++) {
			expect(tracker.recordBlock(denial)).toBe(false);
		}
		expect(tracker.recordBlock(denial)).toBe(true);
		expect(tracker.isPaused()).toBe(true);
	});

	it("lets an approval break a consecutive run", () => {
		const tracker = new PauseTracker();
		tracker.recordBlock(denial);
		tracker.recordBlock(denial);
		tracker.recordAllow();
		expect(tracker.recordBlock(denial)).toBe(false);
		expect(tracker.isPaused()).toBe(false);
	});

	it("ends a consecutive-limit pause on an allow, as Claude Code's reset does, but not a total-limit one", () => {
		const tracker = new PauseTracker();
		for (let i = 0; i < CONSECUTIVE_BLOCK_LIMIT; i++) tracker.recordBlock(denial);
		expect(tracker.recordAllow()).toBe(true);
		expect(tracker.isPaused()).toBe(false);
		expect(tracker.recordBlock(denial)).toBe(false);
		expect(tracker.recordAllow()).toBe(false);

		const total = new PauseTracker();
		for (let i = 0; i < TOTAL_BLOCK_LIMIT; i++) {
			total.recordBlock(denial);
			if (!total.isPaused()) total.recordAllow();
		}
		expect(total.isPaused()).toBe(true);
		expect(total.recordAllow()).toBe(false);
		expect(total.isPaused()).toBe(true);
	});

	it("pauses on the total limit even when blocks are never consecutive", () => {
		const tracker = new PauseTracker();
		let tripped = false;
		for (let i = 0; i < TOTAL_BLOCK_LIMIT; i++) {
			tripped = tracker.recordBlock(denial) || tripped;
			tracker.recordAllow();
		}
		expect(tripped).toBe(true);
	});

	it("resets the total counter when it is what triggered the pause", () => {
		const tracker = new PauseTracker();
		for (let i = 0; i < TOTAL_BLOCK_LIMIT; i++) {
			tracker.recordBlock(denial);
			tracker.recordAllow();
		}
		tracker.resume();
		expect(tracker.recordBlock(denial)).toBe(false);
		expect(tracker.isPaused()).toBe(false);
		expect(tracker.stats().total).toBe(1);
	});

	it("keeps a lifetime count for display even after the total resets", () => {
		const tracker = new PauseTracker();
		for (let i = 0; i < TOTAL_BLOCK_LIMIT; i++) {
			tracker.recordBlock(denial);
			tracker.recordAllow();
		}
		expect(tracker.stats().total).toBe(0);
		expect(tracker.stats().lifetime).toBe(TOTAL_BLOCK_LIMIT);
	});

	it("reports the pause only once, so the notice is not repeated", () => {
		const tracker = new PauseTracker();
		for (let i = 0; i < CONSECUTIVE_BLOCK_LIMIT; i++) tracker.recordBlock(denial);
		expect(tracker.recordBlock(denial)).toBe(false);
		expect(tracker.isPaused()).toBe(true);
	});

	it("resets the consecutive counter on resume, so the next block does not re-pause", () => {
		const tracker = new PauseTracker();
		for (let i = 0; i < CONSECUTIVE_BLOCK_LIMIT; i++) tracker.recordBlock(denial);
		tracker.resume();
		expect(tracker.isPaused()).toBe(false);
		expect(tracker.recordBlock(denial)).toBe(false);
	});

	it("lists recent denials most-recent-first", () => {
		const tracker = new PauseTracker();
		tracker.recordBlock({ ...denial, reason: "first" });
		tracker.recordBlock({ ...denial, reason: "second" });
		expect(tracker.recentDenials().map((d) => d.reason)).toEqual(["second", "first"]);
	});
});

describe("buildRuleset rule-extra injection (CC 2.1.233 injection points)", () => {
	const extras = {
		hardDeny: ["My hard extra rule"],
		softDeny: ["My soft extra rule"],
		allow: ["My allow extra rule"],
	};
	const built = buildRuleset(DEFAULT_ENVIRONMENT, extras);

	it("appends each list's extras as its last bullet lines", () => {
		// Each list's extras are its final content lines before the next boundary.
		const beforeSoft = built.slice(0, built.indexOf(words.softSection));
		expect(beforeSoft.trimEnd().endsWith("- My hard extra rule")).toBe(true);
		const beforeAllow = built.slice(0, built.indexOf(words.allowSection));
		expect(beforeAllow.trimEnd().endsWith("- My soft extra rule")).toBe(true);
		expect(built.endsWith(words.rulesetTail)).toBe(true);
		const beforeClose = built.slice(0, built.length - words.rulesetTail.length);
		expect(beforeClose.trimEnd().endsWith("- My allow extra rule")).toBe(true);
	});

	it("is byte-identical to the no-extras ruleset once the extra lines are removed", () => {
		const stripped = built
			.split("\n")
			.filter((line) => !line.startsWith("- My "))
			.join("\n");
		expect(stripped).toBe(buildRuleset(DEFAULT_ENVIRONMENT));
	});

	it("injects nothing for empty or missing lists", () => {
		expect(buildRuleset(DEFAULT_ENVIRONMENT, {})).toBe(buildRuleset(DEFAULT_ENVIRONMENT));
		expect(buildRuleset(DEFAULT_ENVIRONMENT, { allow: [] })).toBe(buildRuleset(DEFAULT_ENVIRONMENT));
	});
});

describe("the timed resume prompt (Claude Code's denial-limit fallback timing)", () => {
	const block = { toolName: "bash", subject: "x", reason: "r" };
	const trip = (tracker: PauseTracker, n: number) => {
		for (let i = 0; i < n; i++) tracker.recordBlock(block);
	};

	it("times only the first prompt after a consecutive-limit pause, until the streak breaks", () => {
		const tracker = new PauseTracker();
		expect(tracker.takeTimedPrompt()).toBe(false);
		trip(tracker, CONSECUTIVE_BLOCK_LIMIT);
		expect(tracker.takeTimedPrompt()).toBe(true);
		expect(tracker.takeTimedPrompt()).toBe(false);
		tracker.resume();
		trip(tracker, CONSECUTIVE_BLOCK_LIMIT);
		expect(tracker.takeTimedPrompt()).toBe(true);
	});

	it("never times a pause the total limit tripped", () => {
		const tracker = new PauseTracker();
		for (let i = 0; i < TOTAL_BLOCK_LIMIT; i++) {
			tracker.recordBlock(block);
			if (i % 2 === 0) tracker.recordAllow();
		}
		expect(tracker.isPaused()).toBe(true);
		expect(tracker.takeTimedPrompt()).toBe(false);
	});

	it("waits 120 s unless the product's TICKLISH_WHISPER_TIMEOUT_MS knob says otherwise, and words it as Claude Code does", () => {
		const knob = envName("TICKLISH_WHISPER_TIMEOUT_MS");
		expect(unattendedPromptTimeoutMs({} as NodeJS.ProcessEnv)).toBe(UNATTENDED_PROMPT_TIMEOUT_MS);
		expect(unattendedPromptTimeoutMs({ [knob]: "30000" } as unknown as NodeJS.ProcessEnv)).toBe(30_000);
		expect(unattendedPromptTimeoutMs({ [knob]: "soon" } as unknown as NodeJS.ProcessEnv)).toBe(UNATTENDED_PROMPT_TIMEOUT_MS);
		expect(unattendedPromptNotice(120_000)).toBe(`⚠ ${brand.name} will automatically deny this request in about 2 minutes, to avoid blocking progress on an unattended session`);
		expect(unattendedPromptNotice(30_000)).toContain("in about 30 seconds,");
	});
});
