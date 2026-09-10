import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifierCandidates } from "../../extensions/auto-mode/model-select.ts";
import {
	AA_KEY_ENV,
	baseSlug,
	capabilityCachePath,
	capabilityFloor,
	capabilityIndexKey,
	type CapabilitySnapshot,
	loadCapabilitySnapshot,
	referenceScore,
	refreshCapabilitySnapshot,
	scoreFor,
	setCapabilitySnapshotForTest,
	slugCandidates,
	snapshotFromResponse,
	snapshotIsStale,
} from "../../extensions/lib/capability-index.ts";
import { setModelFactsForTest } from "../../extensions/lib/model-facts.ts";
import { cheaperContainedCandidates, pickEconomicalContainedModel } from "../../extensions/lib/model-tier.ts";
import { resolveSubagentModel } from "../../extensions/subagents/model-select.ts";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "artificial-analysis-sample.json");
const RESPONSE = JSON.parse(readFileSync(FIXTURE, "utf8")) as unknown;
const NOW = new Date("2026-09-10T12:00:00Z");
const SNAPSHOT = snapshotFromResponse(RESPONSE, NOW);

const model = (provider: string, id: string, input?: number) =>
	({ provider, id, name: id, api: "openai-completions", cost: input === undefined ? undefined : { input, output: input * 3 } }) as unknown as Model<Api>;

/** models.dev dates for the pi rows used below (the real ones on 2026-09-10). */
const FACTS = {
	"openrouter/deepseek/deepseek-v4-pro": { releaseDate: "2026-08-13" },
	"openrouter/deepseek/deepseek-v4-flash": { releaseDate: "2026-04-24" }, // the April build → AA slug is the July one
	"openrouter/deepseek/deepseek-v4-flash-0731": { releaseDate: "2026-07-31" },
	"openrouter/deepseek/deepseek-r1-0528": { releaseDate: "2025-05-28" },
	"openrouter/deepseek/deepseek-chat": { releaseDate: "2024-12-26" },
	"deepseek/deepseek-v4-pro": { releaseDate: "2026-08-12" },
	"deepseek/deepseek-v4-flash": { releaseDate: "2026-07-31" },
	"openai/gpt-5.6-sol": { releaseDate: "2026-07-09" },
	"openai/gpt-5.6-luna": { releaseDate: "2026-07-09" },
	"openai/gpt-5-mini": { releaseDate: "2025-08-07" },
	"openai/gpt-5-nano": { releaseDate: "2025-08-07" },
	"anthropic/claude-sonnet-5": { releaseDate: "2026-06-30" },
	"anthropic/claude-haiku-4-5": { releaseDate: "2025-10-15" },
	"anthropic/claude-opus-5": { releaseDate: "2026-07-24" },
	"zai/glm-5.2": { releaseDate: "2026-06-16" },
	"zai/glm-5.3-flash": { releaseDate: "2026-08-26" },
};

