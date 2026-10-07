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
 * keeps the copy already on disk and waits a day before the next try (a
 * stamp in the cache dir). Each fetch is bounded, body included.
 * `refreshModelCatalog: false` in
 * `~/.onecode/settings.json` or pi's `PI_OFFLINE` turns it off; the copy on
 * disk (or the bundled one) then decides.
 * working-docs/decisions/model-tiers.md.
 */

import { closeSync, openSync, readSync, rmSync, statSync } from "node:fs";
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
export async function fetchParameterCount(repo: string, fetchImpl?: typeof fetch, signal?: AbortSignal): Promise<number | null | undefined> {
	const url = `${HUGGING_FACE_MODELS_URL}${repo.split("/").map(encodeURIComponent).join("/")}?expand%5B%5D=safetensors`;
	try {
		return await fetchWithTimeout(
			url,
			CATALOG_FETCH_TIMEOUT_MS,
			async (response) => {
				if (response.status === 401 || response.status === 403 || response.status === 404) return null;
				if (!response.ok) return undefined;
				return parameterCountFromResponse(await response.json());
			},
			{ fetchImpl, signal },
		);
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

/**
 * The refreshed catalog files. They decide a model's tier, and the tier
 * decides which auto-mode fast paths skip the classifier, so the safety floor
 * guards them like the settings files (auto-mode/safety-floor.ts).
 */
export function catalogCacheFiles(stateDir: string): string[] {
	return Object.values(FILES).map((file) => join(catalogCacheDir(stateDir), file));
}

/**
 * A refreshed catalog file under any literal `.onecode` directory, as a
 * forward-slashed path tail: the floor's counterpart of `catalogCacheFiles`,
 * for one in another home or spelled through a symlink the resolver missed.
 */
export const CATALOG_CACHE_TAIL = new RegExp(`/\\.onecode/cache/model-catalog/(${Object.values(FILES).map((file) => file.replace(/[.]/g, "\\.")).join("|")})$`);

function isCatalogFile(value: unknown): value is CatalogFile<unknown> {
	const file = record(value);
	return !!file && typeof file.fetchedAt === "string" && !Number.isNaN(Date.parse(file.fetchedAt)) && record(file.payload) !== undefined;
}

function readCatalogFile<T>(path: string): CatalogFile<T> | undefined {
	// Missing or corrupt: the other copy decides.
	const parsed = readJsonFile<unknown>(path);
	return isCatalogFile(parsed) ? (parsed as CatalogFile<T>) : undefined;
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
	// Re-stat on the next load; unchanged files keep the same sources object, so
	// the index memo (keyed by it) still hits.
	if (memo) memo.checkedAt = 0;
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

const olderThanRefresh = (stamp: string, now: Date): boolean => now.getTime() - Date.parse(stamp) > CATALOG_REFRESH_AFTER_MS;

/** The `fetchedAt` stamp at the head of a catalog file, without parsing its payload. */
function fetchedAtOf(path: string): string | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const head = Buffer.alloc(256);
		const read = readSync(fd, head, 0, head.length, 0);
		const stamp = head.subarray(0, read).toString("utf8").match(/^\{\s*"fetchedAt"\s*:\s*"([^"]+)"/)?.[1];
		if (stamp && !Number.isNaN(Date.parse(stamp))) return stamp;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
	// Written some other way: the whole file decides.
	return readCatalogFile<unknown>(path)?.fetchedAt;
}

/**
 * When the models.dev copy in use was fetched (the newer of the bundled and
 * the refreshed one, as `loadCatalogSources` picks), read from the files'
 * heads: a session start checks this without parsing the catalogs.
 */
export function catalogFetchedAt(stateDir: string): string {
	if (pinned) return pinned.value.modelsDev.fetchedAt;
	const stamps = [fetchedAtOf(join(bundledCatalogDir(), FILES.modelsDev)), fetchedAtOf(join(catalogCacheDir(stateDir), FILES.modelsDev))];
	return stamps.reduce<string>((a, b) => (b && Date.parse(b) > Date.parse(a) ? b : a), EMPTY.modelsDev.fetchedAt);
}

/** The last refresh that failed, kept so the next one waits a day. */
interface RefreshFailure {
	failedAt: string;
	error: string;
}
const FAILURE_FILE = "refresh-failed.json";

function recentFailure(stateDir: string, now: Date): RefreshFailure | undefined {
	const failure = readJsonFile<RefreshFailure>(join(catalogCacheDir(stateDir), FAILURE_FILE));
	const valid = typeof failure?.failedAt === "string" && !Number.isNaN(Date.parse(failure.failedAt));
	return valid && !olderThanRefresh(failure.failedAt, now) ? failure : undefined;
}

/**
 * Whether a refresh should run: the copy in use is over a day old, and no
 * refresh failed within the last day (a failure writes nothing, so without
 * the wait every start would fetch again). Cheap: no catalog is parsed.
 */
export function catalogRefreshDue(stateDir: string, now: Date = new Date()): boolean {
	return !pinned && olderThanRefresh(catalogFetchedAt(stateDir), now) && !recentFailure(stateDir, now);
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

export type CatalogRefreshOutcome =
	| { status: "fresh" }
	| { status: "refreshed"; models: number; repos: number }
	| { status: "failed"; error: string }
	/** A refresh failed within the last day; the next try waits for the day to pass. */
	| { status: "backing-off"; error: string };

const inflight = new Map<string, Promise<CatalogRefreshOutcome>>();

/**
 * Fetch both catalogs and any parameter counts not yet known, into the cache,
 * when the copy in use is older than a day and no refresh failed within the
 * last day (`force` skips both checks). Never throws; a failure leaves the
 * cache as it was and is remembered for a day, unless `signal` cancelled it.
 * Every fetch, bodies included, is bounded by `CATALOG_FETCH_TIMEOUT_MS`. One
 * fetch per state dir at a time.
 */
export async function refreshModelCatalog(options: {
	stateDir: string;
	piProviders: Iterable<string>;
	fetchImpl?: typeof fetch;
	now?: Date;
	force?: boolean;
	signal?: AbortSignal;
}): Promise<CatalogRefreshOutcome> {
	const { stateDir, now = new Date(), force = false } = options;
	// A pinned catalog (tests) is never replaced from the network.
	if (pinned) return { status: "fresh" };
	if (!force) {
		if (!olderThanRefresh(catalogFetchedAt(stateDir), now)) return { status: "fresh" };
		const failure = recentFailure(stateDir, now);
		if (failure) return { status: "backing-off", error: failure.error };
	}
	const running = inflight.get(stateDir);
	if (running) return running;
	const attempt = fetchCatalog(options, now).finally(() => inflight.delete(stateDir));
	inflight.set(stateDir, attempt);
	return attempt;
}

function fetchJson(url: string, fetchImpl: typeof fetch | undefined, signal: AbortSignal | undefined): Promise<unknown> {
	// models.dev answers a bare client with 403; a browser User-Agent is accepted.
	const init: RequestInit = { headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; one-code-model-catalog)" } };
	return fetchWithTimeout(
		url,
		CATALOG_FETCH_TIMEOUT_MS,
		async (response) => {
			if (!response.ok) throw new Error(`${new URL(url).host} responded ${response.status}`);
			return (await response.json()) as unknown;
		},
		{ init, fetchImpl, signal },
	);
}

async function fetchCatalog(
	options: { stateDir: string; piProviders: Iterable<string>; fetchImpl?: typeof fetch; signal?: AbortSignal },
	now: Date,
): Promise<CatalogRefreshOutcome> {
	const { stateDir, piProviders, fetchImpl, signal } = options;
	const dir = catalogCacheDir(stateDir);
	const fail = (error: string): CatalogRefreshOutcome => {
		// Cancelled by the caller (a session ending) is not the network failing.
		if (!signal?.aborted) {
			try {
				writeJsonAtomic(join(dir, FAILURE_FILE), { failedAt: now.toISOString(), error } satisfies RefreshFailure);
			} catch {
				// Unwritable: the next start tries again, as before.
			}
		}
		return { status: "failed", error };
	};
	try {
		const [modelsDevBody, openRouterBody] = await Promise.all([fetchJson(MODELS_DEV_URL, fetchImpl, signal), fetchJson(OPENROUTER_MODELS_URL, fetchImpl, signal)]);
		const modelsDev = trimModelsDev(modelsDevBody, piProviders);
		const openRouter = trimOpenRouter(openRouterBody);
		const rows = Object.values(modelsDev).reduce((sum, provider) => sum + Object.keys(provider.models).length, 0);
		if (rows === 0 || openRouter.data.length === 0) return fail("a model catalog came back empty");
		const fetchedAt = now.toISOString();
		const known = loadCatalogSources(stateDir).huggingFace.payload;
		const counts: ParameterCounts = { ...readCatalogFile<ParameterCounts>(join(dir, FILES.huggingFace))?.payload };
		const lookups = unknownRepos(openRouter, known).slice(0, HUGGING_FACE_LOOKUPS_PER_REFRESH);
		const found = await Promise.all(lookups.map((repo) => fetchParameterCount(repo, fetchImpl, signal)));
		if (signal?.aborted) throw signal.reason;
		lookups.forEach((repo, index) => {
			if (found[index] !== undefined) counts[repo] = found[index]!;
		});
		// models.dev last: its stamp is what marks the copy fresh, so a write
		// that fails before it leaves the copy stale and retried, never a
		// fresh-looking mix of old and new.
		writeJsonAtomic(join(dir, FILES.openRouter), { fetchedAt, source: OPENROUTER_MODELS_URL, payload: openRouter });
		writeJsonAtomic(join(dir, FILES.huggingFace), { fetchedAt, source: HUGGING_FACE_MODELS_URL, payload: counts });
		writeJsonAtomic(join(dir, FILES.modelsDev), { fetchedAt, source: MODELS_DEV_URL, payload: modelsDev });
		rmSync(join(dir, FAILURE_FILE), { force: true });
		memo = undefined;
		return { status: "refreshed", models: rows, repos: lookups.length };
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
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
