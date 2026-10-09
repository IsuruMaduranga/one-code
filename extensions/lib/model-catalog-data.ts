/**
 * The public model catalogs the tier algorithm reads (`model-catalog.ts`):
 * models.dev (release dates, vendor prices, canonical ids, tool support),
 * OpenRouter's model list (Hugging Face repo ids, output modalities) and
 * Hugging Face's safetensors metadata (total parameter counts). None needs a
 * key. Pure: no pi imports.
 *
 * Each source is kept as its own API payload, trimmed to the fields the
 * algorithm reads but in the API's own shape, so the copy bundled with a
 * release (`model-catalog/*.json`, written by `scripts/gen-model-catalog.mjs`)
 * and the copy an interactive session refreshes into the One Code state dir go
 * through the same code. The newer copy of each source wins; parameter counts
 * merge, since a refresh only looks up repos it has not seen.
 *
 * A refresh runs at most once a day, only from a session that outlives its
 * turn, never awaited in `session_start` (the caller's job), and a failure
 * keeps the copy already on disk. `refreshModelCatalog: false` in
 * `~/.onecode/settings.json` or pi's `PI_OFFLINE` turns it off; the copy on
 * disk (or the bundled one) then decides.
 * working-docs/decisions/model-tiers.md.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonFile, writeJsonAtomic } from "./atomic-write.ts";
import { fetchWithTimeout } from "./fetch-timeout.ts";

export const MODELS_DEV_URL = "https://models.dev/api.json";
export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
export const HUGGING_FACE_MODELS_URL = "https://huggingface.co/api/models/";

export const CATALOG_REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;
export const CATALOG_FETCH_TIMEOUT_MS = 30_000;
/** Hugging Face lookups per refresh: only repos new since the last one, so normally a handful. */
export const HUGGING_FACE_LOOKUPS_PER_REFRESH = 25;

/** pi providers models.dev lists under another name. */
export const MODELS_DEV_PROVIDER: Readonly<Record<string, string>> = { "vercel-ai-gateway": "vercel" };

/** A models.dev model row, trimmed to what the tier algorithm reads. */
export interface ModelsDevModel {
	release_date?: string;
	/** models.dev's lifecycle marker; only `deprecated` is acted on. */
	status?: string;
	tool_call?: boolean;
	/** USD per million tokens. */
	cost?: { input?: number; output?: number };
	/** The vendor's own `provider/id` for the model a hosted or gateway row serves. */
	canonical_model_id?: string;
	/** Kept only when a model outputs something besides text (an image model). */
	modalities?: { output?: string[] };
}

export type ModelsDevPayload = Record<string, { models: Record<string, ModelsDevModel> }>;

/** An OpenRouter model row, trimmed. */
export interface OpenRouterModel {
	id: string;
	/** Unix seconds the row was listed: a release date when models.dev has none. */
	created?: number;
	hugging_face_id?: string;
	/** Kept only as `["tools"]` when present. */
	supported_parameters?: string[];
	architecture?: { output_modalities?: string[] };
	/** USD per token, as strings, OpenRouter's own spelling. */
	pricing?: { prompt?: string; completion?: string };
}

export interface OpenRouterPayload {
	data: OpenRouterModel[];
}

/** Hugging Face repo id → total parameters from its safetensors metadata; null when the repo has none (gated, removed, no safetensors). */
export type ParameterCounts = Record<string, number | null>;

export interface CatalogFile<T> {
	fetchedAt: string;
	source: string;
	payload: T;
}

export interface CatalogSources {
	/** Whether the models.dev copy in use came from a runtime refresh rather than the release. */
	refreshed?: boolean;
	modelsDev: CatalogFile<ModelsDevPayload>;
	openRouter: CatalogFile<OpenRouterPayload>;
	huggingFace: CatalogFile<ParameterCounts>;
}

const FILES = { modelsDev: "models-dev.json", openRouter: "openrouter.json", huggingFace: "huggingface.json" } as const;
type SourceName = keyof typeof FILES;

// ---------------------------------------------------------------------------
// Trimming (shared by the build script and the runtime refresh)
// ---------------------------------------------------------------------------

const record = (value: unknown): Record<string, unknown> | undefined =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const finite = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);

