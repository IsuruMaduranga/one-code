/**
 * lib/string-enum.ts: the plain `{ type: "string", enum }` schema the tools
 * declare (providers reject anyOf/const patterns), with a description and a
 * default only when given.
 */
import { describe, expect, it } from "vitest";
import { StringEnum } from "../../extensions/lib/string-enum.ts";

describe("StringEnum", () => {
	it("is a string schema listing the values", () => {
		expect({ ...StringEnum(["a", "b"] as const) }).toEqual({ type: "string", enum: ["a", "b"] });
	});

	it("carries a description and a default only when given", () => {
		expect({ ...StringEnum(["a", "b"] as const, { description: "Pick one" }) }).toEqual({ type: "string", enum: ["a", "b"], description: "Pick one" });
		expect({ ...StringEnum(["a", "b"] as const, { default: "b" }) }).toEqual({ type: "string", enum: ["a", "b"], default: "b" });
		const schema = StringEnum(["a"] as const, {});
		expect("description" in schema).toBe(false);
		expect("default" in schema).toBe(false);
	});
});
