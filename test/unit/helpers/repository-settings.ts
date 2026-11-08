/**
 * A repository settings file for tests of the repository-trust prompt, on any
 * profile. The base reads a repository's settings file only when the
 * profile's source provider lists one (One Code's lists `<cwd>/.claude/settings.json`);
 * a profile without a provider lists none, so the prompt could never fire.
 * Mock lib/claude-settings.ts with this to list `<cwd>/.claude/settings.json`
 * as a repository file of the primary family when the profile does not:
 *
 *   vi.mock("../../extensions/lib/claude-settings.ts", async (importOriginal) =>
 *     (await import("./helpers/repository-settings.ts")).withRepositorySettings(await importOriginal()));
 */
import { join } from "node:path";
import type * as ClaudeSettings from "../../../extensions/lib/claude-settings.ts";

export function withRepositorySettings(actual: typeof ClaudeSettings): typeof ClaudeSettings {
	return {
		...actual,
		settingsSources: (...args: Parameters<typeof actual.settingsSources>) => {
			const files = actual.settingsSources(...args);
			const path = join(args[0], ".claude", "settings.json");
			if (files.some((file) => file.path === path)) return files;
			const owner = actual.primarySettingsFile(files)?.owner ?? "product";
			return [...files, { path, scope: "project" as const, owner, repo: true, label: "project settings" }];
		},
	};
}
