/**
 * Language and server detection (pure).
 *
 * The server command table follows the one in the MIT-licensed
 * `pi-lsp-extension` package, which is a good curated starting point.
 */

import { existsSync } from "node:fs";
import { dirname, extname, join } from "node:path";

export interface ServerConfig {
	command: string;
	args: string[];
	/** Files that mark the project root for this language. */
	rootMarkers: string[];
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
	".ts": "typescript",
	".tsx": "typescriptreact",
	".mts": "typescript",
	".cts": "typescript",
	".js": "javascript",
	".jsx": "javascriptreact",
	".mjs": "javascript",
	".cjs": "javascript",
	".py": "python",
	".pyi": "python",
	".go": "go",
	".rs": "rust",
	".java": "java",
};

const TS_MARKERS = ["tsconfig.json", "jsconfig.json", "package.json"];

export const SERVERS: Record<string, ServerConfig> = {
	typescript: { command: "typescript-language-server", args: ["--stdio"], rootMarkers: TS_MARKERS },
	typescriptreact: { command: "typescript-language-server", args: ["--stdio"], rootMarkers: TS_MARKERS },
	javascript: { command: "typescript-language-server", args: ["--stdio"], rootMarkers: TS_MARKERS },
	javascriptreact: { command: "typescript-language-server", args: ["--stdio"], rootMarkers: TS_MARKERS },
	python: { command: "pyright-langserver", args: ["--stdio"], rootMarkers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt"] },
	go: { command: "gopls", args: ["serve"], rootMarkers: ["go.mod", "go.work"] },
	rust: { command: "rust-analyzer", args: [], rootMarkers: ["Cargo.toml"] },
	java: { command: "jdtls", args: [], rootMarkers: ["pom.xml", "build.gradle", "build.gradle.kts"] },
};

export function languageIdForPath(path: string): string | undefined {
	return LANGUAGE_BY_EXTENSION[extname(path).toLowerCase()];
}

export function serverForPath(path: string): { languageId: string; config: ServerConfig } | undefined {
	const languageId = languageIdForPath(path);
	if (!languageId) return undefined;
	const config = SERVERS[languageId];
	return config ? { languageId, config } : undefined;
}

/** Nearest ancestor directory containing one of the language's root markers. */
export function findProjectRoot(startPath: string, markers: string[], fallback: string): string {
	let dir = dirname(startPath);
	while (true) {
		if (markers.some((marker) => existsSync(join(dir, marker)))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return fallback;
		dir = parent;
	}
}

/**
 * TypeScript 7's native compiler dropped `lib/tsserver.js`, which
 * typescript-language-server requires. Detect that up front so we can say so
 * instead of reporting a mystery server failure.
 */
export function typescriptPreflight(root: string): string | undefined {
	const localTypescript = join(root, "node_modules", "typescript");
	if (!existsSync(localTypescript)) return undefined;
	if (existsSync(join(localTypescript, "lib", "tsserver.js"))) return undefined;
	return "The project's local TypeScript has no lib/tsserver.js (TypeScript 7's native compiler removed it), so typescript-language-server cannot analyse this project. Install typescript 5.x as a dev dependency for LSP diagnostics.";
}
