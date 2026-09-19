/**
 * Language and server detection (pure).
 *
 * The server command table follows the one in the MIT-licensed
 * `pi-lsp-extension` package, which is a good curated starting point.
 */

import { existsSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { ancestorDirs } from "../lib/claude-context.ts";

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
 * The TypeScript install typescript-language-server will use for `root`: the
 * nearest `node_modules/typescript` from the project root upward (the server
 * resolves `typescript` the way Node does, so a monorepo's root install
 * counts), or undefined when there is none. A global `npm i -g typescript`
 * is never found — npm does not put global siblings on each other's
 * resolution path (verified 2026-09-19 on macOS and Ubuntu, findings §23).
 */
export function findTypescript(root: string): string | undefined {
	return ancestorDirs(root)
		.reverse()
		.map((dir) => join(dir, "node_modules", "typescript"))
		.find((candidate) => existsSync(candidate));
}

/** The one way to give typescript-language-server a TypeScript it will use: 5.x in the project (findings §23). */
export const TYPESCRIPT_PROJECT_INSTALL = "npm install -D typescript@5";

/**
 * Say up front why typescript-language-server cannot analyse `root`, instead
 * of surfacing the server's own initialize failure: no TypeScript reachable
 * from the project (the server does not use a global one), or a TypeScript 7
 * whose native compiler dropped the `lib/tsserver.js` the server requires.
 */
export function typescriptPreflight(root: string): string | undefined {
	const typescript = findTypescript(root);
	if (!typescript) {
		return `No TypeScript installation is reachable from this project (typescript-language-server resolves \`typescript\` from the project's node_modules upward and never uses a global install). Run \`${TYPESCRIPT_PROJECT_INSTALL}\` in the project for LSP diagnostics.`;
	}
	if (existsSync(join(typescript, "lib", "tsserver.js"))) return undefined;
	return `The project's TypeScript has no lib/tsserver.js (TypeScript 7's native compiler removed it), so typescript-language-server cannot analyse this project. Run \`${TYPESCRIPT_PROJECT_INSTALL}\` for LSP diagnostics.`;
}