function trimModelsDevRow(raw: Record<string, unknown>): ModelsDevModel {
	const row: ModelsDevModel = {};
	if (typeof raw.release_date === "string") row.release_date = raw.release_date;
	if (typeof raw.status === "string") row.status = raw.status;
	if (typeof raw.tool_call === "boolean") row.tool_call = raw.tool_call;
	const cost = record(raw.cost);
	if (cost && (finite(cost.input) !== undefined || finite(cost.output) !== undefined)) {
		row.cost = {};
		if (finite(cost.input) !== undefined) row.cost.input = finite(cost.input);
		if (finite(cost.output) !== undefined) row.cost.output = finite(cost.output);
	}
	if (typeof raw.canonical_model_id === "string") row.canonical_model_id = raw.canonical_model_id;
	const output = strings(record(raw.modalities)?.output);
	if (output.some((modality) => modality !== "text")) row.modalities = { output };
	return row;
}

/**
 * models.dev's `api.json` reduced to the providers One Code can run on (pi's
 * built-in providers, under models.dev's names) plus OpenRouter and every
 * vendor those rows name as canonical, whole: a vendor's comparison set needs
 * its other models too.
 */
export function trimModelsDev(body: unknown, piProviders: Iterable<string>): ModelsDevPayload {
	const all = record(body) ?? {};
	const keep = new Set<string>(["openrouter"]);
	for (const provider of piProviders) keep.add(MODELS_DEV_PROVIDER[provider] ?? provider);
	const out: ModelsDevPayload = {};
	const pending = [...keep];
	while (pending.length > 0) {
		const provider = pending.pop()!;
		const models = record(record(all[provider])?.models);
		if (!models || out[provider]) continue;
		const trimmed: Record<string, ModelsDevModel> = {};
		for (const [id, raw] of Object.entries(models)) {
			const row = record(raw);
			if (!row) continue;
			trimmed[id] = trimModelsDevRow(row);
			const vendor = trimmed[id].canonical_model_id?.split("/")[0];
			if (vendor && !keep.has(vendor)) {
				keep.add(vendor);
				pending.push(vendor);
			}
		}
		out[provider] = { models: trimmed };
	}
	return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** OpenRouter's `/api/v1/models` reduced to the fields the algorithm reads. */
export function trimOpenRouter(body: unknown): OpenRouterPayload {
	const data: OpenRouterModel[] = [];
	for (const raw of Array.isArray(record(body)?.data) ? (record(body)!.data as unknown[]) : []) {
		const row = record(raw);
		if (!row || typeof row.id !== "string") continue;
		const model: OpenRouterModel = { id: row.id };
		if (finite(row.created) !== undefined) model.created = finite(row.created);
		if (typeof row.hugging_face_id === "string" && row.hugging_face_id) model.hugging_face_id = row.hugging_face_id;
		if (strings(row.supported_parameters).includes("tools")) model.supported_parameters = ["tools"];
		const output = strings(record(row.architecture)?.output_modalities);
		if (output.some((modality) => modality !== "text")) model.architecture = { output_modalities: output };
		const pricing = record(row.pricing);
		if (pricing && typeof pricing.prompt === "string" && typeof pricing.completion === "string") {
			model.pricing = { prompt: pricing.prompt, completion: pricing.completion };
		}
		data.push(model);
	}
	data.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	return { data };
}

/** The total parameter count in a Hugging Face model response, or null. */
export function parameterCountFromResponse(body: unknown): number | null {
	const total = finite(record(record(body)?.safetensors)?.total);
	return total !== undefined && total > 0 ? total : null;
}

/** The repo ids an OpenRouter payload names that `known` has no entry for. */
export function unknownRepos(openRouter: OpenRouterPayload, known: ParameterCounts): string[] {
	const repos = new Set<string>();
	for (const row of openRouter.data) if (row.hugging_face_id && !(row.hugging_face_id in known)) repos.add(row.hugging_face_id);
	return [...repos].sort();
}

/** One repo's parameter count; a failed lookup is undefined (retried next refresh), a repo without one is null. */
export async function fetchParameterCount(repo: string, fetchImpl: typeof fetch = fetch): Promise<number | null | undefined> {
	const url = `${HUGGING_FACE_MODELS_URL}${repo.split("/").map(encodeURIComponent).join("/")}?expand%5B%5D=safetensors`;
	try {
		const response = await fetchImpl(url, { signal: AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS) });
		if (response.status === 401 || response.status === 403 || response.status === 404) return null;
		if (!response.ok) return undefined;
		return parameterCountFromResponse(await response.json());
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Loading: the bundled copy, the refreshed copy, the newer of the two
// ---------------------------------------------------------------------------

export function bundledCatalogDir(): string {
	return fileURLToPath(new URL("./model-catalog/", import.meta.url));
}

export function catalogCacheDir(stateDir: string): string {
	return join(stateDir, "cache", "model-catalog");
}

function isCatalogFile(value: unknown): value is CatalogFile<unknown> {
	const file = record(value);
	return !!file && typeof file.fetchedAt === "string" && !Number.isNaN(Date.parse(file.fetchedAt)) && record(file.payload) !== undefined;
}

function readCatalogFile<T>(path: string): CatalogFile<T> | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return isCatalogFile(parsed) ? (parsed as CatalogFile<T>) : undefined;
	} catch {
		return undefined; // missing or corrupt: the other copy decides
	}
}

