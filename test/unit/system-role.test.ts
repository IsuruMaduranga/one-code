import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { withBetas } from "../../extensions/lib/anthropic-payload.ts";
import { systemRoleLayout } from "../../extensions/lib/system-role.ts";

async function bundledCatalog(): Promise<Model<Api>[]> {
	// Read from the repo's node_modules, as model-tier-catalog.test.ts does.
	const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
	const { MODELS } = (await import(join(root, "node_modules", "@earendil-works", "pi-ai", "dist", "models.generated.js"))) as {
		MODELS: Record<string, Record<string, Model<Api>>>;
	};
	return Object.values(MODELS).flatMap((rows) => Object.values(rows));
}

describe("systemRoleLayout", () => {
	it("follows pi's catalog flag on every bundled row, never Haiku", async () => {
		const catalog = await bundledCatalog();
		let flagged = 0;
		for (const model of catalog) {
			const flag = (model.compat as { supportsMidConvoSystemMessages?: boolean } | undefined)?.supportsMidConvoSystemMessages === true;
			const layout = systemRoleLayout(model);
			if (model.id.includes("haiku")) expect(layout, `${model.provider}/${model.id}`).toBeUndefined();
			else if (!flag) expect(layout, `${model.provider}/${model.id}`).toBeUndefined();
			if (layout) flagged++;
		}
		expect(flagged).toBeGreaterThan(0);
	});

	it("gives first-party Claude 5 models the Anthropic shape, and leaves out Sonnet 5 and Haiku 4.5", async () => {
		const catalog = await bundledCatalog();
		const anthropic = (id: string) => catalog.find((m) => m.provider === "anthropic" && m.id === id);
		for (const id of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"]) {
			expect(systemRoleLayout(anthropic(id)), id).toBe("anthropic");
		}
		expect(systemRoleLayout(anthropic("claude-sonnet-5"))).toBeUndefined();
		expect(systemRoleLayout(anthropic("claude-haiku-4-5"))).toBeUndefined();
	});

	it("maps each API to its wire shape", () => {
		const flagged = { supportsMidConvoSystemMessages: true };
		expect(systemRoleLayout({ id: "x", api: "openai-responses", compat: flagged })).toBe("responses");
		expect(systemRoleLayout({ id: "x", api: "azure-openai-responses", compat: flagged })).toBe("responses");
		expect(systemRoleLayout({ id: "x", api: "openai-codex-responses", compat: flagged })).toBe("responses");
		expect(systemRoleLayout({ id: "x", api: "openai-completions", compat: flagged })).toBe("completions");
		expect(systemRoleLayout({ id: "x", api: "google-generative-ai", compat: flagged })).toBeUndefined();
		expect(systemRoleLayout({ id: "x", api: "openai-responses" })).toBeUndefined();
		expect(systemRoleLayout(undefined)).toBeUndefined();
	});
});

describe("withBetas", () => {
	it("appends the missing betas after pi's, each once", () => {
		const payload = { model: "claude-opus-5-5", betas: ["a", "b"] };
		expect(withBetas(payload, ["b", "c", "c"]).betas).toEqual(["a", "b", "c"]);
	});

	it("creates the list when pi sent none", () => {
		expect(withBetas({ model: "m" }, ["a"])).toEqual({ model: "m", betas: ["a"] });
	});

	it("is idempotent and returns the same payload when nothing is missing", () => {
		const once = withBetas({ betas: ["a"] }, ["b"]);
		expect(withBetas(once, ["b"])).toBe(once);
	});
});
