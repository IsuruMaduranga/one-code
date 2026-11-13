/**
 * The base's instruction files without a provider (lib/context/instructions.ts): what
 * a product that reads no Claude Code file gets. Each directory's AGENTS.md
 * and the product file, imports confined to the project, the same files on a
 * nested read and for the classifier; One Code's provider is covered by the
 * instructions and claude-rules tests.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openInstructions } from "../../extensions/lib/context/instructions.ts";
import { persistExternalIncludesApproval } from "../../extensions/lib/context/external-includes.ts";
import { resolveProfile, setActiveProfileForTest } from "../../extensions/lib/profile/profile.ts";
import { profile } from "../../profile/index.ts";
import { brand, envName } from "../../extensions/lib/profile/brand.mjs";

let root: string;
let home: string;
let cwd: string;
let state: string;
const write = (path: string, content: string) => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
	return path;
};

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "instructions-base-")));
	home = join(root, "home");
	cwd = join(root, "repo", "app");
	state = join(home, ".product");
	mkdirSync(cwd, { recursive: true });
	setActiveProfileForTest(resolveProfile({ ...profile, sources: undefined }, {}, "/profile"));
});
afterEach(() => {
	setActiveProfileForTest(undefined);
	rmSync(root, { recursive: true, force: true });
});

describe("the base's instruction files without a provider", () => {
	it("reads each directory's AGENTS.md farthest first and no CLAUDE.md, with the product files in their own list", () => {
		const outer = write(join(root, "repo", "AGENTS.md"), "outer\n");
		const inner = write(join(cwd, "AGENTS.md"), "inner\n");
		write(join(cwd, "CLAUDE.md"), "claude\n");
		write(join(home, ".claude", "CLAUDE.md"), "global claude\n");
		const product = write(join(cwd, brand.productFile), "product\n");
		const { contextFiles, productFiles } = openInstructions(home, undefined).sections({ cwd, homeProductDir: state, includeExternal: false });
		expect(contextFiles.map((file) => [file.path, file.descriptor, file.content])).toEqual([
			[outer, "agents", "outer\n"],
			[inner, "agents", "inner\n"],
		]);
		expect(productFiles.map((file) => file.path)).toEqual([product]);
		expect(openInstructions(home, undefined).paths({ cwd, homeProductDir: state }).map((entry) => entry.path)).toEqual([outer, inner, product]);
	});

	it("confines an AGENTS.md import to the project", () => {
		write(join(root, "outside.md"), "OUTSIDE\n");
		write(join(cwd, "inside.md"), "INSIDE\n");
		write(join(cwd, "AGENTS.md"), "@inside.md\n@../../outside.md\n");
		const [file] = openInstructions(home, undefined).sections({ cwd, homeProductDir: state, includeExternal: false }).contextFiles;
		expect(file.content).toContain("INSIDE");
		expect(file.content).not.toContain("OUTSIDE");
		expect(file.content).toContain("@../../outside.md");
	});

	it("attaches the AGENTS.md and product file between cwd and a read file, never cwd's own", () => {
		write(join(cwd, "AGENTS.md"), "top\n");
		const sub = write(join(cwd, "src", "AGENTS.md"), "sub\n");
		const subProduct = write(join(cwd, "src", brand.productFile), "sub product\n");
		write(join(cwd, "src", "CLAUDE.md"), "claude\n");
		const nested = openInstructions(home, undefined).nested({ filePath: join(cwd, "src", "main.ts"), cwd, includeExternal: false });
		expect(nested.map((file) => file.path)).toEqual([sub, subProduct]);
		expect(openInstructions(home, undefined).nested({ filePath: join(cwd, "main.ts"), cwd, includeExternal: false })).toEqual([]);
	});

	it("shows the classifier the same files, the product files last, and asks only about product imports", () => {
		const agents = write(join(cwd, "AGENTS.md"), "agents\n");
		const product = write(join(cwd, brand.productFile), "@../../outside.md\n");
		const outside = write(join(root, "outside.md"), "OUTSIDE\n");
		write(join(cwd, "CLAUDE.md"), "@../../outside.md\n");
		expect(openInstructions(home, undefined).classifier({ cwd, homeProductDir: state }).map((file) => file.path)).toEqual([agents, product]);
		expect(openInstructions(home, undefined).externalIncludes({ cwd, homeProductDir: state })).toEqual([{ path: realpathSync.native(outside), importer: brand.productFile }]);
	});

	it("gives every reader nothing while the agent's instruction files are off", () => {
		write(join(cwd, "AGENTS.md"), "agents\n");
		write(join(cwd, brand.productFile), "product\n");
		setActiveProfileForTest(resolveProfile(profile, { [envName("FEATURES_OFF")]: "instructions" }, "/profile"));
		const instructions = openInstructions(home, undefined);
		expect(instructions.sections({ cwd, homeProductDir: state })).toEqual({ contextFiles: [], productFiles: [] });
		expect(instructions.paths({ cwd, homeProductDir: state })).toEqual([]);
		expect(instructions.classifier({ cwd, homeProductDir: state })).toEqual([]);
	});

	it("shows the classifier a product file's approved external imports, as the agent gets them", () => {
		write(join(root, "rules.md"), "NEVER DEPLOY\n");
		write(join(cwd, brand.productFile), "@../../rules.md\n");
		const classifierText = () => openInstructions(home, undefined).classifier({ cwd, homeProductDir: state }).map((file) => file.content).join("\n");
		expect(classifierText()).not.toContain("NEVER DEPLOY");
		persistExternalIncludesApproval(cwd, home, true);
		expect(classifierText()).toContain("NEVER DEPLOY");
	});
});

