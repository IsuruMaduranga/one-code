/**
 * skill/index.ts wiring for scheduled work: a session's first skill turn goes
 * out as a user message (so pi's prompt preamble runs), a generated body
 * replaces the file's (lib/skill-body.ts, `/loop`), and a fired slash command
 * expands to the skill it names. Every path delivers Claude Code's typed-skill
 * message: the command breadcrumb, then the skill's text.
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import skillExtension from "../../extensions/skill/index.ts";
import { SKILL_BODY_CHANNEL, type SkillBodyQuery, SLASH_EXPAND_CHANNEL, type SlashExpandQuery } from "../../extensions/lib/skill-body.ts";
import { REMINDER_CHANNEL } from "../../extensions/lib/reminders.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const root = mkdtempSync(join(tmpdir(), "skill-wiring-"));
const cwd = join(root, "project");
const agentDir = join(root, "agent");
const skillDir = join(cwd, ".claude", "skills", "demo");
const argsSkillDir = join(cwd, ".claude", "skills", "every");

beforeAll(() => {
	mkdirSync(skillDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(skillDir, "SKILL.md"), "---\nname: demo\ndescription: A demo skill\n---\nDo the demo.\n");
	mkdirSync(argsSkillDir, { recursive: true });
	writeFileSync(join(argsSkillDir, "SKILL.md"), '---\nname: every\ndescription: Repeat a prompt\nargument-hint: "[interval] [prompt]"\n---\nRepeat it.\n');
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("HOME", root);
});
afterAll(() => {
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

async function mount() {
	const fake = createFakePi();
	skillExtension(fake.pi as never);
	const ctx = createFakeCtx({ cwd, mode: "tui", hasUI: true });
	await fake.fire("session_start", { reason: "startup" }, ctx);
	return { fake, ctx };
}

describe("skill wiring: scheduled work", () => {
	it("sends a session's first skill turn as a user message, later ones as the hidden custom message", async () => {
		const { fake, ctx } = await mount();
		await fake.commands.get("demo")!.handler("now", ctx);
		expect(fake.sentUserMessages).toHaveLength(1);
		expect(fake.sentUserMessages[0].content).toEqual([
			{ type: "text", text: "<command-message>demo</command-message>\n<command-name>/demo</command-name>\n<command-args>now</command-args>\n" },
			{ type: "text", text: `Base directory for this skill: ${skillDir}\n\nDo the demo.\n\nARGUMENTS: now\n` },
		]);
		expect(fake.sentMessages).toHaveLength(0);

		await fake.fire("before_agent_start", { systemPromptOptions: { skills: [] } }, ctx);
		await fake.commands.get("demo")!.handler("again", ctx);
		expect(fake.sentUserMessages).toHaveLength(1);
		expect(fake.sentMessages).toHaveLength(1);
	});

	it("uses a generated body, which carries its own arguments", async () => {
		const { fake, ctx } = await mount();
		fake.events.on(SKILL_BODY_CHANNEL, (data) => {
			const query = data as SkillBodyQuery;
			if (query.skill === "demo") query.body = `generated for ${query.args}`;
		});
		await fake.commands.get("demo")!.handler("5m x", ctx);
		const [breadcrumb, text] = fake.sentUserMessages[0].content as Array<{ text: string }>;
		expect(breadcrumb.text).toContain("<command-args>5m x</command-args>");
		expect(text.text).toBe(`Base directory for this skill: ${skillDir}\n\ngenerated for 5m x\n`);
	});

	it("expands a fired slash command naming a skill, bare or /skill:, and leaves anything else", async () => {
		const { fake } = await mount();
		const bare: SlashExpandQuery = { text: "/demo go", cwd };
		fake.events.emit(SLASH_EXPAND_CHANNEL, bare);
		expect(bare.expanded).toBe(
			`<command-message>demo</command-message>\n<command-name>/demo</command-name>\n<command-args>go</command-args>\nBase directory for this skill: ${skillDir}\n\nDo the demo.\n\nARGUMENTS: go\n`,
		);
		const prefixed: SlashExpandQuery = { text: "/skill:demo", cwd };
		fake.events.emit(SLASH_EXPAND_CHANNEL, prefixed);
		expect(prefixed.expanded).toContain("<command-name>/demo</command-name>\nBase directory for this skill:");
		const unknown: SlashExpandQuery = { text: "/nope", cwd };
		fake.events.emit(SLASH_EXPAND_CHANNEL, unknown);
		expect(unknown.expanded).toBeUndefined();
	});
});

describe("skill tool: a skill that takes arguments, called without any", () => {
	async function call(params: { skill: string; args?: string }): Promise<string> {
		const { fake, ctx } = await mount();
		// The tool reads the skills pi resolved for the turn.
		const skills = ["demo", "every"].map((name) => ({ name, filePath: join(cwd, ".claude", "skills", name, "SKILL.md") }));
		await fake.fire("before_agent_start", { systemPromptOptions: { skills } }, ctx);
		const result = (await fake.tools.get("skill")!.execute("t1", params, undefined, undefined, ctx)) as { content: { text: string }[] };
		expect(result.content[0].text).toBe(`Launching skill: ${params.skill}`);
		return result.content[1].text;
	}

	it("opens the result with a note naming the arguments", async () => {
		const text = await call({ skill: "every" });
		expect(text.startsWith("Stop and check before following this. This skill takes arguments ([interval] [prompt])")).toBe(true);
		expect(text).toContain(`Base directory for this skill: ${argsSkillDir}\n\nRepeat it.`);
		expect(text.endsWith("call the skill again with them in `args` instead of following them.")).toBe(true);
	});

	it("adds no note when arguments are passed or the skill declares none", async () => {
		expect(await call({ skill: "every", args: "5m ping" })).toBe(`Base directory for this skill: ${argsSkillDir}\n\nRepeat it.\n\nARGUMENTS: 5m ping`);
		expect(await call({ skill: "every", args: "  " })).toContain("This skill takes arguments ([interval] [prompt])");
		expect(await call({ skill: "demo" })).toBe(`Base directory for this skill: ${skillDir}\n\nDo the demo.`);
	});
});

describe("skill tool: disable-model-invocation", () => {
	const deployDir = join(cwd, ".claude", "skills", "deploy");
	const quotedDir = join(cwd, ".claude", "skills", "release");
	beforeAll(() => {
		mkdirSync(deployDir, { recursive: true });
		writeFileSync(join(deployDir, "SKILL.md"), "---\nname: deploy\ndescription: Ship to production\ndisable-model-invocation: true\n---\nDeploy it.\n");
		mkdirSync(quotedDir, { recursive: true });
		writeFileSync(join(quotedDir, "SKILL.md"), '---\nname: release\ndescription: Cut a release\ndisable-model-invocation: "true"\n---\nRelease it.\n');
	});

	async function turn() {
		const { fake, ctx } = await mount();
		const listings: string[] = [];
		fake.events.on(REMINDER_CHANNEL, (data) => {
			const reminder = data as { key?: string; text: string };
			if (reminder.key === "skills") listings.push(reminder.text);
		});
		const skills = [
			{ name: "demo", filePath: join(skillDir, "SKILL.md") },
			// pi reads a YAML `true` into the flag; the quoted form arrives unset.
			{ name: "deploy", filePath: join(deployDir, "SKILL.md"), disableModelInvocation: true },
			{ name: "release", filePath: join(quotedDir, "SKILL.md") },
		];
		await fake.fire("before_agent_start", { systemPromptOptions: { skills } }, ctx);
		const call = async (params: Record<string, unknown>) =>
			(await fake.tools.get("skill")!.execute("t1", params, undefined, undefined, ctx)) as { content: { text: string }[]; isError?: boolean };
		return { fake, ctx, listing: listings.at(-1) ?? "", call };
	}

	it("leaves the skill out of the model's listing, yaml or quoted flag", async () => {
		const { listing, call } = await turn();
		expect(listing).toContain("- demo");
		expect(listing).not.toContain("deploy");
		expect(listing).not.toContain("release");
		expect((await call({ list: true })).content[0].text).not.toMatch(/deploy|release/);
	});

	it("refuses the skill in the tool with Claude Code's message", async () => {
		const { call } = await turn();
		for (const name of ["deploy", "release", "/deploy"]) {
			const result = await call({ skill: name });
			expect(result.isError, name).toBe(true);
			expect(result.content[0].text).toBe(`Skill ${name.replace(/^\//, "")} cannot be used with Skill tool due to disable-model-invocation`);
			expect(result.content[0].text).not.toContain("Deploy it.");
		}
	});

	it("refuses a skill from the turn after its flag was added", async () => {
		const lateDir = join(cwd, ".claude", "skills", "late");
		mkdirSync(lateDir, { recursive: true });
		const file = join(lateDir, "SKILL.md");
		writeFileSync(file, "---\nname: late\ndescription: Added later\n---\nLate body.\n");
		const { fake, ctx } = await mount();
		await fake.fire("before_agent_start", { systemPromptOptions: { skills: [{ name: "late", filePath: file }] } }, ctx);
		const call = async () =>
			(await fake.tools.get("skill")!.execute("t1", { skill: "late" }, undefined, undefined, ctx)) as { content: { text: string }[]; isError?: boolean };
		expect((await call()).isError).toBeFalsy();
		writeFileSync(file, '---\nname: late\ndescription: Added later\ndisable-model-invocation: "true"\n---\nLate body.\n');
		const later = new Date(Date.now() + 5_000);
		utimesSync(file, later, later);
		// The next turn re-reads the flag (the old cache kept the first read for the session).
		await fake.fire("before_agent_start", { systemPromptOptions: { skills: [{ name: "late", filePath: file }] } }, ctx);
		expect((await call()).content[0].text).toBe("Skill late cannot be used with Skill tool due to disable-model-invocation");
	});

	it("still runs when the user types the command", async () => {
		const { fake, ctx } = await turn();
		await fake.commands.get("deploy")!.handler("", ctx);
		expect(JSON.stringify([...fake.sentUserMessages, ...fake.sentMessages])).toContain("Deploy it.");
	});
});
