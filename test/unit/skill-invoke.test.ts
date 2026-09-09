import { describe, expect, it } from "vitest";
import {
	PI_BUILTIN_COMMANDS,
	buildSkillBlock,
	isBareCommandName,
	offSkillNotice,
	parseSkillCommand,
	redactOffSkillMessages,
	redactOffSkillText,
	resolveSkill,
	skillCommandCandidates,
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

describe("buildSkillBlock", () => {
	it("reproduces pi's skill block with the directory as the reference base", () => {
		const block = buildSkillBlock({ name: "simplify", filePath: "/skills/simplify/SKILL.md" }, "Do the thing.", "");
		expect(block).toBe(
			'<skill name="simplify" location="/skills/simplify/SKILL.md">\n' +
				"References are relative to /skills/simplify.\n\n" +
				"Do the thing.\n" +
				"</skill>",
		);
	});

	it("appends args after a blank line", () => {
		const block = buildSkillBlock({ name: "s", filePath: "/a/b/SKILL.md" }, "body", "extra instructions");
		expect(block.endsWith("</skill>\n\nextra instructions")).toBe(true);
	});
});

describe("redactOffSkillText", () => {
	const offBlock = buildSkillBlock({ name: "deploy", filePath: "/s/deploy/SKILL.md" }, "secret steps", "");
	const onBlock = buildSkillBlock({ name: "review", filePath: "/s/review/SKILL.md" }, "review steps", "");
	const isOff = (name: string) => name === "deploy";

	it("replaces an off skill's block with the refusal notice", () => {
		const out = redactOffSkillText(offBlock, isOff);
		expect(out).toBe(offSkillNotice("deploy"));
		expect(out).not.toContain("secret steps");
	});

	it("keeps trailing args and surrounding text intact", () => {
		const out = redactOffSkillText(`before\n${offBlock}\n\nsome args`, isOff);
		expect(out).toBe(`before\n${offSkillNotice("deploy")}\n\nsome args`);
	});

	it("redacts only the off skill when blocks are mixed", () => {
		const out = redactOffSkillText(`${onBlock}\n\n${offBlock}`, isOff);
		expect(out).toContain("review steps");
		expect(out).not.toContain("secret steps");
	});

	it("returns undefined when nothing needs redacting (byte-stability)", () => {
		expect(redactOffSkillText("plain user text", isOff)).toBeUndefined();
		expect(redactOffSkillText(onBlock, isOff)).toBeUndefined();
	});
});

describe("redactOffSkillMessages", () => {
	const offBlock = buildSkillBlock({ name: "deploy", filePath: "/s/deploy/SKILL.md" }, "secret steps", "");
	const isOff = (name: string) => name === "deploy";

	it("rewrites user string content and text blocks, leaving other messages alone", () => {
		const messages = [
			{ role: "system", content: offBlock },
			{ role: "user", content: offBlock },
			{ role: "custom", content: [{ type: "text", text: offBlock }, { type: "image", data: "…" }] },
			{ role: "assistant", content: "ack" },
		];
		const out = redactOffSkillMessages(messages, isOff);
		expect(out).toBeDefined();
		expect(out?.[0].content).toBe(offBlock); // system untouched
		expect(out?.[1].content).toBe(offSkillNotice("deploy"));
		expect((out?.[2].content as Array<{ text?: string }>)[0].text).toBe(offSkillNotice("deploy"));
		expect((out?.[2].content as Array<{ type?: string }>)[1]).toEqual({ type: "image", data: "…" });
		expect(out?.[3]).toBe(messages[3]); // untouched messages keep identity
	});

	it("returns undefined when no message contains an off skill's block", () => {
		const messages = [
			{ role: "user", content: "hello" },
			{ role: "user", content: buildSkillBlock({ name: "review", filePath: "/s/r/SKILL.md" }, "steps", "") },
		];
		expect(redactOffSkillMessages(messages, isOff)).toBeUndefined();
	});
});

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
