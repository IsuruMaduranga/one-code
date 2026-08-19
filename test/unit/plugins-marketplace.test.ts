import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchInstallCounts, formatInstallCount, readCachedCounts } from "../../extensions/plugins/counts.ts";
import { installPlugin, uninstallPlugin } from "../../extensions/plugins/install/install.ts";
import { gitClone, gitUpdate } from "../../extensions/plugins/marketplace/git.ts";
import { addInstalledPlugin, installedEntry, removeInstalledPlugin, setInstalledEnabled } from "../../extensions/plugins/install/registry.ts";
import { sanitizePathSegment } from "../../extensions/lib/plugin-root.ts";
import { versionedCachePath, withinBase } from "../../extensions/plugins/install/paths.ts";
import { ensureOfficialRegistered, isStale, OFFICIAL_MARKETPLACE_NAME } from "../../extensions/plugins/marketplace/official.ts";
import { parseMarketplaceInput } from "../../extensions/plugins/marketplace/parse.ts";
import {
	availableMarketplaceName,
	readKnownMarketplaces,
	removeKnownMarketplace,
	writeKnownMarketplace,
} from "../../extensions/plugins/marketplace/registry.ts";
import { syncMarketplace } from "../../extensions/plugins/marketplace/sync.ts";
import { parseMarketplaceManifest } from "../../extensions/plugins/marketplace/types.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "cc-marketplace-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	vi.unstubAllGlobals();
});

describe("parseMarketplaceInput", () => {
	const parse = (input: string) => parseMarketplaceInput(input, root);

	it("github shorthand with optional #ref", () => {
		expect(parse("anthropics/claude-plugins-official")).toEqual({
			source: { source: "github", repo: "anthropics/claude-plugins-official", ref: undefined },
			suggestedName: "claude-plugins-official",
		});
		expect(parse("owner/repo#v2")).toMatchObject({ source: { source: "github", repo: "owner/repo", ref: "v2" } });
	});

	it("SSH form becomes a git source", () => {
		expect(parse("git@github.com:owner/repo.git#main")).toEqual({
			source: { source: "git", url: "git@github.com:owner/repo.git", ref: "main" },
			suggestedName: "repo",
		});
	});

	it("https .git and github.com URLs become git; other https becomes url", () => {
		expect(parse("https://gitlab.com/o/r.git")).toMatchObject({ source: { source: "git", url: "https://gitlab.com/o/r.git" } });
		expect(parse("https://github.com/owner/repo")).toMatchObject({
			source: { source: "git", url: "https://github.com/owner/repo.git" },
			suggestedName: "repo",
		});
		expect(parse("https://example.com/my/marketplace.json")).toMatchObject({
			source: { source: "url", url: "https://example.com/my/marketplace.json" },
			suggestedName: "marketplace",
		});
	});

	it("local paths resolve to directory or file sources; missing paths error", () => {
		mkdirSync(join(root, "mp"));
		writeFileSync(join(root, "m.json"), "{}");
		expect(parse("./mp")).toMatchObject({ source: { source: "directory", path: join(root, "mp") } });
		expect(parse(join(root, "m.json"))).toMatchObject({ source: { source: "file", path: join(root, "m.json") } });
		expect(parse("./nope")).toMatchObject({ error: expect.stringContaining("does not exist") });
	});

	it("garbage input returns an error, not a source", () => {
		expect(parse("not a marketplace")).toHaveProperty("error");
		expect(parse("")).toHaveProperty("error");
	});
});

describe("parseMarketplaceManifest", () => {
	it("keeps good entries and reports bad ones individually", () => {
		const { manifest, errors } = parseMarketplaceManifest({
			name: "mp",
			owner: { name: "Owner" },
			plugins: [
				{ name: "good", source: "./plugins/good", description: "ok" },
				{ name: "bad entry with space", source: "./x" },
				{ name: "no-source" },
				{ name: "remote", source: { source: "github", repo: "o/r" } },
			],
		});
		expect(manifest?.plugins.map((p) => p.name)).toEqual(["good", "remote"]);
		expect(errors).toHaveLength(2);
	});

	it("rejects a manifest without name or plugins", () => {
		expect(parseMarketplaceManifest({}).manifest).toBeUndefined();
		expect(parseMarketplaceManifest({ name: "x" }).manifest).toBeUndefined();
		expect(parseMarketplaceManifest("nope").manifest).toBeUndefined();
	});
});

