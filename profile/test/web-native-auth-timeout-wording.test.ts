/**
 * One Code's wording of a server-side web call that gave up waiting on
 * authentication. That the base stops at the deadline and reports it is
 * tested in test/unit/web-native-auth-timeout.test.ts.
 */
import { describe, expect, it } from "vitest";
import { nativeWeb } from "../text/native-web/index.ts";

describe("native web authentication deadline, in One Code's words", () => {
	it("names the deadline in seconds", () => {
		expect(nativeWeb.fallback({ kind: "authTimeout", seconds: 120 })).toContain("120 seconds");
	});
});
