/** A child session's built-in tools carry the user's wording (tools/tool-style/child.ts), and nothing changes without one. */
import { afterEach, describe, expect, it } from "vitest";
import { activeProfile, setActiveProfileForTest } from "../../extensions/lib/profile/profile.ts";
import childToolStyle from "../../extensions/tools/tool-style/child.ts";
import { createFakePi } from "./helpers/fake-pi.ts";

describe("a child session's built-in tools", () => {
	afterEach(() => setActiveProfileForTest(undefined));

	it("are left to pi when the user words none of them", () => {
		const fake = createFakePi();
		childToolStyle(fake.pi as never);
		expect([...fake.tools.keys()]).toEqual([]);
	});

	it("are registered again with the user's wording, and only the worded ones", () => {
		const user = { name: "lean", dir: "/u/lean", toolsOff: [], toolsDeferred: [], toolsEager: [], featuresOff: [], toolWording: new Map([["read", { append: "Read whole files." }]]), hash: "h" };
		setActiveProfileForTest({ ...activeProfile(), user });
		const fake = createFakePi();
		childToolStyle(fake.pi as never);
		expect([...fake.tools.keys()]).toEqual(["read"]);
		expect(fake.tools.get("read")?.description?.endsWith("\n\nRead whole files.")).toBe(true);
	});
});