describe("known marketplaces registry", () => {
	it("round-trips entries, preserves unknown keys, suffixes name collisions", () => {
		writeKnownMarketplace(root, "mp", {
			source: { source: "github", repo: "o/r" },
			installLocation: join(root, "marketplaces", "mp"),
			lastUpdated: "2026-08-19T00:00:00.000Z",
		});
		// Hand-added unknown key must survive the next write.
		const path = join(root, "known_marketplaces.json");
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		raw.futureField = { keep: true };
		writeFileSync(path, JSON.stringify(raw));
		writeKnownMarketplace(root, "mp2", {
			source: { source: "directory", path: "/x" },
			installLocation: "/x",
			lastUpdated: "2026-08-19T00:00:00.000Z",
		});
		expect(JSON.parse(readFileSync(path, "utf-8")).futureField).toEqual({ keep: true });

		expect(Object.keys(readKnownMarketplaces(root)).sort()).toEqual(["mp", "mp2"]);
		expect(availableMarketplaceName(root, "mp")).toBe("mp-2");
		expect(availableMarketplaceName(root, "fresh")).toBe("fresh");

		removeKnownMarketplace(root, "mp");
		expect(Object.keys(readKnownMarketplaces(root))).toEqual(["mp2"]);
	});

	it("sanitizes hostile registry names — `x/..` must not become a removable `..` path", () => {
		expect(availableMarketplaceName(root, "..")).toBe("--");
		expect(availableMarketplaceName(root, "a/../../b")).toBe("a-------b");
	});

	it("official marketplace registers once and reports staleness", () => {
		const entry = ensureOfficialRegistered(root, join(root, "marketplaces", OFFICIAL_MARKETPLACE_NAME));
		expect(entry.source).toEqual({ source: "github", repo: "anthropics/claude-plugins-official" });
		expect(isStale(entry)).toBe(true);
		const again = ensureOfficialRegistered(root, "/elsewhere");
		expect(again.installLocation).toBe(join(root, "marketplaces", OFFICIAL_MARKETPLACE_NAME));
		expect(isStale({ ...entry, lastUpdated: new Date().toISOString() })).toBe(false);
	});
});

describe("syncMarketplace (offline sources)", () => {
	it("directory source reads .claude-plugin/marketplace.json in place", async () => {
		const dir = join(root, "local-mp");
		mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
		writeFileSync(
			join(dir, ".claude-plugin", "marketplace.json"),
			JSON.stringify({ name: "local-mp", plugins: [{ name: "demo", source: "./plugins/demo" }] }),
		);
		const snapshot = await syncMarketplace(root, "local-mp", {
			source: { source: "directory", path: dir },
			installLocation: dir,
			lastUpdated: new Date().toISOString(),
		});
		expect(snapshot.errors).toEqual([]);
		expect(snapshot.manifest?.plugins).toHaveLength(1);
		expect(snapshot.contentRoot).toBe(dir);
	});

	it("missing manifest is an error in the snapshot, not a throw", async () => {
		const dir = join(root, "empty-mp");
		mkdirSync(dir, { recursive: true });
		const snapshot = await syncMarketplace(root, "empty-mp", {
			source: { source: "directory", path: dir },
			installLocation: dir,
			lastUpdated: new Date().toISOString(),
		});
		expect(snapshot.manifest).toBeUndefined();
		expect(snapshot.errors[0]).toContain("no marketplace.json");
	});
});

describe("git argument safety", () => {
	it("rejects URLs and refs that git would parse as options", async () => {
		await expect(gitClone("--upload-pack=touch /tmp/pwned", join(root, "d"))).rejects.toThrow(/refusing/);
		await expect(gitClone("https://example.com/r.git", join(root, "d"), { ref: "--force" })).rejects.toThrow(/refusing/);
		await expect(gitUpdate(root, { ref: "-b" })).rejects.toThrow(/refusing/);
	});
});

describe("install paths", () => {
	it("sanitizes hostile segments and keeps versions' dots", () => {
		expect(sanitizePathSegment("../etc")).toBe("---etc");
		expect(sanitizePathSegment("1.2.3", true)).toBe("1.2.3");
		expect(versionedCachePath(root, "m p", "plug", "1.0.0")).toBe(join(root, "cache", "m-p", "plug", "1.0.0"));
	});

	it("withinBase rejects escapes and absolute overrides", () => {
		expect(withinBase("/base", "./sub/dir")).toBe(true);
		expect(withinBase("/base", "../out")).toBe(false);
		expect(withinBase("/base", "/etc")).toBe(false);
	});
});

