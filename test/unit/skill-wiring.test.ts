/**
 * skill/index.ts wiring for scheduled work: a session's first skill turn goes
 * out as a user message (so pi's prompt preamble runs), a generated body
 * replaces the file's (lib/skill-body.ts, `/loop`), and a fired slash command
 * expands to the skill it names.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import skillExtension from "../../extensions/skill/index.ts";
import { SKILL_BODY_CHANNEL, type SkillBodyQuery, SLASH_EXPAND_CHANNEL, type SlashExpandQuery } from "../../extensions/lib/skill-body.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const root = mkdtempSync(join(tmpdir(), "skill-wiring-"));
const cwd = join(root, "project");
const agentDir = join(root, "agent");
const skillDir = join(cwd, ".claude", "skills", "demo");

beforeAll(() => {
	mkdirSync(skillDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(skillDir, "SKILL.md"), "---\nname: demo\ndescription: A demo skill\n---\nDo the demo.\n");
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
		expect(String(fake.sentUserMessages[0].content)).toContain('<skill name="demo"');
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
		const block = String(fake.sentUserMessages[0].content);
		expect(block).toContain("generated for 5m x\n</skill>");
		expect(block.endsWith("</skill>")).toBe(true);
	});

	it("expands a fired slash command naming a skill, bare or /skill:, and leaves anything else", async () => {
		const { fake } = await mount();
		const bare: SlashExpandQuery = { text: "/demo go", cwd };
		fake.events.emit(SLASH_EXPAND_CHANNEL, bare);
		expect(bare.expanded).toContain("Do the demo.\n</skill>\n\ngo");
		const prefixed: SlashExpandQuery = { text: "/skill:demo", cwd };
		fake.events.emit(SLASH_EXPAND_CHANNEL, prefixed);
		expect(prefixed.expanded).toContain('<skill name="demo"');
		const unknown: SlashExpandQuery = { text: "/nope", cwd };
		fake.events.emit(SLASH_EXPAND_CHANNEL, unknown);
		expect(unknown.expanded).toBeUndefined();
	});
});
