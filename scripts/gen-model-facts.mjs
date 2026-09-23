#!/usr/bin/env node
/**
 * Generate extensions/lib/model-facts.generated.json — the release date and
 * tool-calling flag for every row of pi's bundled model catalog that models.dev
 * knows about. pi's generated catalog strips both fields (findings §9), and the
 * tier classifier needs the release date to tell a model's generation
 * (working-docs/features/tiering/plan.md, Phase 1).
 *
 * Run after every pi version bump (the catalog changes with it):
 *
 *   node scripts/gen-model-facts.mjs            # writes the JSON
 *   node scripts/gen-model-facts.mjs --check    # exit 1 if it would change
 *
 * Keys are `<provider>/<id>` exactly as pi spells them. Rows models.dev does
 * not know are omitted, and the runtime treats a missing row as "no facts"
 * (today's price-and-name behaviour). models.dev needs a browser User-Agent.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const out = join(root, "extensions", "lib", "model-facts.generated.json");
// ESM resolution (the package exports only an "import" condition): dist/index.js → dist/models.generated.js
const catalogPath = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai"))), "models.generated.js");
const { MODELS } = await import(catalogPath);

const res = await fetch("https://models.dev/api.json", {
	headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 one-code-gen-model-facts" },
	signal: AbortSignal.timeout(60_000),
});
if (!res.ok) throw new Error(`models.dev responded ${res.status}`);
const modelsDev = await res.json();

const facts = {};
let total = 0;
for (const [provider, rows] of Object.entries(MODELS)) {
	const known = modelsDev[provider]?.models ?? {};
	for (const model of Object.values(rows)) {
		total++;
		const row = known[model.id];
		if (!row?.release_date) continue;
		const entry = { releaseDate: row.release_date };
		if (row.tool_call === false) entry.toolCall = false;
		facts[`${provider}/${model.id}`] = entry;
	}
}
const sorted = Object.fromEntries(Object.entries(facts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const text = `${JSON.stringify({ generatedFrom: "https://models.dev/api.json", piCatalogRows: total, rows: Object.keys(sorted).length, facts: sorted }, null, "\t")}\n`;

if (process.argv.includes("--check")) {
	let current = "";
	try {
		current = readFileSync(out, "utf8");
	} catch {}
	// Ignore the volatile counters when comparing; only the facts matter.
	const strip = (s) => s.replace(/"piCatalogRows": \d+,\n\s*"rows": \d+,\n/, "");
	if (strip(current) !== strip(text)) {
		console.error("model-facts.generated.json is stale — run scripts/gen-model-facts.mjs");
		process.exit(1);
	}
	console.log("model-facts.generated.json is current");
} else {
	writeFileSync(out, text);
	console.log(`wrote ${out}: ${Object.keys(sorted).length}/${total} pi catalog rows have a models.dev release date`);
}
