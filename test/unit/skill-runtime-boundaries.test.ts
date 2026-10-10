import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import skillExtension from "../../extensions/skill/index.ts";
import { pluginRoot } from "../../extensions/lib/plugin-root.ts";
import { setSkillState } from "../../extensions/lib/skill-overrides.ts";
import { scopeForPath } from "../../extensions/lib/skill-scan.ts";
import { SLASH_EXPAND_CHANNEL, type SlashExpandQuery } from "../../extensions/lib/skill-body.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

let root: string;
let cwd: string;
let agentDir: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "skill-boundaries-"));
	cwd = join(root, "project");
	agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	vi.stubEnv("HOME", root);
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

function skill(dir: string, frontmatter = "description: Demo", body = "Run the demo."): string {
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "SKILL.md");
	writeFileSync(file, `---\n${frontmatter}\n---\n${body}\n`);
	return file;
}

async function mount() {
	const fake = createFakePi();
	skillExtension(fake.pi as never);
	fake.setActiveTools(["skill"]);
	const ctx = createFakeCtx({ cwd, mode: "json" });
	await fake.fire("session_start", { reason: "startup" }, ctx);
	const call = async (name: string) => await fake.tools.get("skill")!.execute("t1", { skill: name }, undefined, undefined, ctx) as {
		content: { text: string }[]; isError?: boolean;
	};
	return { fake, ctx, call };
}

describe("skill runtime boundaries", () => {
	it("keeps an off ~/.agents skill off after pi adopts the turn's skills", async () => {
		const file = skill(join(root, ".agents", "skills", "demo"));
		setSkillState(pluginRoot(agentDir), "user:demo", "off");
		const { fake, ctx, call } = await mount();
		expect((await call("demo")).isError).toBe(true);
		await fake.fire("before_agent_start", { systemPromptOptions: { skills: [{ name: "demo", filePath: file }] } }, ctx);
		const result = await call("demo");
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("turned off");
	});

	it("classifies only descendants of user skill directories as user scope", () => {
		expect(scopeForPath(join(root, ".agents", "skills", "demo", "SKILL.md"), root, agentDir)).toBe("user");
		expect(scopeForPath(join(root, ".claude", "skills-other", "demo", "SKILL.md"), root, agentDir)).toBe("project");
		expect(scopeForPath(join(agentDir, "skills-other", "demo", "SKILL.md"), root, agentDir)).toBe("project");
	});

	it.runIf(process.platform !== "linux")("matches a user skill directory spelled in another case on a case-folding filesystem", () => {
		expect(scopeForPath(join(root, ".AGENTS", "Skills", "demo", "SKILL.md"), root, agentDir)).toBe("user");
	});

	it("uses the declared name and its off override before the first turn", async () => {
		skill(join(cwd, ".claude", "skills", "folder"), "name: actual\ndescription: Demo");
		setSkillState(pluginRoot(agentDir), "project:actual", "off");
		const { fake, ctx } = await mount();
		const input = (text: string) => fake.fireOne<{ action: string; text?: string }>("input", { text, source: "interactive" }, ctx);
		expect(await input("/skill:actual")).toEqual({ action: "handled" });
		expect(await input("/skill:folder")).toEqual({ action: "continue" });
	});

	it("enforces disable-model-invocation added between tool calls in the same turn", async () => {
		const dir = join(cwd, ".claude", "skills", "demo");
		const file = skill(dir);
		const { fake, ctx, call } = await mount();
		await fake.fire("before_agent_start", { systemPromptOptions: { skills: [{ name: "demo", filePath: file }] } }, ctx);
		expect((await call("demo")).isError).toBeFalsy();
		skill(dir, 'description: Demo\ndisable-model-invocation: "true"');
		const later = new Date(Date.now() + 5_000);
		utimesSync(file, later, later);
		const result = await call("demo");
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("disable-model-invocation");
	});

	it("preserves large bodies and leaves outside-file references as text", async () => {
		const outside = join(root, "outside.txt");
		writeFileSync(outside, "PRIVATE_OUTSIDE_SENTINEL");
		const body = `@${outside}\n[reference](${outside})\n${"large body ".repeat(30_000)}END_OF_SKILL`;
		const file = skill(join(cwd, ".claude", "skills", "demo"), "description: Demo", body);
		const { fake, ctx, call } = await mount();
		await fake.fire("before_agent_start", { systemPromptOptions: { skills: [{ name: "demo", filePath: file }] } }, ctx);
		const result = await call("demo");
		expect(result.content[1].text).toContain(body);
		expect(result.content[1].text).not.toContain("PRIVATE_OUTSIDE_SENTINEL");
	});

	it("loads recoverable broken frontmatter for typed and scheduled skills as well as the tool", async () => {
		skill(join(cwd, ".claude", "skills", "demo"), "description: Demo: unquoted colon");
		const { fake, ctx, call } = await mount();
		const typed = await fake.fireOne<{ action: string; text?: string }>("input", { text: "/skill:demo", source: "interactive" }, ctx);
		expect(typed?.action).toBe("transform");
		expect(typed?.text).toContain("Run the demo.");
		await fake.fire("before_agent_start", { systemPromptOptions: { skills: [] } }, ctx);
		expect((await call("demo")).content[1].text).toContain("Run the demo.");
		const query: SlashExpandQuery = { text: "/demo", cwd };
		fake.events.emit(SLASH_EXPAND_CHANNEL, query);
		expect(query.expanded).toContain("Run the demo.");
	});
});