const EMPTY: CatalogSources = {
	modelsDev: { fetchedAt: new Date(0).toISOString(), source: MODELS_DEV_URL, payload: {} },
	openRouter: { fetchedAt: new Date(0).toISOString(), source: OPENROUTER_MODELS_URL, payload: { data: [] } },
	huggingFace: { fetchedAt: new Date(0).toISOString(), source: HUGGING_FACE_MODELS_URL, payload: {} },
};

let bundled: CatalogSources | undefined;
/** The copy bundled with this release, ignoring any refresh. */
export function bundledSources(): CatalogSources {
	if (bundled) return bundled;
	const dir = bundledCatalogDir();
	bundled = {
		modelsDev: readCatalogFile<ModelsDevPayload>(join(dir, FILES.modelsDev)) ?? EMPTY.modelsDev,
		openRouter: readCatalogFile<OpenRouterPayload>(join(dir, FILES.openRouter)) ?? EMPTY.openRouter,
		huggingFace: readCatalogFile<ParameterCounts>(join(dir, FILES.huggingFace)) ?? EMPTY.huggingFace,
	};
	return bundled;
}

const newer = <T>(a: CatalogFile<T>, b: CatalogFile<T> | undefined): CatalogFile<T> =>
	b && Date.parse(b.fetchedAt) > Date.parse(a.fetchedAt) ? b : a;

function combine(base: CatalogSources, cached: Partial<CatalogSources>): CatalogSources {
	const huggingFace = newer(base.huggingFace, cached.huggingFace);
	const modelsDev = newer(base.modelsDev, cached.modelsDev);
	return {
		refreshed: modelsDev !== base.modelsDev,
		modelsDev,
		openRouter: newer(base.openRouter, cached.openRouter),
		// Counts never go stale, and each copy may hold repos the other lacks.
		huggingFace: { ...huggingFace, payload: { ...base.huggingFace.payload, ...cached.huggingFace?.payload } },
	};
}

/** How long a stat result is trusted before the cache files are stat'ed again. */
const RESTAT_AFTER_MS = 1000;
let memo: { dir: string; stamp: string; sources: CatalogSources; checkedAt: number } | undefined;
let pinned: { value: CatalogSources } | undefined;

/** Test seam: pin the sources every lookup sees; `undefined` reads the real files again. */
export function setCatalogSourcesForTest(sources: CatalogSources | undefined): void {
	pinned = sources ? { value: sources } : undefined;
	memo = undefined;
}

/** An empty catalog: every model falls back to the no-catalog rules. */
export function emptyCatalogSources(): CatalogSources {
	return structuredClone(EMPTY);
}

/** Forget the disk memo so a lifecycle boundary sees another extension instance's refresh. */
export function invalidateCatalogCache(): void {
	memo = undefined;
}

function stampOf(dir: string): string {
	return (Object.values(FILES) as string[])
		.map((file) => {
			try {
				return String(statSync(join(dir, file)).mtimeMs);
			} catch {
				return "-";
			}
		})
		.join("|");
}

/**
 * The sources lookups read: for each, the newer of the bundled and the
 * refreshed copy. The same object is returned until a cache file changes, so
 * callers may memoize what they derive from it.
 */
export function loadCatalogSources(stateDir: string): CatalogSources {
	if (pinned) return pinned.value;
	const dir = catalogCacheDir(stateDir);
	const now = Date.now();
	if (memo && memo.dir === dir && now - memo.checkedAt < RESTAT_AFTER_MS) return memo.sources;
	const stamp = stampOf(dir);
	if (memo && memo.dir === dir && memo.stamp === stamp) {
		memo.checkedAt = now;
		return memo.sources;
	}
	const cached: Partial<CatalogSources> = {
		modelsDev: readCatalogFile<ModelsDevPayload>(join(dir, FILES.modelsDev)),
		openRouter: readCatalogFile<OpenRouterPayload>(join(dir, FILES.openRouter)),
		huggingFace: readCatalogFile<ParameterCounts>(join(dir, FILES.huggingFace)),
	};
	const sources = combine(bundledSources(), cached);
	memo = { dir, stamp, sources, checkedAt: now };
	return sources;
}

