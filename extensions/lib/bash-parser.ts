/**
 * The tree-sitter bash grammar, loaded once per process (pure apart from
 * loading the WASM files).
 *
 * Loading is asynchronous (about 5 ms: the web-tree-sitter runtime, then the
 * grammar); parsing after that is synchronous, so the permission gate and the
 * guards stay synchronous. Loading starts when this module is first imported.
 * A hook that parses awaits {@link bashParserReady} first; until the promise
 * settles, and forever if loading failed, {@link parseBash} returns undefined
 * and every caller treats the command as unparseable (findings §30).
 *
 * The loaded parser lives on `globalThis`, not in module state: jiti gives
 * each extension its own instance of this module (findings §3), and five
 * extensions parse bash. It is a cache of a pure function, so sharing it
 * changes no behaviour, only how often the grammar is loaded.
 *
 * The grammar file is tree-sitter-bash's release WASM, vendored under
 * `grammars/` (MIT, `grammars/LICENSE-tree-sitter-bash`): the npm package
 * builds a native addon on install, which this package never uses.
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser, type Tree } from "web-tree-sitter";

interface BashParserState {
	ready: Promise<void>;
	parser?: Parser;
	/** Why loading failed, once it has. */
	error?: string;
}

const STATE_KEY = Symbol.for("one-code.bash-parser");

const GRAMMAR_PATH = join(dirname(fileURLToPath(import.meta.url)), "grammars", "tree-sitter-bash.wasm");

function state(): BashParserState {
	const store = globalThis as { [STATE_KEY]?: BashParserState };
	let current = store[STATE_KEY];
	if (!current) {
		const created: BashParserState = { ready: Promise.resolve() };
		created.ready = load(created);
		store[STATE_KEY] = created;
		current = created;
	}
	return current;
}

async function load(target: BashParserState): Promise<void> {
	try {
		const runtimeWasm = createRequire(import.meta.url).resolve("web-tree-sitter/web-tree-sitter.wasm");
		await Parser.init({ locateFile: () => runtimeWasm });
		const parser = new Parser();
		parser.setLanguage(await Language.load(GRAMMAR_PATH));
		target.parser = parser;
	} catch (error) {
		target.error = `the bash grammar failed to load (${error instanceof Error ? error.message : String(error)})`;
	}
}

// Start loading on import, so the grammar is ready long before the first
// tool call; hooks still await it.
state();

/** Settles once the grammar has loaded or failed to load. Never rejects. */
export function bashParserReady(): Promise<void> {
	return state().ready;
}

/** Why the grammar is unavailable: still loading, or the load error. Undefined once it is ready. */
export function bashParserUnavailable(): string | undefined {
	const current = state();
	if (current.parser) return undefined;
	return current.error ?? "the bash grammar is still loading";
}

/**
 * Parse `command` into a syntax tree, or undefined when the grammar is not
 * loaded. The caller must `delete()` the tree: it lives in WASM memory.
 */
export function parseBash(command: string): Tree | undefined {
	return state().parser?.parse(command) ?? undefined;
}
