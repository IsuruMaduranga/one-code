import { describe, expect, it } from "vitest";
import { extendingCompletions, withoutExactMatch } from "../../extensions/lib/argument-hints.ts";

describe("extendingCompletions", () => {
	it("offers only values longer than what was typed, and closes the menu on an exact match", () => {
		const options = [
			{ value: "presets", label: "presets" },
			{ value: "preset quality", label: "preset quality" },
			{ value: "report", label: "report" },
		];
		expect(extendingCompletions("pre", options)?.map((o) => o.value)).toEqual(["presets", "preset quality"]);
		expect(extendingCompletions("report", options)).toBeNull();
		expect(extendingCompletions("REPORT ", options)).toBeNull();
		expect(extendingCompletions("", options)).toHaveLength(3);
	});
});

describe("withoutExactMatch", () => {
	const items = [{ value: "list", label: "list" }, { value: "list --all", label: "list --all" }, { value: "trust", label: "trust" }];

	it("drops the fully typed value, and closes the menu when nothing longer is left", () => {
		const complete = withoutExactMatch((prefix: string) => items.filter((item) => item.value.startsWith(prefix)));
		expect((complete("list") as typeof items).map((item) => item.value)).toEqual(["list --all"]);
		expect(complete("trust")).toBeNull();
		expect(complete("tr")).toEqual([{ value: "trust", label: "trust" }]);
	});

	it("works for an async completer and passes null through", async () => {
		expect(await withoutExactMatch(async () => items)("TRUST ")).toEqual(items.slice(0, 2));
		expect(await withoutExactMatch(async () => null)("x")).toBeNull();
		const thenable = { then: (resolve: (v: typeof items) => void) => resolve(items) } as unknown as Promise<typeof items>;
		expect(await withoutExactMatch(() => thenable)("list")).toEqual(items.slice(1));
	});
});
