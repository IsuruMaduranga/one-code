/**
 * Skill folders for the skill-scan tests (plugin-stores and its One Code
 * sibling): the four roots `scanSkills` reads under one temp folder, and a
 * writer for one skill.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The project, home, agent dir and bundled catalog a skill scan reads, under `root`. */
export function skillScanDirs(root: string) {
	return { cwd: join(root, "proj"), home: join(root, "home"), agentDir: join(root, "agent"), bundled: join(root, "bundled-skills") };
}

/** Writes `<base>/<folder>/SKILL.md` with the given frontmatter lines and body. */
export function writeSkill(base: string, folder: string, frontmatter = `name: ${folder}\ndescription: d`, body = "body"): void {
	mkdirSync(join(base, folder), { recursive: true });
	writeFileSync(join(base, folder, "SKILL.md"), `---\n${frontmatter}\n---\n${body}`);
}
