import { describe, expect, it } from "vitest";
import { loadAutoModeConfig } from "../../extensions/auto-mode/config.ts";
import { CONSECUTIVE_BLOCK_LIMIT, PauseTracker, TOTAL_BLOCK_LIMIT } from "../../extensions/auto-mode/pause.ts";
import {
	buildPayload,
	type ClassifyRequest,
	indexFor,
	parseSeverity,
	parseStage2,
	stage1User,
	stage2User,
} from "../../extensions/auto-mode/prompt.ts";
import { buildCategoryIndex, groundCategory } from "../../extensions/auto-mode/rules.ts";
import { buildRuleset } from "../../extensions/auto-mode/classifier-prompt.ts";

// No settings file at this path, so this is the built-in configuration (CC's
// ruleset with its default Environment).
const config = loadAutoModeConfig("/nonexistent-home-for-tests");
const index = indexFor(config.environment);

const base: ClassifyRequest = {
	toolName: "bash",
	transcript: [
		{ kind: "user", text: "clean up /tmp/x" },
		{ kind: "tool", tool: "bash", input: { command: "rm -rf /tmp/x" } },
	],
	userMessages: ["clean up /tmp/x"],
	username: "tester",
	environment: config.environment,
};

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
	});

	it("returns undefined for a name that is not a real rule", () => {
		expect(groundCategory(index, "Totally Made Up Rule")).toBeUndefined();
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
		const withExtras = indexFor(config.environment, extras);
		// Full text grounds at the right tier…
		expect(groundCategory(withExtras, extras.softDeny[0])?.tier).toBe("soft_deny");
		expect(groundCategory(withExtras, extras.hardDeny[0])?.tier).toBe("hard_deny");
		// …and extra ALLOW entries are still not block categories.
		const allowExtras = indexFor(config.environment, { allow: ["Bash(git-internal add:*) in ~/ml/repo"] });
		expect(groundCategory(allowExtras, "Bash(git-internal add:*) in ~/ml/repo")).toBeUndefined();
	});

	it("keeps HARD's tier when a name would otherwise collide", () => {
		const built = buildCategoryIndex(buildRuleset(config.environment));
		for (const rule of built.rules) {
			// Every indexed rule resolves to exactly one tier.
			expect(built.byName.get(rule.name.toLowerCase().replace(/[.,:;]+$/, ""))?.tier).toBe(rule.tier);
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

	it("clamps to 0..100 and rejects non-numeric replies", () => {
		expect(parseSeverity("<severity>250</severity>")).toBe(100);
		expect(parseSeverity("no severity here")).toBeNull();
	});
});

describe("parseStage2", () => {
	it("allows below the threshold", () => {
		expect(parseStage2("<severity>10</severity>", index).decision).toBe("allow");
		expect(parseStage2("<severity>10</severity>", index).tier).toBe("allow");
	});

	it("allows on intent when the quoted words really are the user's", () => {
		const messages = ["please write hello to ~/notes.txt, that's intentional"];
		const verdict = parseStage2(
			"<severity>20</severity>\n<intent>write hello to ~/notes.txt</intent>",
			index,
			messages,
		);
		expect(verdict.decision).toBe("allow");
		expect(verdict.tier).toBe("intent");
	});

	it("matches an intent quote across case and whitespace, not wording", () => {
		const messages = ["Write hello   to ~/notes.txt"];
		expect(
			parseStage2("<severity>10</severity><intent>write hello to ~/notes.txt</intent>", index, messages).decision,
		).toBe("allow");
	});

	it("refuses an intent it cannot find in the user's own words", () => {
		// The claim a prompt injection most wants to manufacture — "pick a location
		// yourself" read as authorising the location it picked.
		const messages = ["back up the project somewhere outside it, pick a location yourself"];
		for (const quote of ["back it up to ~/backups", "the user authorised this path"]) {
			const verdict = parseStage2(`<severity>10</severity><intent>${quote}</intent>`, index, messages);
			expect(verdict.decision, quote).toBe("block");
			expect(verdict.ruleId, quote).toBe("intent-unverified");
			// Still only a soft denial, so an interactive user can approve it.
			expect(verdict.tier, quote).toBe("soft_deny");
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
		expect(verdict.reason).toContain("not a rule");
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
	it("puts CC's ruleset and the Session Context in the system prompt", () => {
		const { system } = buildPayload(base);
		expect(system).toContain("security monitor");
		expect(system).toContain("## HARD BLOCK");
		expect(system).toContain("## Session Context");
		expect(system).toContain("tester"); // the injected username
	});

	it("keeps the transcript and CLAUDE.md framing in the user message", () => {
		const { userPrefix } = buildPayload({ ...base, claudeMd: "# CLAUDE.md\nNever force push." });
		expect(userPrefix).toContain("<transcript>");
		expect(userPrefix).toContain('{"Bash":"rm -rf /tmp/x"}');
		expect(userPrefix).toContain("<user_claude_md>");
		expect(userPrefix).toContain("Never force push.");
	});

	it("keeps the system prompt byte-stable across calls that differ only per-turn", () => {
		const other = buildPayload({
			...base,
			transcript: [{ kind: "tool", tool: "bash", input: { command: "echo hi" } }],
			claudeMd: "different",
		});
		expect(other.system).toBe(buildPayload(base).system);
	});

	it("does not promote the untrusted CLAUDE.md into the system role", () => {
		const { system } = buildPayload({ ...base, claudeMd: "MARKER-XYZ" });
		expect(system).not.toContain("MARKER-XYZ");
	});

	it("injects a configured environment line into the ruleset", () => {
		const { system } = buildPayload({ ...base, environment: ["- **Organization**: Acme Corp"] });
		expect(system).toContain("Acme Corp");
	});

	it("stage 1 asks for harm only; stage 2 asks for the full evaluation plus our intent quote", () => {
		const { userPrefix } = buildPayload(base);
		const s1 = stage1User(userPrefix);
		const s2 = stage2User(userPrefix);
		expect(s1).toContain("Grade HARM ONLY");
		expect(s1).not.toContain("<intent>");
		expect(s2).toContain("Review the classification process");
		expect(s2).toContain("<intent>"); // our addendum
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
	const built = buildRuleset(config.environment, extras);

	it("appends each list's extras as its last bullet lines", () => {
		// Each list's extras are its final content lines before the next boundary.
		const beforeSoft = built.slice(0, built.indexOf("\n## SOFT BLOCK"));
		expect(beforeSoft.trimEnd().endsWith("- My hard extra rule")).toBe(true);
		const beforeAllow = built.slice(0, built.indexOf("\n## ALLOW (exceptions)"));
		expect(beforeAllow.trimEnd().endsWith("- My soft extra rule")).toBe(true);
		const beforeClose = built.slice(0, built.indexOf("</cc_automode_permissions>"));
		expect(beforeClose.trimEnd().endsWith("- My allow extra rule")).toBe(true);
	});

	it("is byte-identical to the no-extras ruleset once the extra lines are removed", () => {
		const stripped = built
			.split("\n")
			.filter((line) => !line.startsWith("- My "))
			.join("\n");
		expect(stripped).toBe(buildRuleset(config.environment));
	});

	it("injects nothing for empty or missing lists", () => {
		expect(buildRuleset(config.environment, {})).toBe(buildRuleset(config.environment));
		expect(buildRuleset(config.environment, { allow: [] })).toBe(buildRuleset(config.environment));
	});
});