describe("installed registry", () => {
	it("adds, toggles, and removes entries, preserving unknown file keys", () => {
		addInstalledPlugin(root, "demo@mp", { scope: "user", installPath: "/x", version: "1.0.0", enabled: true });
		const path = join(root, "installed_plugins.json");
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		raw.customTopLevel = 42;
		writeFileSync(path, JSON.stringify(raw));

		expect(setInstalledEnabled(root, "demo@mp", false)).toBe(true);
		expect(installedEntry(root, "demo@mp")?.enabled).toBe(false);
		expect(setInstalledEnabled(root, "ghost@mp", true)).toBe(false);
		expect(JSON.parse(readFileSync(path, "utf-8")).customTopLevel).toBe(42);

		removeInstalledPlugin(root, "demo@mp");
		expect(installedEntry(root, "demo@mp")).toBeUndefined();
	});
});

describe("installPlugin (local sources)", () => {
	const makeMarketplace = () => {
		const contentRoot = join(root, "marketplaces", "mp");
		const pluginSrc = join(contentRoot, "plugins", "demo");
		mkdirSync(join(pluginSrc, ".claude-plugin"), { recursive: true });
		writeFileSync(join(pluginSrc, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "demo", version: "2.1.0" }));
		writeFileSync(join(pluginSrc, "README.md"), "hi");
		return contentRoot;
	};

	it("copies a ./relative source into the versioned cache and registers it enabled", async () => {
		const contentRoot = makeMarketplace();
		const result = await installPlugin(root, "mp", { name: "demo", source: "./plugins/demo", raw: {} }, contentRoot);
		expect(result.version).toBe("2.1.0");
		expect(result.installPath).toBe(join(root, "cache", "mp", "demo", "2.1.0"));
		expect(existsSync(join(result.installPath, "README.md"))).toBe(true);
		expect(installedEntry(root, "demo@mp")).toMatchObject({ scope: "user", enabled: true, version: "2.1.0" });
	});

	it("rejects escaping sources, dependencies, sha pinning, and unsupported kinds by name", async () => {
		const contentRoot = makeMarketplace();
		await expect(installPlugin(root, "mp", { name: "demo", source: "./../../outside", raw: {} }, contentRoot)).rejects.toThrow(
			/escapes the marketplace/,
		);
		await expect(
			installPlugin(root, "mp", { name: "demo", source: "./plugins/demo", raw: { dependencies: ["x"] } }, contentRoot),
		).rejects.toThrow(/dependencies are not supported/);
		await expect(
			installPlugin(root, "mp", { name: "demo", source: { source: "github", repo: "o/r", sha: "a".repeat(40) }, raw: {} }, contentRoot),
		).rejects.toThrow(/sha pinning is not supported/);
		await expect(
			installPlugin(root, "mp", { name: "demo", source: { source: "npm", package: "x" } as never, raw: {} }, contentRoot),
		).rejects.toThrow(/not supported/);
	});

	it("uninstall removes the entry and cache dir, but never paths outside the cache", async () => {
		const contentRoot = makeMarketplace();
		const result = await installPlugin(root, "mp", { name: "demo", source: "./plugins/demo", raw: {} }, contentRoot);
		uninstallPlugin(root, "demo@mp");
		expect(existsSync(result.installPath)).toBe(false);
		expect(installedEntry(root, "demo@mp")).toBeUndefined();

		const outside = join(root, "precious");
		mkdirSync(outside);
		addInstalledPlugin(root, "ext@mp", { scope: "user", installPath: outside });
		uninstallPlugin(root, "ext@mp");
		expect(existsSync(outside)).toBe(true);
	});
});

describe("install counts", () => {
	it("formats counts like the Discover tab expects", () => {
		expect(formatInstallCount(999)).toBe("999");
		expect(formatInstallCount(1000)).toBe("1K");
		expect(formatInstallCount(36400)).toBe("36.4K");
		expect(formatInstallCount(999_949)).toBe("999.9K");
		expect(formatInstallCount(1_200_000)).toBe("1.2M");
	});

	it("TTL cache: fresh hits, expired misses", () => {
		const now = new Date("2026-08-19T12:00:00Z");
		writeFileSync(
			join(root, "install-counts-cache.json"),
			JSON.stringify({ version: 1, fetchedAt: "2026-08-19T00:00:00Z", counts: [{ plugin: "a@mp", unique_installs: 5 }] }),
		);
		expect(readCachedCounts(root, now)?.get("a@mp")).toBe(5);
		expect(readCachedCounts(root, new Date("2026-08-21T00:00:00Z"))).toBeUndefined();
	});

	it("fetch failure hides counts (undefined), success caches", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
		expect(await fetchInstallCounts(root)).toBeUndefined();

		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ ok: true, json: async () => [{ plugin: "a@mp", unique_installs: 1234 }] }),
		);
		const counts = await fetchInstallCounts(root);
		expect(counts?.get("a@mp")).toBe(1234);
		expect(readCachedCounts(root)?.get("a@mp")).toBe(1234);
	});
});
