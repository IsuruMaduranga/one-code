/**
 * The settings files of the profile in force, for tests that write one. The
 * paths come from the settings ladder the base reads (lib/claude-settings.ts
 * `settingsSources`), so a test writes the file the code under test reads on
 * any profile.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { isRepoFile, primarySettingsFile, settingsSources } from "../../../extensions/lib/claude-settings.ts";
import { activeProfile, profileModuleKey, setActiveProfileForTest } from "../../../extensions/lib/profile.ts";
import { shareModuleForTest } from "../../../extensions/lib/shared-module.ts";
import { projectConfigDir, type SourceProvider } from "../../../extensions/lib/sources.ts";

function writeJson(path: string, value: object): string {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value));
	return path;
}

/** The primary user settings file: the one holding the keys a user edits by hand. */
export function userSettingsPath(cwd: string, home: string = os.homedir()): string {
	const file = primarySettingsFile(settingsSources(cwd, home));
	if (!file) throw new Error("the profile in force has no primary settings file");
	return file.path;
}

/** Writes `settings` to the primary user settings file and returns its path. */
export function writeUserSettings(cwd: string, home: string, settings: object): string {
	return writeJson(userSettingsPath(cwd, home), settings);
}

/** The repository's own settings file, which needs consent before its grants apply. */
export function repositorySettingsPath(cwd: string, home: string = os.homedir()): string {
	const file = settingsSources(cwd, home).find(isRepoFile);
	if (!file) throw new Error("the profile in force reads no repository settings file (call useRepositorySettings())");
	return file.path;
}

/** Writes `settings` to the repository's settings file and returns its path. */
export function writeRepositorySettings(cwd: string, home: string, settings: object): string {
	return writeJson(repositorySettingsPath(cwd, home), settings);
}

const TEST_PROVIDER = join(import.meta.dirname, "repository-settings-provider");

/**
 * A source provider in the shape of One Code's: it borrows another tool's
 * files, a user file (the primary one) and the repository's `settings.json`
 * in the project config folder, both of the borrowed family.
 */
const repositorySettingsProvider: SourceProvider = {
	open: ({ home }) => ({
		settings: (base, { cwd }) => [
			...base,
			{ path: join(home, ".borrowed", "settings.json"), scope: "user", owner: "borrowed", primary: true, label: "borrowed user settings" },
			{ path: join(projectConfigDir(cwd), "settings.json"), scope: "project", owner: "borrowed", repo: true, label: "project settings" },
		],
	}),
};

/**
 * For tests of the repository-trust prompt, which fires only on a repository
 * settings file. The base reads one only when the profile's source provider
 * lists it (One Code's lists `<cwd>/.claude/settings.json`). On a profile
 * without a provider, this installs one through the profile's own seam for
 * each test of the calling file (call it at the top of a file or `describe`).
 * Write the files with `writeUserSettings` and `writeRepositorySettings`.
 */
export function useRepositorySettings(): void {
	let installed = false;
	beforeEach(() => {
		if (activeProfile().sourcesModule) return;
		shareModuleForTest(profileModuleKey(TEST_PROVIDER), { sources: repositorySettingsProvider });
		setActiveProfileForTest({ ...activeProfile(), sourcesModule: TEST_PROVIDER });
		installed = true;
	});
	afterEach(() => {
		if (installed) setActiveProfileForTest(undefined);
		installed = false;
	});
}
