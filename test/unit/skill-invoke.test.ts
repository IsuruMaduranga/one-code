import { describe, expect, it } from "vitest";
import {
	PI_BUILTIN_COMMANDS,
	commandBreadcrumb,
	commandDisplayLine,
	isBareCommandName,
	launchingSkill,
	parseSkillCommand,
	resolveSkill,
	skillCommandCandidates,
	skillPromptText,
	substituteSkillArguments,
	typedSkillContent,
	withoutDuplicateSkillCommands,
} from "../../extensions/skill/invoke.ts";

describe("parseSkillCommand", () => {
	it("returns undefined for non-skill input", () => {
		expect(parseSkillCommand("hello")).toBeUndefined();
		expect(parseSkillCommand("/skills")).toBeUndefined();
		expect(parseSkillCommand("/other:thing")).toBeUndefined();
	});

	it("parses a bare skill command", () => {
		expect(parseSkillCommand("/skill:simplify")).toEqual({ name: "simplify", args: "" });
	});

	it("splits the name from trailing args and trims them", () => {
		expect(parseSkillCommand("/skill:code-review  focus on the parser ")).toEqual({
			name: "code-review",
			args: "focus on the parser",
		});
	});

	it("keeps a plugin-namespaced name intact", () => {
		expect(parseSkillCommand("/skill:pr-review-toolkit:review-pr 123")).toEqual({
			name: "pr-review-toolkit:review-pr",
			args: "123",
		});
	});
});

describe("resolveSkill", () => {
	const all = [
		{ name: "simplify" },
		{ name: "code-review" },
		{ name: "pr-review-toolkit:review-pr" },
		{ name: "coderabbit:code-review" },
	];

	it("matches an exact name", () => {
		expect(resolveSkill(all, "simplify")).toEqual({ name: "simplify" });
	});

	it("matches case-insensitively", () => {
		expect(resolveSkill(all, "Simplify")).toEqual({ name: "simplify" });
	});

	it("resolves a unique plugin suffix from a bare name", () => {
		expect(resolveSkill(all, "review-pr")).toEqual({ name: "pr-review-toolkit:review-pr" });
	});

	it("refuses an ambiguous bare name across plugins", () => {
		// "code-review" exists both unprefixed and as coderabbit:code-review — the
		// exact match wins; but a bare name matching two plugins resolves to none.
		const plugins = [{ name: "a:thing" }, { name: "b:thing" }];
		expect(resolveSkill(plugins, "thing")).toBeUndefined();
	});

	it("returns undefined when nothing matches", () => {
		expect(resolveSkill(all, "nope")).toBeUndefined();
	});
});

describe("Claude Code's skill message", () => {
	it("writes the typed command's breadcrumb, with the arguments only when there are some", () => {
		expect(commandBreadcrumb("fixture-kit:kit-skill-02", "")).toBe(
			"<command-message>fixture-kit:kit-skill-02</command-message>\n<command-name>/fixture-kit:kit-skill-02</command-name>\n",
		);
		expect(commandBreadcrumb("loop", "5m check CI")).toBe(
			"<command-message>loop</command-message>\n<command-name>/loop</command-name>\n<command-args>5m check CI</command-args>\n",
		);
	});

	it("names the skill's folder before its text, and nothing for One Code's own catalog", () => {
		expect(skillPromptText("Body of skill 02.", "", "/p/skills/kit-skill-02")).toBe("Base directory for this skill: /p/skills/kit-skill-02\n\nBody of skill 02.");
		expect(skillPromptText("Review it.", "", undefined)).toBe("Review it.");
	});

	it("builds the typed message as two blocks, each ending in a newline", () => {
		const [breadcrumb, text] = typedSkillContent("kit-skill-02", "", skillPromptText("Body of skill 02.", "", "/d"));
		expect(breadcrumb).toBe("<command-message>kit-skill-02</command-message>\n<command-name>/kit-skill-02</command-name>\n");
		expect(text).toBe("Base directory for this skill: /d\n\nBody of skill 02.\n");
		expect(typedSkillContent("x", "", "ends\n")[1]).toBe("ends\n");
	});

	it("answers a model's call with Claude Code's launch line", () => {
		expect(launchingSkill("workflow-authoring")).toBe("Launching skill: workflow-authoring");
	});
});

