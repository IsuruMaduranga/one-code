/**
 * Markdown prose for the subagent transcript viewer: the child's assistant
 * text renders through pi-tui's real `Markdown` component — the exact renderer
 * the main transcript uses — so the panel matches the main session's text
 * fidelity (headings, code highlighting, lists) instead of plain wrapped text.
 *
 * pi-tui is pi's own nested dependency (not hoisted, not ours to pin), and it
 * cannot be require.resolve'd: pi-coding-agent's exports map defines only the
 * "import" condition (createRequire fails with `No "exports" main defined`)
 * and exposes no "./package.json" subpath. So the package is located by
 * walking the same node_modules candidates Node itself would try — nested
 * under pi-coding-agent first (npm's layout here), then hoisted as a sibling —
 * and its entry file is imported by URL. Resolving relative to THIS file gives
 * the same pi-coding-agent instance the rest of the package's imports bind to.
 *
 * `Markdown` memoizes render by (text, width); instances are cached per
 * transcript block (immutable text → WeakMap, GC'd with the block) and per
 * streaming slot (mutable text → keyed Map + setText, guarded so an unchanged
 * text never invalidates the cache). The markdown theme comes from
 * pi-coding-agent's `getMarkdownTheme()`, which reads the theme pi initialized
 * at startup.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { ProseRenderer } from "./panel-render.ts";

interface MarkdownLike {
	setText(text: string): void;
	render(width: number): string[];
}

type MarkdownCtor = new (text: string, paddingX: number, paddingY: number, theme: unknown) => MarkdownLike;

/** The pi-tui entry file, found by walking node_modules (see module doc). Exported for tests. */
export function resolvePiTuiEntry(): string {
	const req = createRequire(import.meta.url);
	const bases = req.resolve.paths("@earendil-works/pi-coding-agent") ?? [];
	for (const base of bases) {
		const agentDir = join(base, "@earendil-works", "pi-coding-agent");
		if (!existsSync(join(agentDir, "package.json"))) continue;
		for (const candidate of [
			join(agentDir, "node_modules", "@earendil-works", "pi-tui"),
			join(base, "@earendil-works", "pi-tui"),
		]) {
			const pkgPath = join(candidate, "package.json");
			if (!existsSync(pkgPath)) continue;
			const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
				exports?: Record<string, string | { import?: string; default?: string }>;
				module?: string;
				main?: string;
			};
			const dot = pkg.exports?.["."];
			const entry = (typeof dot === "string" ? dot : (dot?.import ?? dot?.default)) ?? pkg.module ?? pkg.main ?? "index.js";
			return join(candidate, entry);
		}
	}
	throw new Error("cannot locate @earendil-works/pi-tui next to pi-coding-agent");
}

let ctorPromise: Promise<MarkdownCtor> | undefined;

async function loadMarkdownCtor(): Promise<MarkdownCtor> {
	return (ctorPromise ??= (async () => {
		const mod = (await import(pathToFileURL(resolvePiTuiEntry()).href)) as { Markdown?: MarkdownCtor };
		if (typeof mod.Markdown !== "function") throw new Error("pi-tui exports no Markdown component");
		return mod.Markdown;
	})().catch((error) => {
		ctorPromise = undefined; // a transient failure may recover on retry
		throw error;
	}));
}

/**
 * Build the markdown ProseRenderer. Throws when pi-tui cannot be resolved —
 * the caller falls back to plain wrapped text and tells the user once.
 */
export async function createMarkdownProse(): Promise<ProseRenderer> {
	const Markdown = await loadMarkdownCtor();
	const theme = getMarkdownTheme();
	const blockCache = new WeakMap<object, MarkdownLike>();
	const streamCache = new Map<string, { md: MarkdownLike; text: string }>();
	return (ref, text, width) => {
		if (typeof ref === "string") {
			let slot = streamCache.get(ref);
			if (!slot) {
				slot = { md: new Markdown(text, 0, 0, theme), text };
				streamCache.set(ref, slot);
			} else if (slot.text !== text) {
				slot.md.setText(text);
				slot.text = text;
			}
			return slot.md.render(width);
		}
		let md = blockCache.get(ref);
		if (!md) {
			md = new Markdown(text, 0, 0, theme);
			blockCache.set(ref, md);
		}
		return md.render(width);
	};
}
