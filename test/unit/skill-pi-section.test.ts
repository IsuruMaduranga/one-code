/**
 * One skills instruction per session: with the skill tool, the listing for
 * that tool and no pi "read the file" section in the prompt; without it,
 * pi's section and no listing (a child agent limited to read and bash).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import skillExtension from "../../extensions/skill/index.ts";
import { withoutPiSkillsBlock } from "../../extensions/skill/listing.ts";
import { REMINDER_CHANNEL } from "../../extensions/lib/reminders.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
// pi's own renderer, by file: the strip must match what the installed pi produces.
import { buildSystemPrompt } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";

const PI_SECTION =
	"\n\nThe following skills provide specialized instructions for specific tasks.\nUse the read tool to load a skill's file when the task matches its description.\n\n<available_skills>\n  <skill>\n    <name>demo</name>\n  </skill>\n</available_skills>";

describe("withoutPiSkillsBlock", () => {
	it("removes pi's section and leaves the rest of the prompt", () => {
		expect(withoutPiSkillsBlock(`You are an agent.${PI_SECTION}\nCurrent date: today`)).toBe("You are an agent.\nCurrent date: today");
	});

	it("removes the section the installed pi renders into an agent's own prompt", () => {
		const rendered: string = buildSystemPrompt({
			customPrompt: "You are a reviewing agent.",
			selectedTools: ["read", "bash"],
			cwd: "/p",
			skills: [{ name: "demo", description: "A demo skill", filePath: "/p/.claude/skills/demo/SKILL.md", baseDir: "/p/.claude/skills/demo", source: "project", disableModelInvocation: false }],
		} as never);
		expect(rendered).toContain("Use the read tool to load a skill's file");
		const stripped = withoutPiSkillsBlock(rendered);
		expect(stripped).not.toContain("The following skills provide specialized instructions");
		expect(stripped).not.toContain("<available_skills>");
		expect(stripped).toContain("You are a reviewing agent.");
	});

	it("returns a prompt without the section unchanged", () => {
		expect(withoutPiSkillsBlock("You are an agent.")).toBe("You are an agent.");
	});
});

describe("skill extension: one skills instruction per session", () => {
	const turn = async (active: string[]) => {
		const fake = createFakePi();
		skillExtension(fake.pi as never);
		fake.setActiveTools(active);
		const listings: string[] = [];
		fake.events.on(REMINDER_CHANNEL, (data) => {
			const payload = data as { key?: string; text?: string };
			if (payload.key === "skills" && payload.text) listings.push(payload.text);
		});
		const cwd = mkdtempSync(join(tmpdir(), "skill-pi-section-"));
		const ctx = createFakeCtx({ cwd, mode: "tui", hasUI: true });
		await fake.fire("session_start", { reason: "startup" }, ctx);
		const skills = [{ name: "demo", description: "A demo skill", filePath: join(cwd, "demo", "SKILL.md") }];
		const result = await fake.fireOne<{ systemPrompt?: string }>(
			"before_agent_start",
			{ prompt: "hi", systemPrompt: `You are an agent.${PI_SECTION}`, systemPromptOptions: { skills } },
			ctx,
		);
		return { listings, result };
	};

	it("with the skill tool: lists skills for it and strips pi's section", async () => {
		const { listings, result } = await turn(["read", "skill"]);
		expect(listings.join("\n")).toContain("available for use with the Skill tool");
		expect(result?.systemPrompt).toBe("You are an agent.");
	});

	it("without the skill tool: keeps pi's section and lists nothing", async () => {
		const { listings, result } = await turn(["read", "bash"]);
		expect(listings).toEqual([]);
		expect(result?.systemPrompt).toBeUndefined();
	});
});