describe("snapshot parsing and slug matching", () => {
	beforeEach(() => setModelFactsForTest(FACTS));

	it("reduces the API response to the fields selection needs", () => {
		expect(SNAPSHOT.rows.length).toBe(25);
		const sonnet = SNAPSHOT.rows.find((row) => row.slug === "claude-sonnet-5")!;
		expect(sonnet).toMatchObject({ creator: "anthropic", releaseDate: "2026-06-30", coding: 71.5, intelligence: 38.4 });
		expect(snapshotFromResponse({ nonsense: true }, NOW).rows).toEqual([]);
	});

	it("strips effort suffixes to the family base slug", () => {
		expect(baseSlug("gpt-5-6-sol-xhigh")).toBe("gpt-5-6-sol");
		expect(baseSlug("claude-sonnet-5-non-reasoning")).toBe("claude-sonnet-5");
		expect(baseSlug("deepseek-v4-flash-0420-non-reasoning")).toBe("deepseek-v4-flash-0420");
		expect(baseSlug("kimi-k3")).toBe("kimi-k3");
	});

	it("derives candidate slugs from pi ids, including the Claude 4.x spelling", () => {
		expect(slugCandidates("deepseek/deepseek-chat-v3.1")).toContain("deepseek-v3-1");
		expect(slugCandidates("~deepseek/deepseek-v4-flash-latest")[0]).toBe("deepseek-v4-flash");
		expect(slugCandidates("openai/gpt-5-mini:batch")[0]).toBe("gpt-5-mini");
		expect(slugCandidates("claude-haiku-4-5")).toContain("claude-4-5-haiku");
		expect(slugCandidates("claude-haiku-4-5-20251001")).toContain("claude-4-5-haiku");
		expect(slugCandidates("gemini-3-pro-preview-05-06")[0]).toBe("gemini-3-pro");
	});

	it("scores a row only when the slug's release date agrees with models.dev", () => {
		// The July build matches; the April build behind the same slug does NOT (69.1 would be the wrong number).
		expect(scoreFor(SNAPSHOT, model("openrouter", "deepseek/deepseek-v4-flash-0731"), "default")).toMatchObject({ coding: 69.1, slug: "deepseek-v4-flash" });
		expect(scoreFor(SNAPSHOT, model("openrouter", "deepseek/deepseek-v4-flash"), "default")).toBeUndefined();
		expect(scoreFor(SNAPSHOT, model("deepseek", "deepseek-v4-pro"), "default")).toMatchObject({ coding: 68.8 });
		expect(scoreFor(SNAPSHOT, model("anthropic", "claude-haiku-4-5"), "default")).toBeUndefined(); // no coding index on that row
		expect(scoreFor(SNAPSHOT, model("openrouter", "someone/never-heard-of"), "default")).toBeUndefined();
		// A row without models.dev facts cannot be confirmed, whatever the slug says.
		setModelFactsForTest({});
		expect(scoreFor(SNAPSHOT, model("deepseek", "deepseek-v4-pro"), "default")).toBeUndefined();
	});

	it("reads the non-reasoning variant separately and looks the reference up by exact slug", () => {
		expect(scoreFor(SNAPSHOT, model("openai", "gpt-5.6-sol"), "non-reasoning")).toMatchObject({ coding: 65.1, variant: "non-reasoning" });
		expect(scoreFor(SNAPSHOT, model("openai", "gpt-5.6-luna"), "non-reasoning")).toBeUndefined();
		expect(referenceScore(SNAPSHOT, "default")?.coding).toBe(71.5);
		expect(referenceScore(SNAPSHOT, "non-reasoning")?.coding).toBe(66.4);
	});
});

