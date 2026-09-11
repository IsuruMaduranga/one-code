import { describe, expect, it } from "vitest";
import { withoutUnusable } from "../../extensions/lib/model-unusable.ts";

const model = (provider: string, id: string) => ({ provider, id, name: id }) as any;

describe("withoutUnusable", () => {
	it("drops exactly the provider/id specs the session found unusable, and is the identity when none are", () => {
		const catalog = [model("openai-codex", "gpt-5.3-codex-spark"), model("openai-codex", "gpt-5.6-terra"), model("anthropic", "claude-sonnet-5")];
		expect(withoutUnusable(catalog, new Set())).toBe(catalog);
		expect(withoutUnusable(catalog, new Set(["openai-codex/gpt-5.3-codex-spark"])).map((m) => m.id)).toEqual(["gpt-5.6-terra", "claude-sonnet-5"]);
		// Same id on another provider is a different model.
		expect(withoutUnusable(catalog, new Set(["openai/gpt-5.6-terra"]))).toHaveLength(3);
	});
});
