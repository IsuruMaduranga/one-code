/**
 * Marketplace data shapes + hand-rolled validators (pure).
 *
 * The formats are Claude Code's: `known_marketplaces.json` records where each
 * marketplace came from and where its content is cached; a marketplace's
 * `.claude-plugin/marketplace.json` lists plugin entries whose `source` says
 * how to materialize the plugin's files. Validation is per-entry — one bad
 * entry never blanks the rest of the marketplace.
 */

export type MarketplaceSource =
	| { source: "github"; repo: string; ref?: string }
	| { source: "git"; url: string; ref?: string }
	| { source: "url"; url: string }
	| { source: "file"; path: string }
	| { source: "directory"; path: string };

export interface KnownMarketplace {
	source: MarketplaceSource;
	installLocation: string;
	lastUpdated: string;
	autoUpdate?: boolean;
}

/** How one plugin's files are obtained. A string is a path relative to the marketplace root. */
export type PluginEntrySource =
	| string
	| { source: "github"; repo: string; ref?: string; sha?: string }
	| { source: "git-subdir"; url: string; path: string; ref?: string; sha?: string }
	| { source: "url"; url: string; ref?: string; sha?: string };

export interface MarketplaceEntry {
	name: string;
	source: PluginEntrySource;
	description?: string;
	version?: string;
	author?: { name?: string };
	category?: string;
	tags?: string[];
	/** The full raw entry — the detail view shows contributions (lspServers, mcpServers, …) from it. */
	raw: Record<string, unknown>;
}

export interface MarketplaceManifest {
	name: string;
	owner?: { name?: string };
	description?: string;
	plugins: MarketplaceEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validEntrySource(value: unknown): value is PluginEntrySource {
	// A string source is a marketplace-relative path and must say so ("./…").
	if (typeof value === "string") return value.startsWith("./");
	if (!isRecord(value)) return false;
	switch (value.source) {
		case "github":
			return typeof value.repo === "string" && value.repo.length > 0;
		case "git-subdir":
			return typeof value.url === "string" && typeof value.path === "string" && value.path.length > 0;
		case "url":
			return typeof value.url === "string" && value.url.length > 0;
		default:
			return false;
	}
}

/** Validate a parsed marketplace.json. Entry-level problems land in `errors`; good entries survive. */
export function parseMarketplaceManifest(raw: unknown): { manifest?: MarketplaceManifest; errors: string[] } {
	const errors: string[] = [];
	if (!isRecord(raw)) return { errors: ["marketplace.json must be a JSON object"] };
	if (typeof raw.name !== "string" || raw.name.length === 0) {
		return { errors: ['marketplace.json is missing a "name"'] };
	}
	if (!Array.isArray(raw.plugins)) {
		return { errors: [`marketplace "${raw.name}" has no "plugins" array`] };
	}

	const plugins: MarketplaceEntry[] = [];
	for (const [index, entry] of raw.plugins.entries()) {
		if (!isRecord(entry) || typeof entry.name !== "string" || entry.name.length === 0 || entry.name.includes(" ")) {
			errors.push(`plugins[${index}]: missing or invalid "name" — entry skipped`);
			continue;
		}
		if (!validEntrySource(entry.source)) {
			errors.push(`plugins[${index}] ("${entry.name}"): missing or unsupported "source" — entry skipped`);
			continue;
		}
		plugins.push({
			name: entry.name,
			source: entry.source as PluginEntrySource,
			description: typeof entry.description === "string" ? entry.description : undefined,
			version: typeof entry.version === "string" ? entry.version : undefined,
			author: isRecord(entry.author) && typeof entry.author.name === "string" ? { name: entry.author.name } : undefined,
			category: typeof entry.category === "string" ? entry.category : undefined,
			tags: Array.isArray(entry.tags) ? entry.tags.filter((t): t is string => typeof t === "string") : undefined,
			raw: entry,
		});
	}

	const owner = isRecord(raw.owner) && typeof raw.owner.name === "string" ? { name: raw.owner.name } : undefined;
	const metadata = isRecord(raw.metadata) ? raw.metadata : undefined;
	return {
		manifest: {
			name: raw.name,
			owner,
			description: typeof metadata?.description === "string" ? (metadata.description as string) : undefined,
			plugins,
		},
		errors,
	};
}

/** Validate one known_marketplaces.json value; undefined when malformed. */
export function parseKnownMarketplace(raw: unknown): KnownMarketplace | undefined {
	if (!isRecord(raw) || !isRecord(raw.source) || typeof raw.installLocation !== "string") return undefined;
	const source = raw.source as MarketplaceSource;
	if (!["github", "git", "url", "file", "directory"].includes(source.source)) return undefined;
	return {
		source,
		installLocation: raw.installLocation,
		lastUpdated: typeof raw.lastUpdated === "string" ? raw.lastUpdated : new Date(0).toISOString(),
		autoUpdate: typeof raw.autoUpdate === "boolean" ? raw.autoUpdate : undefined,
	};
}
