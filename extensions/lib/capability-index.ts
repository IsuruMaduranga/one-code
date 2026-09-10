/**
 * Measured model capability from the Artificial Analysis free API, as an
 * OPTIONAL input to automatic model selection (pure: no pi imports).
 *
 * ## What it is for, and what it is not
 *
 * The tier classifier (`model-tier.ts`) decides a model's prompt REGISTER by
 * name class and generation, and the index must never move that: on the
 * coding index current flash-class models (Gemini 3.7 Flash 76.1, GLM-5.3 Flash
 * 71.5, GPT-5.6 Luna 71.4) score at or above Claude Sonnet 5 (71.5), so any
 * cutoff that keeps Sonnet in workhorse promotes every flash with it, and a
 * benchmark does not measure harness reliability at the effort a user runs.
 * Those scores are TRUE about coding ability, though — so they are exactly the
 * right input for the question the register cannot answer: is this cheaper
 * same-vendor model capable enough to delegate to or to screen permissions
 * with? Claude Code's classifier rule is min(main, Sonnet); with a measured
 * scale it can mean what it says: a candidate whose coding index reaches the
 * lower of the session model's and Sonnet 5's, both read from the SAME
 * snapshot so the index rescaling every version cancels out.
 * docs/features/tiering/plan.md (Phase 2), docs/decisions/model-tiers.md.
 *
 * ## Data handling (the API's terms, findings §9)
 *
 * A personal key is required (401 without), the free tier is 1,000 requests a
 * day, responses must be cached, attribution is required wherever scores are
 * shown (`ATTRIBUTION`). So: the key comes from `AA_API_KEY` or One Code's own
 * `~/.onecode/settings.json` (`capabilityIndex.artificialAnalysisApiKey`, never
 * `~/.claude`); the response is cached under the One Code state dir and
 * refreshed at most once a day, only from an interactive session, never awaited
 * in `session_start`; a one-shot run reads the cache alone. Without a key every
 * verdict is "unscored" and selection keeps its name-class rules.
 *
 * ## Matching (the hard part)
 *
 * pi ids and Artificial Analysis slugs differ (`deepseek-chat-v3.1` vs
 * `deepseek-v3-1`, `claude-haiku-4-5` vs `claude-4-5-haiku`), effort variants
 * are separate rows (`-high`, `-non-reasoning`, …), and a slug can name a NEWER
 * build than pi's row: OpenRouter's `deepseek/deepseek-v4-flash` is the April
 * build (models.dev 2026-04-24) while the slug `deepseek-v4-flash` is the July
 * build (coding 69.1; the April build, `deepseek-v4-flash-0420`, scores 56.2).
 * A match therefore counts only when the row's release date agrees with the
 * models.dev date (`model-facts.ts`) to within `DATE_TOLERANCE_DAYS`; a model
 * without facts cannot be confirmed and stays unscored.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "./atomic-write.ts";
import { modelFacts } from "./model-facts.ts";
import { pricedInput, stripSnapshotDate } from "./model-policy.ts";

export const AA_KEY_ENV = "AA_API_KEY";
export const AA_MODELS_URL = "https://artificialanalysis.ai/api/v2/data/llms/models";
export const ATTRIBUTION = "Scores: Artificial Analysis (https://artificialanalysis.ai)";
export const SETTINGS_SNIPPET = '{ "capabilityIndex": { "artificialAnalysisApiKey": "<key>" } }';
/** The advice the doctor gives when no key is configured. */
export const KEY_ADVICE =
	`Add a free Artificial Analysis API key (create one at https://artificialanalysis.ai) as ${AA_KEY_ENV} in the environment ` +
	`or ${SETTINGS_SNIPPET} in ~/.onecode/settings.json. With it, subagent and classifier picks are judged by measured coding ability ` +
	"instead of model names alone.";

export const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;
export const FETCH_TIMEOUT_MS = 20_000;
/** A slug match is trusted only when the two release dates agree this closely. */
export const DATE_TOLERANCE_DAYS = 31;
/** The reference Claude Code's classifier rule names: min(main, Sonnet). */
export const REFERENCE_SLUG = "claude-sonnet-5";
/** How far below the floor a delegated worker may score (the classifier allows nothing). */
export const SUBAGENT_TOLERANCE = 0.9;

export interface CapabilityRow {
	id: string;
	slug: string;
	releaseDate: string;
	creator: string;
	coding?: number;
	intelligence?: number;
}

export interface CapabilitySnapshot {
	fetchedAt: string;
	source: string;
	rows: CapabilityRow[];
}

