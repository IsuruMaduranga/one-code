/**
 * Finds the source files that name a Claude Code location, for the guards
 * that keep those files on a checked list: the base's protective lists
 * (test/unit/claude-locations-guard.test.ts) and the profile's readers
 * (One Code's profile/test/claude-locations-profile.test.ts).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Spellings of a Claude Code location in our source. */
const CLAUDE_LOCATION =
	/claudeUserDir\(|claudeConfigDir\(|claudeJsonPath\(|claudeManagedDir\(|claudeUserSettingsPath\(|settingsPaths\(|managedSettingsPaths\(|isClaudeLocation\(|["'`/]\.claude["'`/]|["'`]CLAUDE(\.local)?\.md["'`]/;

/** Source without block and line comments, so a path named in prose is not a reader (`//` after `:` is a URL). */
function withoutComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function walk(dir: string, skip: string[]): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (skip.includes(path)) return [];
		if (statSync(path).isDirectory()) return walk(path, skip);
		return name.endsWith(".ts") || name.endsWith(".mjs") ? [path] : [];
	});
}

/** The `.ts` and `.mjs` files under `dir` (but not under `skip`) that name a Claude Code location, relative to `dir` with forward slashes. */
export function filesNamingClaudeLocations(dir: string, skip: string[] = []): string[] {
	return walk(dir, skip)
		.filter((path) => CLAUDE_LOCATION.test(withoutComments(readFileSync(path, "utf8"))))
		.map((path) => relative(dir, path).split("\\").join("/"));
}

/**
 * Compares the files that name a Claude Code location with an allowlist:
 * `unlisted` name one without a listed reason, `stale` are listed but no
 * longer name one.
 */
export function compareWithAllowlist(naming: string[], allowed: Record<string, string>): { unlisted: string[]; stale: string[] } {
	return {
		unlisted: naming.filter((file) => !(file in allowed)),
		stale: Object.keys(allowed).filter((file) => !naming.includes(file)),
	};
}
