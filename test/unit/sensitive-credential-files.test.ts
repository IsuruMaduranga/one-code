/**
 * Credential files of common tools are on the outside-read denylist, so a read
 * of one is never cleared without the classifier or a prompt; their in-project
 * namesakes stay ordinary files.
 */
import { describe, expect, it } from "vitest";
import { isSensitivePath } from "../../extensions/lib/shell/sensitive.ts";

describe("the credential denylist", () => {
	it.each([
		"/home/dana/.config/op/config",
		"/home/dana/.gemini/oauth_creds.json",
		"/home/dana/.config/rclone/rclone.conf",
		"/home/dana/.config/sops/age/keys.txt",
		"/home/dana/.password-store/work/db.gpg",
		"/home/dana/.my.cnf",
		"/home/dana/.s3cfg",
		"/home/dana/.boto",
		"/home/dana/.gradle/gradle.properties",
		"/home/dana/.config/hub",
		"/home/dana/.config/google-chrome/Default/Cookies",
		"/Users/dana/Library/Application Support/Google/Chrome/Default/Cookies",
	])("lists %s", (path) => {
		expect(isSensitivePath(path)).toBe(true);
	});

	it.each(["/work/app/gradle.properties", "/work/app/android/gradle.properties", "/work/app/.gemini/settings.json", "/work/app/src/config/hub.ts", "/work/app/docs/chrome/google.md", "/work/app/src/main/java/com/google/chrome/Foo.java", "/Users/dana/work/google/chrome/my-extension/src/index.ts"])(
		"leaves %s alone",
		(path) => {
			expect(isSensitivePath(path)).toBe(false);
		},
	);
});
