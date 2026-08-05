/**
 * lsp extension — language-server intelligence, from the community
 * `pi-lsp-extension` package: diagnostics, hover, definition, references,
 * symbols, rename, code actions, completions, plus tree-sitter code overview
 * and search.
 *
 * Its most Claude-Code-like behavior needs no tool at all: a `tool_result`
 * hook appends error diagnostics to `write`/`edit` results, so the model sees
 * compile errors it just introduced. That stays active.
 *
 * The query tools themselves are deferred behind `tool_search` — eleven extra
 * schemas would dominate the prompt, and most turns never need them.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import lspExtension from "pi-lsp-extension/src/index.ts";
import { DEFER_CHANNEL } from "../lib/deferred.ts";

const DEFERRED: Array<{ name: string; keywords: string[] }> = [
	{ name: "lsp_diagnostics", keywords: ["diagnostics", "errors", "warnings", "compile", "typecheck", "lint"] },
	{ name: "lsp_hover", keywords: ["hover", "type", "signature", "docs", "what is"] },
	{ name: "lsp_definition", keywords: ["definition", "declaration", "go to", "jump"] },
	{ name: "lsp_references", keywords: ["references", "usages", "callers", "who calls"] },
	{ name: "lsp_symbols", keywords: ["symbols", "outline", "structure"] },
	{ name: "lsp_rename", keywords: ["rename", "refactor", "symbol rename"] },
	{ name: "lsp_code_actions", keywords: ["code action", "quick fix", "autofix"] },
	{ name: "lsp_completions", keywords: ["completion", "autocomplete", "suggest"] },
	{ name: "code_overview", keywords: ["overview", "outline", "map", "structure", "summarize file"] },
	{ name: "code_search", keywords: ["ast search", "structural search", "code search"] },
	{ name: "ast_search", keywords: ["ast", "structural search", "tree-sitter"] },
	{ name: "code_rewrite", keywords: ["structural rewrite", "codemod", "ast rewrite"] },
];

const ONE_SHOT_MODES = new Set(["json", "print"]);

/**
 * Detects a one-shot run (`-p`, `--mode json`) from argv, because tools must be
 * registered while the extension loads — before any event hands us `ctx.mode`.
 * RPC counts as interactive: the session is long-lived and shuts down cleanly.
 */
export function isOneShotInvocation(argv: string[]): boolean {
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "-p" || arg === "--print") return true;
		if (arg === "--mode") return ONE_SHOT_MODES.has(argv[i + 1] ?? "");
		if (arg.startsWith("--mode=")) return ONE_SHOT_MODES.has(arg.slice("--mode=".length));
	}
	return false;
}

export default function lspWrapper(pi: ExtensionAPI) {
	// Skipped in one-shot runs: language servers only warm up usefully across a
	// session, they keep the process alive past the final turn, and a cold
	// server has no diagnostics to report for a single edit anyway.
	if (isOneShotInvocation(process.argv) || process.env.PI_SUBAGENT_CHILD === "1") return;

	lspExtension(pi);
	for (const entry of DEFERRED) {
		pi.events.emit(DEFER_CHANNEL, entry);
	}
}
