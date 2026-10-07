/**
 * Builds model-catalog sources for tests: a few vendor models, the pi rows
 * that serve them, and their sizes, in the shape the real payloads have
 * (`extensions/lib/model-catalog-data.ts`).
 */
import { type CatalogSources, emptyCatalogSources, setCatalogSourcesForTest } from "../../extensions/lib/model-catalog-data.ts";

export interface FixtureModel {
	/** The vendor's own `vendor/id`, which is also the pi row on a provider of that name. */
	id: string;
	released: string;
	/** USD per million tokens, input and output. */
	price?: [number, number];
	params?: number;
	tools?: boolean;
	deprecated?: boolean;
	/** Further pi rows (`provider/id`) that serve this model, e.g. `openrouter/qwen/qwen3.8-max`. */
	servedAs?: string[];
}

export function catalogSources(models: FixtureModel[]): CatalogSources {
	const sources = emptyCatalogSources();
	const fetchedAt = new Date().toISOString();
	sources.modelsDev.fetchedAt = fetchedAt;
	sources.openRouter.fetchedAt = fetchedAt;
	sources.huggingFace.fetchedAt = fetchedAt;
	const row = (provider: string, id: string) => {
		const models = (sources.modelsDev.payload[provider] ??= { models: {} }).models;
		return (models[id] ??= {});
	};
	for (const model of models) {
		const slash = model.id.indexOf("/");
		const own = row(model.id.slice(0, slash), model.id.slice(slash + 1));
		own.canonical_model_id = model.id;
		own.release_date = model.released;
		if (model.price) own.cost = { input: model.price[0], output: model.price[1] };
		if (model.tools !== undefined) own.tool_call = model.tools;
		if (model.deprecated) own.status = "deprecated";
		for (const spec of model.servedAs ?? []) {
			const at = spec.indexOf("/");
			row(spec.slice(0, at), spec.slice(at + 1)).canonical_model_id = model.id;
		}
		if (model.params !== undefined) {
			const repo = `hf/${model.id}`;
			row("openrouter", `fixture/${model.id}`).canonical_model_id = model.id;
			sources.openRouter.payload.data.push({
				id: `fixture/${model.id}`,
				hugging_face_id: repo,
				...(model.tools === false ? {} : { supported_parameters: ["tools"] }),
			});
			sources.huggingFace.payload[repo] = model.params;
		}
	}
	return sources;
}

/** Pin the catalog every lookup sees for the rest of the test. */
export function pinCatalog(models: FixtureModel[]): void {
	setCatalogSourcesForTest(catalogSources(models));
}

/**
 * Pin a catalog from release dates keyed by pi's `provider/id`, the shape the
 * older facts table had: each row becomes its vendor's own model (the id's
 * `vendor/` prefix on a gateway, else the provider), released on that date.
 */
export function pinReleaseDates(dates: Record<string, { releaseDate: string; toolCall?: false; price?: [number, number] }>): void {
	const sources = emptyCatalogSources();
	const fetchedAt = new Date().toISOString();
	sources.modelsDev.fetchedAt = fetchedAt;
	const row = (provider: string, id: string) => ((sources.modelsDev.payload[provider] ??= { models: {} }).models[id] ??= {});
	for (const [spec, fact] of Object.entries(dates)) {
		const at = spec.indexOf("/");
		const provider = spec.slice(0, at);
		const id = spec.slice(at + 1);
		const slash = id.indexOf("/");
		const canonical = slash > 0 ? id : `${provider}/${id}`;
		const own = row(canonical.slice(0, canonical.indexOf("/")), canonical.slice(canonical.indexOf("/") + 1));
		own.canonical_model_id = canonical;
		own.release_date = fact.releaseDate;
		if (fact.toolCall === false) own.tool_call = false;
		if (fact.price) own.cost = { input: fact.price[0], output: fact.price[1] };
		if (slash > 0) row(provider, id).canonical_model_id = canonical;
	}
	setCatalogSourcesForTest(sources);
}