// ---------------------------------------------------------------------------
// Key and cache
// ---------------------------------------------------------------------------

/** The key, env first (the ecosystem convention), else One Code's own settings file. Never `~/.claude`. */
export function capabilityIndexKey(env: Record<string, string | undefined>, settings: unknown): string | undefined {
	const fromEnv = env[AA_KEY_ENV]?.trim();
	if (fromEnv) return fromEnv;
	if (settings && typeof settings === "object" && !Array.isArray(settings)) {
		const block = (settings as Record<string, unknown>).capabilityIndex;
		if (block && typeof block === "object" && !Array.isArray(block)) {
			const key = (block as Record<string, unknown>).artificialAnalysisApiKey;
			if (typeof key === "string" && key.trim()) return key.trim();
		}
	}
	return undefined;
}

export function capabilityCachePath(stateDir: string): string {
	return join(stateDir, "cache", "artificial-analysis.json");
}

/** Reduce the API response to the fields selection needs; anything malformed is dropped. */
export function snapshotFromResponse(body: unknown, fetchedAt: Date): CapabilitySnapshot {
	const rows: CapabilityRow[] = [];
	const data = body && typeof body === "object" ? (body as { data?: unknown }).data : undefined;
	if (Array.isArray(data)) {
		for (const raw of data) {
			if (!raw || typeof raw !== "object") continue;
			const row = raw as Record<string, unknown>;
			if (typeof row.id !== "string" || typeof row.slug !== "string" || typeof row.release_date !== "string") continue;
			const evaluations = (row.evaluations ?? {}) as Record<string, unknown>;
			const creator = (row.model_creator ?? {}) as Record<string, unknown>;
			const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
			rows.push({
				id: row.id,
				slug: row.slug.toLowerCase(),
				releaseDate: row.release_date,
				creator: typeof creator.slug === "string" ? creator.slug : "",
				coding: num(evaluations.artificial_analysis_coding_index),
				intelligence: num(evaluations.artificial_analysis_intelligence_index),
			});
		}
	}
	return { fetchedAt: fetchedAt.toISOString(), source: AA_MODELS_URL, rows };
}

let memo: { path: string; mtimeMs: number; snapshot: CapabilitySnapshot | undefined } | undefined;
let testSnapshot: { value: CapabilitySnapshot | undefined } | undefined;

/** Test seam: pin the snapshot every selection call sees (`undefined` = none); `null` restores disk reads. */
export function setCapabilitySnapshotForTest(snapshot: CapabilitySnapshot | undefined | null): void {
	testSnapshot = snapshot === null ? undefined : { value: snapshot };
	memo = undefined;
}

/** The cached snapshot, memoized on the file's mtime so a background refresh is picked up without a restart. */
export function loadCapabilitySnapshot(stateDir: string): CapabilitySnapshot | undefined {
	if (testSnapshot) return testSnapshot.value;
	const path = capabilityCachePath(stateDir);
	let mtimeMs: number;
	try {
		mtimeMs = statSync(path).mtimeMs;
	} catch {
		memo = { path, mtimeMs: -1, snapshot: undefined };
		return undefined;
	}
	if (memo && memo.path === path && memo.mtimeMs === mtimeMs) return memo.snapshot;
	let snapshot: CapabilitySnapshot | undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CapabilitySnapshot>;
		if (parsed && typeof parsed.fetchedAt === "string" && Array.isArray(parsed.rows)) {
			snapshot = { fetchedAt: parsed.fetchedAt, source: parsed.source ?? AA_MODELS_URL, rows: parsed.rows as CapabilityRow[] };
		}
	} catch {
		snapshot = undefined; // a corrupt cache is "no snapshot"; the next refresh rewrites it
	}
	memo = { path, mtimeMs, snapshot };
	return snapshot;
}

export function snapshotAgeMs(snapshot: CapabilitySnapshot, now: Date = new Date()): number {
	return Math.max(0, now.getTime() - Date.parse(snapshot.fetchedAt));
}

export function snapshotIsStale(snapshot: CapabilitySnapshot | undefined, now: Date = new Date()): boolean {
	return !snapshot || Number.isNaN(Date.parse(snapshot.fetchedAt)) || snapshotAgeMs(snapshot, now) > REFRESH_AFTER_MS;
}

export type RefreshOutcome = { status: "no-key" } | { status: "fresh" } | { status: "refreshed"; rows: number } | { status: "failed"; error: string };

