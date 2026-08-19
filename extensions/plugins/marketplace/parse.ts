/**
 * "Add Marketplace" input parsing (pure) — the same shorthand grammar Claude
 * Code accepts:
 *
 *   owner/repo[#ref]                      github
 *   git@host:path[.git][#ref]             git (SSH)
 *   https://…/repo.git / …/_git/…         git (explicit clone URL)
 *   https://github.com/owner/repo         git (forced .git)
 *   https://…/marketplace.json (other)    url (fetched manifest)
 *   ./path | /path | ~/path               file (.json) or directory
 */

import { existsSync, statSync } from "node:fs";
import os from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import type { MarketplaceSource } from "./types.ts";

export interface ParsedMarketplaceInput {
	source: MarketplaceSource;
	suggestedName: string;
}

const SSH_RE = /^([a-zA-Z0-9._-]+@[^:]+:.+?)(?:#(.+))?$/;
const GITHUB_SHORTHAND_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:#(.+))?$/;

function repoBasename(path: string): string {
	return basename(path).replace(/\.git$/, "");
}

export function parseMarketplaceInput(input: string, cwd: string): ParsedMarketplaceInput | { error: string } {
	const trimmed = input.trim();
	if (!trimmed) return { error: "Enter a marketplace source." };

	const ssh = trimmed.match(SSH_RE);
	if (ssh && !trimmed.startsWith("http")) {
		return {
			source: { source: "git", url: ssh[1], ref: ssh[2] },
			suggestedName: repoBasename(ssh[1].split(":").pop() ?? ssh[1]),
		};
	}

	if (/^https?:\/\//.test(trimmed)) {
		let url: URL;
		try {
			url = new URL(trimmed);
		} catch {
			return { error: `Not a valid URL: ${trimmed}` };
		}
		const ref = url.hash ? url.hash.slice(1) : undefined;
		url.hash = "";
		const bare = url.toString();
		if (url.pathname.endsWith(".git") || url.pathname.includes("/_git/")) {
			return { source: { source: "git", url: bare, ref }, suggestedName: repoBasename(url.pathname) };
		}
		if (url.hostname === "github.com" || url.hostname === "www.github.com") {
			const parts = url.pathname.split("/").filter(Boolean);
			if (parts.length === 2) {
				return {
					source: { source: "git", url: `https://github.com/${parts[0]}/${parts[1]}.git`, ref },
					suggestedName: parts[1],
				};
			}
		}
		const jsonName = basename(url.pathname).replace(/\.json$/, "").replace(/\.git$/, "");
		return { source: { source: "url", url: bare }, suggestedName: jsonName || url.hostname };
	}

	const looksLikePath =
		trimmed.startsWith("./") || trimmed.startsWith("../") || trimmed.startsWith("~") || isAbsolute(trimmed);
	if (looksLikePath) {
		const expanded = trimmed.startsWith("~") ? trimmed.replace(/^~/, os.homedir()) : trimmed;
		const path = resolve(cwd, expanded);
		if (!existsSync(path)) return { error: `Path does not exist: ${path}` };
		if (statSync(path).isDirectory()) {
			return { source: { source: "directory", path }, suggestedName: basename(path) };
		}
		if (path.endsWith(".json")) {
			return { source: { source: "file", path }, suggestedName: basename(path, ".json") };
		}
		return { error: `Not a marketplace: ${path} (expected a directory or a marketplace.json file)` };
	}

	const shorthand = trimmed.match(GITHUB_SHORTHAND_RE);
	if (shorthand && !trimmed.startsWith("@") && !trimmed.includes(":")) {
		return {
			source: { source: "github", repo: `${shorthand[1]}/${shorthand[2]}`, ref: shorthand[3] },
			suggestedName: shorthand[2],
		};
	}

	return { error: `Could not understand "${trimmed}" — try owner/repo, a git URL, an https marketplace.json URL, or a local path.` };
}
