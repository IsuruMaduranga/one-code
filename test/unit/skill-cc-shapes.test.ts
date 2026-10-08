/**
 * skill/index.ts against Claude Code's shapes: the listing's order (project
 * skills, plugin commands, plugin skills, then the bundled catalog) with
 * `when_to_use`; a typed `/<plugin>:<skill>` expanded in the harness; a model
 * call answered "Launching skill" with the text beside it; and code-review's
 * body chosen by tier and effort.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import skillExtension from "../../extensions/skill/index.ts";
import { invalidatePluginsCache } from "../../extensions/lib/plugins.ts";
import { REMINDER_CHANNEL } from "../../extensions/lib/reminders.ts";
import { BUNDLED_SKILLS_DIR } from "../../extensions/lib/skill-scan.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { stubHome } from "./helpers/home.ts";

const root = mkdtempSync(join(tmpdir(), "skill-cc-shapes-"));
const cwd = join(root, "project");
const demoDir = join(cwd, ".claude", "skills", "demo");
const pluginDir = join(root, ".claude", "plugins", "cache", "market", "kit", "1.0.0");
const codeReviewFile = join(BUNDLED_SKILLS_DIR, "code-review", "SKILL.md");
// A Windows checkout may carry CRLF; the selector reads the cells with LF, as Claude Code's text is.
const cell = (name: string) => readFileSync(join(BUNDLED_SKILLS_DIR, "code-review", "cells", `${name}.md`), "utf-8").replace(/\r\n/g, "\n").trimEnd();

const write = (path: string, text: string) => {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text);
};

beforeAll(() => {
	write(join(demoDir, "SKILL.md"), "---\nname: demo\ndescription: A demo skill\nwhen_to_use: When the user asks for a demo.\n---\nDo the demo.\n");
	write(join(pluginDir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "kit" }));
	write(join(pluginDir, "skills", "tip", "SKILL.md"), "---\nname: tip\ndescription: A plugin skill\n---\n\nTip body.\n");
	write(join(pluginDir, "commands", "go.md"), "---\ndescription: Go command\n---\n\nRun go for $ARGUMENTS.\n");
	write(join(pluginDir, "commands", "silent.md"), "Run silently.\n");
	write(
		join(root, ".claude", "plugins", "installed_plugins.json"),
		JSON.stringify({ version: 2, plugins: { "kit@market": [{ scope: "user", installPath: pluginDir }] } }),
	);
	mkdirSync(join(root, "agent"), { recursive: true });
	vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
	stubHome(root);
});
beforeEach(() => invalidatePluginsCache());
afterAll(() => {
	vi.unstubAllEnvs();
	invalidatePluginsCache();
	rmSync(root, { recursive: true, force: true });
});

const frontier = { provider: "anthropic", id: "claude-opus-5-5", contextWindow: 200_000 };
const workhorse = { provider: "anthropic", id: "claude-sonnet-5", contextWindow: 200_000 };

async function mount(model: Record<string, unknown> = frontier, thinking = "medium") {
	const fake = createFakePi();
	(fake.pi as unknown as { getThinkingLevel: () => string }).getThinkingLevel = () => thinking;
	skillExtension(fake.pi as never);
	fake.setActiveTools(["skill"]);
	const ctx = createFakeCtx({ cwd, mode: "tui", hasUI: true, model });
	await fake.fire("session_start", { reason: "startup" }, ctx);
	const listings: string[] = [];
	fake.events.on(REMINDER_CHANNEL, (data) => {
		const reminder = data as { key?: string; text: string };
		if (reminder.key === "skills") listings.push(reminder.text);
	});
	const skills = [
		{ name: "demo", description: "A demo skill", filePath: join(demoDir, "SKILL.md") },
		{ name: "code-review", description: "Review the current diff", filePath: codeReviewFile },
	];
	const turn = () => fake.fire("before_agent_start", { systemPromptOptions: { skills } }, ctx);
	const call = async (params: Record<string, unknown>) =>
		(await fake.tools.get("skill")!.execute("t1", params, undefined, undefined, ctx)) as { content: { text: string }[]; isError?: boolean };
	return { fake, ctx, listings, turn, call };
}

describe("skills listing: Claude Code's order and lines", () => {
	it("lists project skills, then plugin commands and skills, then the bundled catalog", async () => {
		const { listings, turn } = await mount();
		await turn();
		const lines = listings.at(-1)!.split("\n").filter((line) => line.startsWith("- "));
		expect(lines.map((line) => line.split(": ")[0])).toEqual([
			"- demo",
			"- kit:go",
			"- kit:tip",
			"- code-review",
		]);
		expect(lines[0]).toBe("- demo: A demo skill - When the user asks for a demo.");
		expect(lines[1]).toBe("- kit:go: Go command");
		// A command with no description is not listed, as in Claude Code.
		expect(listings.at(-1)).not.toContain("kit:silent");
	});
});

describe("typed skills expand in the harness", () => {
	it("expands a typed /<plugin>:<skill> into the breadcrumb and the skill's text", async () => {
		const { fake, ctx } = await mount();
		// The session's first prompt: the typed text becomes the skill's message.
		const [outcome] = await fake.fire<{ action: string; text?: string }>("input", { text: "/kit:tip do it" }, ctx);
		expect(outcome.action).toBe("transform");
		expect(outcome.text).toBe(
			"<command-message>kit:tip</command-message>\n<command-name>/kit:tip</command-name>\n<command-args>do it</command-args>\n\n" +
				`Base directory for this skill: ${join(pluginDir, "skills", "tip")}\n\nTip body.\n\nARGUMENTS: do it\n`,
		);
		expect(fake.sentUserMessages).toHaveLength(0);
	});

	it("leaves text that only looks like a plugin skill, and a plugin command, to the user and the plugins extension", async () => {
		const { fake, ctx } = await mount();
		for (const text of ["/kit:nope", "/kit:go now", "/tmp/kit:tip"]) {
			const [outcome] = await fake.fire<{ action: string }>("input", { text }, ctx);
			expect(outcome.action, text).toBe("continue");
		}
		expect(fake.sentUserMessages).toHaveLength(0);
		expect(fake.sentMessages).toHaveLength(0);
	});
});

describe("skill tool: Claude Code's result", () => {
	it("answers Launching skill, with a plugin command's text beside it", async () => {
		const { turn, call } = await mount();
		await turn();
		const result = await call({ skill: "kit:go", args: "prod" });
		expect(result.content.map((block) => block.text)).toEqual(["Launching skill: kit:go", "Run go for prod."]);
	});

	it("gives a frontier session at medium effort the minimal prompt, with no folder named", async () => {
		const { turn, call } = await mount(frontier, "medium");
		await turn();
		const result = await call({ skill: "code-review", args: "123" });
		expect(result.content[0].text).toBe("Launching skill: code-review");
		expect(result.content[1].text).toBe(`${cell("minimal-prompt")}\n\n${cell("arguments-and-flags")}\n\nARGUMENTS: 123`);
	});

	it("gives a workhorse session Claude Code's Sonnet 5 cells, and a typed level wins over the session's", async () => {
		const high = await mount(workhorse, "high");
		await high.turn();
		expect((await high.call({ skill: "code-review", args: "main" })).content[1].text.startsWith(cell("high-3x5-recall-verify"))).toBe(true);
		const typed = await mount(frontier, "high");
		await typed.turn();
		const text = (await typed.call({ skill: "code-review", args: "low 123 --fix" })).content[1].text;
		expect(text.startsWith(cell("low-1-pass-max4"))).toBe(true);
		expect(text.endsWith("\n\nARGUMENTS: 123 --fix")).toBe(true);
	});

	it("uses the same cell when the user types /code-review", async () => {
		const { fake, ctx, turn } = await mount(workhorse, "xhigh");
		await turn();
		await fake.commands.get("code-review")!.handler("", ctx);
		const content = fake.sentMessages[0].message.content as Array<{ text: string }>;
		expect(content[0].text).toBe("<command-message>code-review</command-message>\n<command-name>/code-review</command-name>\n");
		expect(content[1].text).toBe(`${cell("xhigh-5x5-verify-sweep")}\n\n${cell("arguments-and-flags")}\n`);
	});
});
