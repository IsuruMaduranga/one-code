/**
 * The catalog-wide tier snapshot: every row of pi's bundled model catalog, the
 * tier it gets with the bundled model facts, and the rule that decided. The
 * fixture is a REVIEWED artifact — a change to the classifier, the anchor map,
 * the facts table or pi's catalog shows up here as a diff to read line by line,
 * never as a silent re-tiering. Regenerate after review with
 *
 *   UPDATE_TIER_SNAPSHOT=1 npx vitest run test/unit/model-tier-catalog.test.ts
 *
 * docs/features/tiering/plan.md (Phase 1 acceptance).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { setModelFactsForTest } from "../../extensions/lib/model-facts.ts";
import { classifyModelTier } from "../../extensions/lib/model-tier.ts";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "model-tier-catalog.json");
const noEnv = {} as NodeJS.ProcessEnv;

async function bundledCatalog(): Promise<Model<Api>[]> {
	// The generated catalog is not on pi-ai's export map (and vitest has no
	// import.meta.resolve), so read it from the repo's node_modules directly —
	// test-only; a pi bump that moves the file fails here, loudly.
	const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
	const { MODELS } = (await import(join(root, "node_modules", "@earendil-works", "pi-ai", "dist", "models.generated.js"))) as {
		MODELS: Record<string, Record<string, Model<Api>>>;
	};
	return Object.values(MODELS).flatMap((rows) => Object.values(rows));
}

describe("catalog-wide tier snapshot", () => {
	// The bundled facts, not the hermetic empty table: a file-level beforeEach runs
	// after test/setup.ts's global one, so it wins.
	beforeEach(() => setModelFactsForTest(undefined));
	afterAll(() => setModelFactsForTest({}));

	it("classifies every bundled catalog row exactly as the reviewed fixture says", async () => {
		const catalog = await bundledCatalog();
		const actual: Record<string, string> = {};
		for (const model of catalog) {
			const { tier, reason } = classifyModelTier(model, noEnv);
			actual[`${model.provider}/${model.id}`] = `${tier} · ${reason}`;
		}
		const sorted = Object.fromEntries(Object.entries(actual).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

		if (process.env.UPDATE_TIER_SNAPSHOT) {
			writeFileSync(FIXTURE, `${JSON.stringify(sorted, null, "\t")}\n`);
			return;
		}
		const expected = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, string>;
		const changed = Object.keys({ ...expected, ...sorted })
			.filter((key) => expected[key] !== sorted[key])
			.map((key) => `${key}: ${expected[key] ?? "(new row)"} → ${sorted[key] ?? "(row gone)"}`);
		expect(changed, `${changed.length} catalog rows re-tiered — review, then UPDATE_TIER_SNAPSHOT=1`).toEqual([]);
	});
});