/** Whether the models.dev copy in use is older than a day. */
export function catalogIsStale(sources: CatalogSources, now: Date = new Date()): boolean {
	return now.getTime() - Date.parse(sources.modelsDev.fetchedAt) > CATALOG_REFRESH_AFTER_MS;
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

export type CatalogRefreshOutcome =
	| { status: "fresh" }
	| { status: "refreshed"; models: number; repos: number }
	| { status: "failed"; error: string };

const inflight = new Map<string, Promise<CatalogRefreshOutcome>>();

/**
 * Fetch both catalogs and any parameter counts not yet known, into the cache,
 * when the copy in use is older than a day. Never throws; a failure leaves the
 * cache as it was. One fetch per state dir at a time.
 */
export async function refreshModelCatalog(options: {
	stateDir: string;
	piProviders: Iterable<string>;
	fetchImpl?: typeof fetch;
	now?: Date;
	force?: boolean;
}): Promise<CatalogRefreshOutcome> {
	const { stateDir, now = new Date(), force = false } = options;
	// A pinned catalog (tests) is never replaced from the network.
	if (pinned || (!force && !catalogIsStale(loadCatalogSources(stateDir), now))) return { status: "fresh" };
	const running = inflight.get(stateDir);
	if (running) return running;
	const attempt = fetchCatalog(options, now).finally(() => inflight.delete(stateDir));
	inflight.set(stateDir, attempt);
	return attempt;
}

async function fetchJson(url: string, fetchImpl: typeof fetch | undefined): Promise<unknown> {
	// models.dev answers a bare client with 403; a browser User-Agent is accepted.
	const init: RequestInit = { headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; one-code-model-catalog)" } };
	const response = fetchImpl
		? await fetchImpl(url, { ...init, signal: AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS) })
		: await fetchWithTimeout(url, CATALOG_FETCH_TIMEOUT_MS, init);
	if (!response.ok) throw new Error(`${new URL(url).host} responded ${response.status}`);
	return response.json();
}

async function fetchCatalog(
	options: { stateDir: string; piProviders: Iterable<string>; fetchImpl?: typeof fetch },
	now: Date,
): Promise<CatalogRefreshOutcome> {
	const { stateDir, piProviders, fetchImpl } = options;
	try {
		const [modelsDevBody, openRouterBody] = await Promise.all([fetchJson(MODELS_DEV_URL, fetchImpl), fetchJson(OPENROUTER_MODELS_URL, fetchImpl)]);
		const modelsDev = trimModelsDev(modelsDevBody, piProviders);
		const openRouter = trimOpenRouter(openRouterBody);
		const rows = Object.values(modelsDev).reduce((sum, provider) => sum + Object.keys(provider.models).length, 0);
		if (rows === 0 || openRouter.data.length === 0) return { status: "failed", error: "a model catalog came back empty" };
		const dir = catalogCacheDir(stateDir);
		const fetchedAt = now.toISOString();
		const known = loadCatalogSources(stateDir).huggingFace.payload;
		const counts: ParameterCounts = { ...readCatalogFile<ParameterCounts>(join(dir, FILES.huggingFace))?.payload };
		const lookups = unknownRepos(openRouter, known).slice(0, HUGGING_FACE_LOOKUPS_PER_REFRESH);
		const found = await Promise.all(lookups.map((repo) => fetchParameterCount(repo, fetchImpl ?? fetch)));
		lookups.forEach((repo, index) => {
			if (found[index] !== undefined) counts[repo] = found[index]!;
		});
		writeJsonAtomic(join(dir, FILES.modelsDev), { fetchedAt, source: MODELS_DEV_URL, payload: modelsDev });
		writeJsonAtomic(join(dir, FILES.openRouter), { fetchedAt, source: OPENROUTER_MODELS_URL, payload: openRouter });
		writeJsonAtomic(join(dir, FILES.huggingFace), { fetchedAt, source: HUGGING_FACE_MODELS_URL, payload: counts });
		memo = undefined;
		return { status: "refreshed", models: rows, repos: lookups.length };
	} catch (error) {
		return { status: "failed", error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Whether the daily refresh may run: not with pi's `PI_OFFLINE` set, and not
 * when the user turned it off in `~/.onecode/settings.json`.
 */
export function catalogRefreshEnabled(settings: unknown, env: Record<string, string | undefined> = process.env): boolean {
	if (/^(1|true|yes)$/i.test(String(env.PI_OFFLINE ?? "").trim())) return false;
	return record(settings)?.refreshModelCatalog !== false;
}

/** The settings file reader the refresh switch uses, for callers without one. */
export function readCatalogRefreshEnabled(settingsPath: string, env: Record<string, string | undefined> = process.env): boolean {
	return catalogRefreshEnabled(readJsonFile(settingsPath), env);
}