// pi draws a user message as markdown: a typed skill showed its whole text.
describe("commandDisplayLine", () => {
	it("shows a typed command as its command line, with or without arguments", () => {
		const [breadcrumb, text] = typedSkillContent("simplify", "", "Review the diff.");
		expect(commandDisplayLine(`${breadcrumb}\n${text}`)).toBe("/simplify");
		expect(commandDisplayLine(`${commandBreadcrumb("review", "PR 12\nfocus on auth")}\nbody`)).toBe("/review PR 12\nfocus on auth");
	});

	it("leaves every other message alone", () => {
		expect(commandDisplayLine("Please run /simplify on this")).toBeUndefined();
		expect(commandDisplayLine("<command-name>/model</command-name>\n")).toBeUndefined();
	});
});

describe("substituteSkillArguments (Claude Code's rule)", () => {
	it("appends the arguments on an ARGUMENTS line when the text has no placeholder", () => {
		expect(substituteSkillArguments("Do it.", "the parser")).toBe("Do it.\n\nARGUMENTS: the parser");
		expect(substituteSkillArguments("Do it.", "")).toBe("Do it.");
	});

	it("fills $ARGUMENTS, $ARGUMENTS[n] and $n, counting from 0", () => {
		expect(substituteSkillArguments("Review $ARGUMENTS now", "a b")).toBe("Review a b now");
		expect(substituteSkillArguments("first $0, second $ARGUMENTS[1]", "a b")).toBe("first a, second b");
	});

	it("keeps a missing index and an escaped dollar literal, and never substitutes inside an argument", () => {
		expect(substituteSkillArguments("$3 and $ARGUMENTS[4]", "a")).toBe("$3 and $ARGUMENTS[4]\n\nARGUMENTS: a");
		expect(substituteSkillArguments("cost \\$1 for $ARGUMENTS", "x")).toBe("cost $1 for x");
		expect(substituteSkillArguments("$ARGUMENTS then $0", "$0")).toBe("$0 then $0");
	});
});

/** pi's own `/skill:` expansion, the block the redaction fallback matches. */
const piSkillBlock = (name: string, filePath: string, body: string): string =>
	`<skill name="${name}" location="${filePath}">\nReferences are relative to ${filePath.slice(0, filePath.lastIndexOf("/"))}.\n\n${body}\n</skill>`;

describe("bare skill commands", () => {
	it("accepts one-token names and rejects plugin-style or odd ones", () => {
		expect(isBareCommandName("simplify")).toBe(true);
		expect(isBareCommandName("code-review")).toBe(true);
		expect(isBareCommandName("pr-review-toolkit:review-pr")).toBe(false);
		expect(isBareCommandName("with space")).toBe(false);
		expect(isBareCommandName("-lead")).toBe(false);
		expect(isBareCommandName("")).toBe(false);
	});

	const skills = [
		{ name: "simplify", source: "project" },
		{ name: "code-review", source: "project" },
		{ name: "skills", source: "project" },
		{ name: "model", source: "project" },
		{ name: "acme:deploy", source: "plugin" },
		{ name: "simplify", source: "project" },
	];

	it("skips plugin skills, taken names, pi built-ins, and duplicates", () => {
		const picked = skillCommandCandidates(skills, ["skills", "plugins"]);
		expect(picked.map((s) => s.name)).toEqual(["simplify", "code-review"]);
	});

	it("registers everything eligible when nothing is taken", () => {
		expect(skillCommandCandidates([{ name: "a", source: "project" }, { name: "b", source: "project" }], []).map((s) => s.name)).toEqual(["a", "b"]);
	});

	it("keeps pi's literal-matched built-ins out of the alias set", () => {
		for (const name of ["model", "new", "compact", "quit", "reload"]) expect(PI_BUILTIN_COMMANDS.has(name)).toBe(true);
	});
});

describe("withoutDuplicateSkillCommands", () => {
	const items = [{ value: "simplify" }, { value: "skill:simplify" }, { value: "skill:clashing" }, { value: "model" }];
	const bare = new Set(["simplify"]);

	it("drops /skill:<name> where the bare command exists", () => {
		expect(withoutDuplicateSkillCommands(items, "/si", bare).map((item) => item.value)).toEqual(["simplify", "skill:clashing", "model"]);
	});

	it("keeps every /skill: entry while the user types /skill: themselves", () => {
		expect(withoutDuplicateSkillCommands(items, "/skill:s", bare)).toEqual(items);
	});

	it("leaves non-command suggestions alone", () => {
		expect(withoutDuplicateSkillCommands([{ value: "skill:simplify" }], "@src", bare)).toEqual([{ value: "skill:simplify" }]);
	});
});