/**
 * Fetch and cache a new snapshot when the cached one is older than a day.
 * Bounded by `FETCH_TIMEOUT_MS`; never throws (a failure is an outcome the
 * caller may log once). Callers decide WHEN this may run: only from a session
 * that outlives the turn, never awaited in `session_start` (findings §15, §19).
 */
export async function refreshCapabilitySnapshot(options: {
	key: string | undefined;
	stateDir: string;
	fetchImpl?: typeof fetch;
	now?: Date;
	force?: boolean;
}): Promise<RefreshOutcome> {
	const { key, stateDir, fetchImpl = globalThis.fetch, now = new Date(), force = false } = options;
	if (!key) return { status: "no-key" };
	if (!force && !snapshotIsStale(loadCapabilitySnapshot(stateDir), now)) return { status: "fresh" };
	try {
		const response = await fetchImpl(AA_MODELS_URL, {
			headers: { "x-api-key": key, accept: "application/json" },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!response.ok) return { status: "failed", error: `Artificial Analysis responded ${response.status}` };
		const snapshot = snapshotFromResponse(await response.json(), now);
		if (snapshot.rows.length === 0) return { status: "failed", error: "Artificial Analysis returned no model rows" };
		writeJsonAtomic(capabilityCachePath(stateDir), snapshot);
		memo = undefined;
		return { status: "refreshed", rows: snapshot.rows.length };
	} catch (error) {
		return { status: "failed", error: error instanceof Error ? error.message : String(error) };
	}
}

export function capabilityCacheExists(stateDir: string): boolean {
	return existsSync(capabilityCachePath(stateDir));
}

// ---------------------------------------------------------------------------
// Matching pi rows to snapshot rows
// ---------------------------------------------------------------------------

const EFFORT_SUFFIX = /-(non-reasoning|reasoning|thinking|adaptive|xhigh|high|medium|low|minimal|max)$/;

/** The slug with every effort suffix removed — the family key a pi id is matched to. */
export function baseSlug(slug: string): string {
	let current = slug;
	for (;;) {
		const next = current.replace(EFFORT_SUFFIX, "");
		if (next === current) return current;
		current = next;
	}
}

/**
 * Candidate Artificial Analysis base slugs for a pi id, most specific first.
 * Exported for the tests; the spelling fixes here are the ones the catalog
 * needed on 2026-09-10 (findings §9) — add to them as mismatches are found.
 */
export function slugCandidates(id: string): string[] {
	let s = (id.startsWith("~") ? id.slice(1) : id).toLowerCase();
	const slash = s.indexOf("/");
	if (slash > 0) s = s.slice(slash + 1); // gateway route prefix
	s = s.replace(/:[a-z]+$/i, ""); // endpoint variant
	s = stripSnapshotDate(s); // -YYYYMMDD / -MMDD
	s = s.replace(/\./g, "-");
	s = s.replace(/-(preview|latest|exp)(-\d{2}-\d{2})?$/, "");
	s = s.replace(/^deepseek-chat-v3/, "deepseek-v3").replace(/^deepseek-chat$/, "deepseek-v3");
	const out = new Set<string>([s]);
	out.add(s.replace(/-\d{4}$/, "")); // a four-digit build tag the date strip did not recognise
	out.add(s.replace(/-instruct$/, ""));
	out.add(s.replace(/-it$/, ""));
	// Artificial Analysis spells the Claude 4.x line `claude-4-5-haiku`, the 5.x line `claude-sonnet-5`.
	const claude = s.match(/^claude-(opus|sonnet|haiku)-(\d+(?:-\d+)?)$/);
	if (claude) out.add(`claude-${claude[2]}-${claude[1]}`);
	return [...out];
}

export type ScoreVariant = "default" | "non-reasoning";

export interface CapabilityScore {
	/** The coding index — the number selection compares. */
	coding: number;
	intelligence?: number;
	slug: string;
	variant: ScoreVariant;
	releaseDate: string;
}

const DAY_MS = 86_400_000;

function withinTolerance(a: string, b: string): boolean {
	const ta = Date.parse(a);
	const tb = Date.parse(b);
	return !Number.isNaN(ta) && !Number.isNaN(tb) && Math.abs(ta - tb) <= DATE_TOLERANCE_DAYS * DAY_MS;
}

function rowsByBase(snapshot: CapabilitySnapshot): Map<string, CapabilityRow[]> {
	const cached = indexMemo.get(snapshot);
	if (cached) return cached;
	const map = new Map<string, CapabilityRow[]>();
	for (const row of snapshot.rows) {
		const base = baseSlug(row.slug);
		const list = map.get(base);
		if (list) list.push(row);
		else map.set(base, [row]);
	}
	indexMemo.set(snapshot, map);
	return map;
}
const indexMemo = new WeakMap<CapabilitySnapshot, Map<string, CapabilityRow[]>>();

/**
 * The score for a model at one variant, or undefined when it cannot be matched
 * with confidence. `expectedReleaseDate` is the models.dev date the match must
 * agree with; pass `undefined` only for the fixed reference row, which is
 * looked up by exact slug rather than matched.
 */
export function scoreFor(
	snapshot: CapabilitySnapshot,
	model: { provider: string; id: string },
	variant: ScoreVariant,
): CapabilityScore | undefined {
	const facts = modelFacts(model);
	if (!facts) return undefined; // nothing to confirm a slug match against
	const families = rowsByBase(snapshot);
	for (const candidate of slugCandidates(model.id)) {
		const rows = families.get(candidate);
		if (!rows) continue;
		const base = rows.find((row) => row.slug === candidate);
		if (!base || !withinTolerance(base.releaseDate, facts.releaseDate)) continue;
		return pick(rows, candidate, variant);
	}
	return undefined;
}

/** The reference model's score, by exact slug (no pi row to confirm it against). */
export function referenceScore(snapshot: CapabilitySnapshot, variant: ScoreVariant, slug = REFERENCE_SLUG): CapabilityScore | undefined {
	const rows = rowsByBase(snapshot).get(slug);
	return rows ? pick(rows, slug, variant) : undefined;
}

function pick(rows: CapabilityRow[], base: string, variant: ScoreVariant): CapabilityScore | undefined {
	const wanted = variant === "default" ? base : `${base}-non-reasoning`;
	const row = rows.find((candidate) => candidate.slug === wanted);
	if (!row || row.coding === undefined) return undefined;
	return { coding: row.coding, intelligence: row.intelligence, slug: row.slug, variant, releaseDate: row.releaseDate };
}

// ---------------------------------------------------------------------------
// The floor
// ---------------------------------------------------------------------------

export type FloorRole = "classifier" | "subagent";

export interface FloorVerdict {
	verdict: "pass" | "fail" | "unscored";
	/** Present for pass/fail: what was compared. */
	candidate?: CapabilityScore;
	session?: CapabilityScore;
	reference?: CapabilityScore;
	floor?: number;
	/** Why "unscored", for the doctor report. */
	reason?: string;
}

/**
 * Whether `candidate` measurably reaches min(session, Sonnet 5) for the role.
 * The classifier calls with thinking OFF, so it compares non-reasoning variant
 * scores (Sonnet 5 drops from 71.5 to 66.4, GLM-5.2 from 68.8 to 46.5); when
 * any of the three lacks a non-reasoning row, all three fall back to the default
 * variant so the comparison stays on one basis. Delegated workers run with
 * thinking and may sit `SUBAGENT_TOLERANCE` below the floor. Unscored means the
 * caller applies its name-class rule instead — the score never lowers a floor
 * it cannot measure.
 */
export function capabilityFloor(
	snapshot: CapabilitySnapshot | undefined,
	candidate: { provider: string; id: string },
	session: { provider: string; id: string },
	role: FloorRole,
): FloorVerdict {
	if (!snapshot) return { verdict: "unscored", reason: "no capability snapshot (no key)" };
	const variants: ScoreVariant[] = role === "classifier" ? ["non-reasoning", "default"] : ["default"];
	for (const variant of variants) {
		const c = scoreFor(snapshot, candidate, variant);
		const s = scoreFor(snapshot, session, variant);
		const r = referenceScore(snapshot, variant);
		if (!c || !s || !r) continue;
		const floor = Math.min(s.coding, r.coding) * (role === "subagent" ? SUBAGENT_TOLERANCE : 1);
		return { verdict: c.coding >= floor ? "pass" : "fail", candidate: c, session: s, reference: r, floor };
	}
	const missing = [!scoreFor(snapshot, candidate, "default") && "candidate", !scoreFor(snapshot, session, "default") && "session model", !referenceScore(snapshot, "default") && "reference"]
		.filter(Boolean)
		.join(", ");
	return { verdict: "unscored", reason: `no confirmed score for: ${missing || "the non-reasoning variants"}` };
}

/** Sort key helper the selectors share: cheapest first, unknown price last. */
export function byInputPrice(a: { cost?: { input?: number } }, b: { cost?: { input?: number } }): number {
	return (pricedInput(a as never) ?? Number.POSITIVE_INFINITY) - (pricedInput(b as never) ?? Number.POSITIVE_INFINITY);
}
