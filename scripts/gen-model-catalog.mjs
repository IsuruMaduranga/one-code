#!/usr/bin/env node
/**
 * Refresh the model catalogs bundled with a release, extensions/lib/model-catalog/:
 * models.dev's api.json, OpenRouter's model list and Hugging Face parameter
 * counts, each trimmed to the fields the tier algorithm reads but kept in the
 * API's own shape (extensions/lib/model-catalog-data.ts). A session refreshes
 * the same payloads daily at runtime; this copy is what a fresh install and an
 * offline machine use. Run it before every release and every pi version bump,
 * then review the tier diff:
 *
 *   node scripts/gen-model-catalog.mjs
 *   UPDATE_TIER_SNAPSHOT=1 npx vitest run test/unit/model-tier-catalog.test.ts
 *
 * Every Hugging Face repo the previous copy has not looked up is looked up
 * now (no per-run cap, unlike the runtime refresh). No API key is needed.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	bundledCatalogDir,
	fetchParameterCount,
	HUGGING_FACE_MODELS_URL,
	MODELS_DEV_URL,
	OPENROUTER_MODELS_URL,
	trimModelsDev,
	trimOpenRouter,
	unknownRepos,
} from "../extensions/lib/model-catalog-data.ts";
import { BUILTIN_PROVIDER_POLICIES } from "../extensions/lib/model-policy.ts";

const dir = bundledCatalogDir();
const headers = { accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; one-code-gen-model-catalog)" };
const get = async (url) => {
	const response = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) });
	if (!response.ok) throw new Error(`${url} responded ${response.status}`);
	return response.json();
};
const write = (file, source, payload) =>
	writeFileSync(join(dir, file), `${JSON.stringify({ fetchedAt, source, payload }, null, "\t")}\n`);

const fetchedAt = new Date().toISOString();
const [modelsDevBody, openRouterBody] = await Promise.all([get(MODELS_DEV_URL), get(OPENROUTER_MODELS_URL)]);
const modelsDev = trimModelsDev(modelsDevBody, Object.keys(BUILTIN_PROVIDER_POLICIES));
const openRouter = trimOpenRouter(openRouterBody);

let counts = {};
try {
	counts = (await import(join(dir, "huggingface.json"), { with: { type: "json" } })).default.payload ?? {};
} catch {}
const todo = unknownRepos(openRouter, counts);
let next = 0;
const worker = async () => {
	while (next < todo.length) {
		const repo = todo[next++];
		const count = await fetchParameterCount(repo);
		if (count !== undefined) counts[repo] = count;
	}
};
await Promise.all(Array.from({ length: 8 }, worker));
counts = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

write("models-dev.json", MODELS_DEV_URL, modelsDev);
write("openrouter.json", OPENROUTER_MODELS_URL, openRouter);
write("huggingface.json", HUGGING_FACE_MODELS_URL, counts);
const rows = Object.values(modelsDev).reduce((sum, provider) => sum + Object.keys(provider.models).length, 0);
console.log(
	`wrote ${dir}: ${rows} models.dev rows over ${Object.keys(modelsDev).length} providers, ` +
		`${openRouter.data.length} OpenRouter rows, ${Object.keys(counts).length} Hugging Face repos (${todo.length} looked up now)`,
);