describe("capabilityFloor", () => {
	beforeEach(() => setModelFactsForTest(FACTS));
	const pro = model("deepseek", "deepseek-v4-pro", 0.435);
	const flash = model("deepseek", "deepseek-v4-flash", 0.14);

	it("is unscored without a snapshot, or when any of the three cannot be confirmed", () => {
		expect(capabilityFloor(undefined, flash, pro, "classifier").verdict).toBe("unscored");
		expect(capabilityFloor(SNAPSHOT, model("openrouter", "deepseek/deepseek-v4-flash"), pro, "subagent")).toMatchObject({ verdict: "unscored" });
	});

	it("passes a candidate whose coding index reaches min(session, Sonnet 5)", () => {
		// Flash 69.1 ≥ min(Pro 68.8, Sonnet 71.5) — the flash line measurably matches its flagship.
		expect(capabilityFloor(SNAPSHOT, flash, pro, "subagent")).toMatchObject({ verdict: "pass", floor: 68.8 * 0.9 });
		// Luna 71.4 vs a GPT-5.6 Sol session: floor is Sonnet's 71.5 → subagents tolerate it, but not by a wide margin.
		const sol = model("openai", "gpt-5.6-sol", 4.5);
		expect(capabilityFloor(SNAPSHOT, model("openai", "gpt-5.6-luna", 0.2), sol, "subagent")).toMatchObject({ verdict: "pass" });
		// GPT-5 mini 15.6 fails every floor.
		expect(capabilityFloor(SNAPSHOT, model("openai", "gpt-5-mini", 0.25), sol, "subagent")).toMatchObject({ verdict: "fail" });
	});

	it("judges the classifier on thinking-off scores, falling back to the default variant on one basis", () => {
		// Sol has a non-reasoning row (65.1) and so does Sonnet (66.4); Luna has none → all three fall back to default:
		// Luna 71.4 < min(Sol 77.4, Sonnet 71.5) = 71.5 → fails as a screener (no tolerance for the permission boundary).
		const sol = model("openai", "gpt-5.6-sol", 4.5);
		expect(capabilityFloor(SNAPSHOT, model("openai", "gpt-5.6-luna", 0.2), sol, "classifier")).toMatchObject({ verdict: "fail", floor: 71.5 });
		// DeepSeek: no non-reasoning rows for the current builds → default basis: Flash 69.1 ≥ 68.8 → screens.
		expect(capabilityFloor(SNAPSHOT, flash, pro, "classifier")).toMatchObject({ verdict: "pass", floor: 68.8 });
		// GLM-5.2 has a non-reasoning row (46.5) and so does the Sonnet reference (66.4): with a
		// session that also has one, the comparison runs on the thinking-off basis and 46.5 fails.
		const verdict = capabilityFloor(SNAPSHOT, model("zai", "glm-5.2", 1), model("anthropic", "claude-sonnet-5", 3), "classifier");
		expect(verdict.candidate?.variant).toBe("non-reasoning");
		expect(verdict).toMatchObject({ verdict: "fail", floor: 66.4 });
	});
});

describe("selection with a measured floor", () => {
	beforeEach(() => {
		setModelFactsForTest(FACTS);
		setCapabilitySnapshotForTest(SNAPSHOT);
	});

	it("lets a measurably capable flash screen its vendor's flagship (the classifier admits by score)", () => {
		const catalog = [model("deepseek", "deepseek-v4-pro", 0.435), model("deepseek", "deepseek-v4-flash", 0.14)];
		const { candidates } = classifierCandidates({ available: catalog, sessionModel: catalog[0] });
		expect(candidates.map((c) => `${c.model.id}:${c.source}`)).toEqual(["deepseek-v4-flash:economical", "deepseek-v4-pro:session"]);
		// Without the snapshot the name-class floor keeps Pro screening itself.
		setCapabilitySnapshotForTest(undefined);
		expect(classifierCandidates({ available: catalog, sessionModel: catalog[0] }).candidates.map((c) => c.model.id)).toEqual(["deepseek-v4-pro"]);
	});

	it("drops a measured failure from subagent and reader picks, ranking passers by price", () => {
		const catalog = [
			model("openai", "gpt-5.6-sol", 4.5),
			model("openai", "gpt-5.6-luna", 0.2),
			model("openai", "gpt-5-mini", 0.25), // cheap tier by anchor, but scores 15.6 → fails
		];
		expect(cheaperContainedCandidates(catalog, catalog[0], { role: "subagent" }).map((m) => m.id)).toEqual(["gpt-5.6-luna"]);
		expect(resolveSubagentModel({ sessionModel: catalog[0], available: catalog }).model?.id).toBe("gpt-5.6-luna");
		expect(pickEconomicalContainedModel(catalog, catalog[0])).toMatchObject({ model: { id: "gpt-5.6-luna" }, via: "tier" });
		// Unscored rows keep their tier order after the measured passers.
		const withUnknown = [...catalog, model("openai", "gpt-5.6-mystery", 0.1)];
		expect(cheaperContainedCandidates(withUnknown, catalog[0], { role: "subagent" }).map((m) => m.id)).toEqual(["gpt-5.6-luna", "gpt-5.6-mystery"]);
	});
});

