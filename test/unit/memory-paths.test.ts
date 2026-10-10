import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import memoryExtension from "../../extensions/memory/index.ts";
import { resolveThroughLinks } from "../../extensions/auto-mode/paths.ts";
import { resetConfigModeForTest } from "../../extensions/lib/config-mode.ts";
import { projectMemoryDir } from "../../extensions/lib/memory.ts";
import { INDEX_OVER_LIMIT_ERROR } from "../../extensions/lib/memory-content.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { stubHome } from "./helpers/home.ts";

let root: string;
let cwd: string;
let dir: string;
const fact = "---\nname: fact\nmetadata:\n  type: project\n---\nA fact.\n";
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "memory-paths-"));
	stubHome(root);
	vi.stubEnv("ONECODE_STATE_DIR", join(root, ".onecode"));
	resetConfigModeForTest("claude-compatible");
	cwd = join(root, "project");
	mkdirSync(cwd);
	dir = projectMemoryDir(cwd);
});
afterEach(() => {
	vi.unstubAllEnvs();
	resetConfigModeForTest();
	rmSync(root, { recursive: true, force: true });
});

async function mount() {
	const fake = createFakePi();
	memoryExtension(fake.pi as never);
	const ctx = createFakeCtx({ cwd });
	await fake.fire("session_start", {}, ctx);
	return { fake, ctx };
}

const spellings = {
	absolute: (path: string) => path,
	tilde: (path: string) => `~/${relative(root, path)}`,
	at: (path: string) => `@${path}`,
	url: (path: string) => pathToFileURL(path).href,
	dot: (path: string) => `${dir}/../memory/${relative(dir, path)}`,
};

describe("memory file-tool paths", () => {
	it.each(Object.keys(spellings) as Array<keyof typeof spellings>)("stamps the file pi writes using %s spelling", async (spelling) => {
		const { fake, ctx } = await mount();
		const input = { path: spellings[spelling](join(dir, "fact.md")), content: fact };
		await fake.fire("tool_call", { toolName: "write", input }, ctx);
		expect(input.content).toContain("node_type: memory");
	});

	it.each(Object.keys(spellings) as Array<keyof typeof spellings>)("checks the index limit using %s spelling", async (spelling) => {
		const { fake, ctx } = await mount();
		const path = join(dir, "MEMORY.md");
		writeFileSync(path, Array(201).fill("- entry").join("\n"));
		const [result] = await fake.fire("tool_result", {
			toolName: "write", input: { path: spellings[spelling](path) }, isError: false, content: [{ type: "text", text: "Written" }],
		}, ctx);
		expect(result).toMatchObject({ isError: true, content: expect.arrayContaining([{ type: "text", text: INDEX_OVER_LIMIT_ERROR }]) });
	});

	it("does not stamp an absolute traversal out of memory", async () => {
		const { fake, ctx } = await mount();
		const input = { path: `${dir}/../ordinary.md`, content: fact };
		await fake.fire("tool_call", { toolName: "write", input }, ctx);
		expect(input.content).toBe(fact);
	});

	it("does not stamp a symlink target outside memory", async () => {
		const { fake, ctx } = await mount();
		const target = join(root, "ordinary.md");
		writeFileSync(target, fact);
		const link = join(dir, "linked.md");
		symlinkSync(target, link);
		const input = { path: link, content: fact };
		await fake.fire("tool_call", { toolName: "write", input }, ctx);
		expect(input.content).toBe(fact);
		expect(readFileSync(target, "utf8")).toBe(fact);
	});

	it("does not recurse indefinitely while resolving a cyclic memory symlink", async () => {
		const { fake, ctx } = await mount();
		const path = join(dir, "cycle.md");
		symlinkSync(path, path);
		const input = { path, content: fact };
		const started = Date.now();
		await expect(fake.fire("tool_call", { toolName: "write", input }, ctx)).resolves.toEqual([undefined]);
		// Unbounded, the resolver overflowed the stack (seconds) before falling back.
		expect(Date.now() - started).toBeLessThan(1_000);
		expect(resolveThroughLinks(path)).toBe(join(realpathSync.native(dir), "cycle.md"));
	});

	it.each([".claude", "relocated-claude"])("does not create memory through an independent state alias into %s", async (name) => {
		resetConfigModeForTest("independent");
		const claude = join(root, name);
		vi.stubEnv("CLAUDE_CONFIG_DIR", claude);
		mkdirSync(claude);
		mkdirSync(join(root, ".onecode"));
		symlinkSync(claude, join(root, ".onecode", "projects"), "dir");
		const independentDir = projectMemoryDir(cwd);
		await mount();
		expect(existsSync(independentDir)).toBe(false);
	});

	it("checks writes through an alias of the index", async () => {
		const { fake, ctx } = await mount();
		const path = join(dir, "MEMORY.md");
		writeFileSync(path, Array(201).fill("- entry").join("\n"));
		const alias = join(dir, "index-alias.md");
		symlinkSync(path, alias);
		const [result] = await fake.fire("tool_result", { toolName: "edit", input: { path: alias }, content: [], isError: false }, ctx);
		expect(result).toMatchObject({ isError: true });
	});
});
