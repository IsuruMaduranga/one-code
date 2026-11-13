/**
 * The settings ladder marks the files a repository controls by their role,
 * whatever a provider says (lib/profile/settings-files.ts `withRepoFiles`):
 * such a file may not select a permission mode or approve its own servers,
 * and it is never the primary file.
 */
import { describe, expect, it } from "vitest";
import { isRepoFile, withRepoFiles } from "../../extensions/lib/profile/settings-files.ts";
import type { SettingsFile } from "../../extensions/lib/profile/sources.ts";

const file = (scope: SettingsFile["scope"], owner: SettingsFile["owner"], extra: Partial<SettingsFile> = {}): SettingsFile => ({ path: `/x/${owner}-${scope}.json`, scope, owner, label: `${owner} ${scope}`, ...extra });

describe("the files a repository controls", () => {
	it("are a checked-in file and another tool's per-project file, flagged or not", () => {
		const marked = withRepoFiles([file("user", "borrowed"), file("project", "borrowed"), file("local", "borrowed"), file("managed", "borrowed"), file("user", "product"), file("local", "product"), file("project", "product")]);
		expect(marked.filter(isRepoFile).map((f) => f.label)).toEqual(["borrowed project", "borrowed local", "product project"]);
	});

	it("keeps a flag a provider set and adds nothing to a user's or a managed file", () => {
		const user = file("user", "borrowed", { primary: true });
		expect(withRepoFiles([user])[0]).toBe(user);
		expect(isRepoFile(withRepoFiles([file("user", "borrowed", { repo: true })])[0])).toBe(true);
	});
});