describe("key, cache and refresh", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "onecode-capability-"));
		setCapabilitySnapshotForTest(null); // real disk reads for this block
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		setCapabilitySnapshotForTest(undefined);
	});

	it("takes the key from the environment first, then One Code's own settings", () => {
		expect(capabilityIndexKey({ [AA_KEY_ENV]: " aa_env " }, { capabilityIndex: { artificialAnalysisApiKey: "aa_file" } })).toBe("aa_env");
		expect(capabilityIndexKey({}, { capabilityIndex: { artificialAnalysisApiKey: "aa_file" } })).toBe("aa_file");
		expect(capabilityIndexKey({}, { capabilityIndex: { artificialAnalysisApiKey: "" } })).toBeUndefined();
		expect(capabilityIndexKey({}, undefined)).toBeUndefined();
	});

	it("fetches with the key, caches the reduced snapshot, and reads it back by mtime", async () => {
		const calls: Array<{ url: string; key: string | undefined }> = [];
		const fetchImpl = (async (url: string, init?: RequestInit) => {
			calls.push({ url, key: (init?.headers as Record<string, string>)["x-api-key"] });
			return new Response(JSON.stringify(RESPONSE), { status: 200 });
		}) as unknown as typeof fetch;
		expect(await refreshCapabilitySnapshot({ key: undefined, stateDir: dir, fetchImpl, now: NOW })).toEqual({ status: "no-key" });
		expect(await refreshCapabilitySnapshot({ key: "aa_test", stateDir: dir, fetchImpl, now: NOW })).toEqual({ status: "refreshed", rows: 25 });
		expect(calls).toEqual([{ url: "https://artificialanalysis.ai/api/v2/data/llms/models", key: "aa_test" }]);
		const cached = loadCapabilitySnapshot(dir)!;
		expect(cached.fetchedAt).toBe(NOW.toISOString());
		expect(cached.rows.find((row) => row.slug === "kimi-k3")?.coding).toBe(76.2);
		// Fresh → no second request; a day later → refreshed again.
		expect(await refreshCapabilitySnapshot({ key: "aa_test", stateDir: dir, fetchImpl, now: NOW })).toEqual({ status: "fresh" });
		expect(calls.length).toBe(1);
		expect(snapshotIsStale(cached, new Date(NOW.getTime() + 25 * 3600 * 1000))).toBe(true);
		expect(await refreshCapabilitySnapshot({ key: "aa_test", stateDir: dir, fetchImpl, now: new Date(NOW.getTime() + 25 * 3600 * 1000) })).toMatchObject({ status: "refreshed" });
	});

	it("reports HTTP and network failures without throwing, and keeps the old cache", async () => {
		mkdirSync(dirname(capabilityCachePath(dir)), { recursive: true });
		const old: CapabilitySnapshot = { fetchedAt: "2026-09-01T00:00:00Z", source: "test", rows: [] };
		writeFileSync(capabilityCachePath(dir), JSON.stringify(old));
		const unauthorized = (async () => new Response('{"error":"API key is required"}', { status: 401 })) as unknown as typeof fetch;
		expect(await refreshCapabilitySnapshot({ key: "bad", stateDir: dir, fetchImpl: unauthorized, now: NOW })).toEqual({
			status: "failed",
			error: "Artificial Analysis responded 401",
		});
		const offline = (async () => {
			throw new Error("getaddrinfo ENOTFOUND");
		}) as unknown as typeof fetch;
		expect(await refreshCapabilitySnapshot({ key: "aa", stateDir: dir, fetchImpl: offline, now: NOW })).toMatchObject({ status: "failed" });
		expect(loadCapabilitySnapshot(dir)?.fetchedAt).toBe("2026-09-01T00:00:00Z");
	});

	it("treats a corrupt cache as no snapshot", () => {
		mkdirSync(dirname(capabilityCachePath(dir)), { recursive: true });
		writeFileSync(capabilityCachePath(dir), "{not json");
		expect(loadCapabilitySnapshot(dir)).toBeUndefined();
	});
});
