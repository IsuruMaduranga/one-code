/** Claude Code 2.1.289 rule parsing/discovery. Pure filesystem/text helpers; no pi state. */
import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";
import ignore, { type Ignore } from "ignore";
import { Lexer, type Token } from "marked";
import { parse as parseYaml } from "yaml";
import { absoluteFrom, comparablePath, expandTilde, forwardSlashes, isPathAtOrUnder, isRelativeInside, tryRealpath } from "./paths.ts";

/** pO/Oee: instruction files larger than 4 MiB are skipped, never truncated. */
export const MAX_INSTRUCTION_BYTES = 4_194_304;

export interface RuleFile {
	path: string;
	key: string;
	content: string;
	globs?: string[];
	/** Import/link provenance for the startup external-includes warning. */
	parent?: string;
	linkedFrom?: string;
}

/** f_t/H in the binary: comma lists and brace alternatives, not numeric brace ranges. */
export function splitRulePaths(value: unknown): string[] {
	const budget = { results: 1000, bytes: 4_194_304 };
	const expand = (pattern: string): string[] => {
		if (!pattern.includes("{")) return [pattern];
		const result: string[] = [];
		const pending = [pattern];
		for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
			const match = next.match(/^([^{]*)\{([^}]+)\}(.*)$/);
			if (!match) { result.push(next); continue; }
			const alternatives = match[2].split(",").map((part) => part.trim());
			budget.bytes -= next.length;
			const count = result.length + pending.length + alternatives.length;
			if (budget.bytes < 0 || count > budget.results || count * pattern.length > budget.bytes) return [pattern];
			for (let i = alternatives.length - 1; i >= 0; i--) pending.push(match[1] + alternatives[i] + match[3]);
		}
		budget.results -= result.length;
		budget.bytes -= result.length * pattern.length;
		return result;
	};
	const split = (input: unknown): string[] => {
		if (Array.isArray(input)) return input.flatMap(split);
		if (typeof input !== "string") return [];
		const parts: string[] = [];
		let part = "", depth = 0;
		for (const char of input) {
			if (char === "{") depth++;
			if (char === "}") depth--;
			if (char === "," && depth === 0) { if (part.trim()) parts.push(part.trim()); part = ""; }
			else part += char;
		}
		if (part.trim()) parts.push(part.trim());
		return parts.flatMap(expand);
	};
	return split(value);
}

/** Fs retries hand-written YAML after quoting special scalars and expanding leading tabs. */
function frontmatterValue(yaml: string): Record<string, unknown> {
	const object = (value: unknown): Record<string, unknown> =>
		value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
	try { return object(parseYaml(yaml)); } catch { /* retry below */ }
	const repaired = yaml.split("\n").map((line) => {
		const match = line.match(/^([a-zA-Z_-]+):\s+(\S.*)$/);
		if (!match) return line;
		const [, key, value] = match;
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return line;
		if (value.startsWith("[") && value.endsWith("]")) {
			try { if (Array.isArray(parseYaml(value))) return line; } catch { /* quote it below */ }
		}
		const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
		return /[{}[\]*&#!|>%@`]|: /.test(value) ? `${key}: "${escaped}"` : line;
	}).join("\n").replace(/^\t+/gm, (tabs) => "  ".repeat(tabs.length));
	try { return object(parseYaml(repaired)); } catch { return {}; }
}

/** W1n/tgt/Sxe: remove frontmatter and block HTML comments, retain raw body whitespace. */
export function parseRule(content: string): { content: string; globs?: string[] } {
	const withoutBom = content.replace(/^\uFEFF/, "");
	const match = withoutBom.match(/^---\s*\n([\s\S]*?)---\s*\n?/);
	const metadata = match ? frontmatterValue(match[1]) : {};
	let body = match ? withoutBom.slice(match[0].length) : content;
	if (body.includes("<!--")) {
		body = new Lexer({ gfm: false }).lex(body).map((token) => {
			if (token.type !== "html" || !token.raw.trimStart().startsWith("<!--") || !token.raw.includes("-->")) return token.raw;
			const residue = token.raw.replace(/<!--[\s\S]*?-->/g, "");
			return residue.trim() ? residue : "";
		}).join("");
	}
	const paths = splitRulePaths(metadata.paths).map((path) => path.endsWith("/**") ? path.slice(0, -3) : path).filter(Boolean);
	return { content: body, ...(paths.length && !paths.every((path) => path === "**") ? { globs: paths } : {}) };
}

/** $ee/lje: ignore's gitignore semantics (including negation), never a glob-library approximation. */
export function ruleMatches(globs: string[] | undefined, filePath: string, base: string): boolean {
	if (!globs?.length) return false;
	let candidate = isAbsolute(filePath) ? relative(base, filePath) : filePath;
	if (isAbsolute(filePath) && !isRelativeInside(candidate)) {
		// Both sides resolved: a cwd reached through a symlink (or a Windows 8.3
		// short name) spells the base differently from the file's real directory.
		const parent = tryRealpath(dirname(filePath));
		if (parent) candidate = relative(tryRealpath(base) ?? base, join(parent, basename(filePath)));
	}
	if (!isRelativeInside(candidate)) return false;
	return globMatcher(globs).ignores(forwardSlashes(candidate));
}

/** Compiled matchers by glob list: a read checks every conditional rule, so each list compiles once. */
const matchers = new Map<string, Ignore>();

function globMatcher(globs: string[]): Ignore {
	const key = JSON.stringify(globs);
	let matcher = matchers.get(key);
	if (!matcher) {
		const valid = globs.filter((glob) => {
			try { ignore().add(glob).test("probe"); return true; } catch { return false; }
		});
		if (matchers.size >= 1024) matchers.clear();
		matchers.set(key, (matcher = ignore().add(valid)));
	}
	return matcher;
}

/**
 * The paths a walk being cached has looked at, each with its stat signature
 * from before it was read: a change while the walk runs makes the next call
 * walk again rather than keep what it read.
 */
let touched: Map<string, string> | undefined;

function touch(path: string): void {
	if (touched && !touched.has(path)) touched.set(path, signature(path));
}

/** What a stat can see of a path (through a link too); "-" when it is missing. */
function signature(path: string): string {
	try {
		const link = lstatSync(path);
		const stat = link.isSymbolicLink() ? statSync(path) : link;
		return `${link.ino}:${stat.ino}:${stat.mtimeMs}:${stat.size}:${stat.nlink}`;
	} catch {
		return "-";
	}
}

function isLink(path: string): boolean {
	touch(path);
	try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

/**
 * One Code addition, matching the inline expander (claude-context.ts
 * `readImportTarget`): an import ending a sentence (`@docs/x.md.`) names
 * `docs/x.md` when only that is a file. Claude Code reads the literal path,
 * which wins whenever it exists.
 */
function withoutTrailingPunctuation(target: string): string {
	for (let candidate = target; ; candidate = candidate.slice(0, -1)) {
		touch(candidate);
		try { if (statSync(candidate).isFile()) return candidate; } catch { /* not a file: peel */ }
		if (candidate.length <= 1 || !/[.,;:!?)\]]$/.test(candidate)) return target;
	}
}

/** Y1n: imports are separate instruction files, not substitutions into the rule's body. */
function ruleImports(content: string, path: string, home: string): string[] {
	const found = new Set<string>();
	const text = (body: string) => {
		for (const match of body.matchAll(/(?:^|\s)@((?:[^\s\\]|\\ )+)/g)) {
			const ref = match[1].split("#")[0].replaceAll("\\ ", " ");
			if (!ref || !(ref.startsWith("./") || ref.startsWith("~/") || (ref.startsWith("/") && ref !== "/") || /^[a-zA-Z0-9._-]/.test(ref))) continue;
			found.add(withoutTrailingPunctuation(absoluteFrom(dirname(path), expandTilde(ref, home))));
		}
	};
	const walk = (tokens: Token[]) => {
		for (const token of tokens) {
			if (token.type === "code" || token.type === "codespan") continue;
			if (token.type === "html") {
				if (token.raw.trimStart().startsWith("<!--") && token.raw.includes("-->")) text(token.raw.replace(/<!--[\s\S]*?-->/g, ""));
				continue;
			}
			if (token.type === "text") text(token.text);
			if ("tokens" in token && token.tokens) walk(token.tokens);
			if ("items" in token) walk(token.items);
		}
	};
	walk(new Lexer({ gfm: false }).lex(content));
	return [...found];
}

const TEXT_EXTENSIONS = new Set([
	".md", ".txt", ".text", ".json", ".yaml", ".yml", ".toml", ".xml", ".csv", ".html", ".htm", ".css", ".scss", ".sass", ".less",
	".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".py", ".pyi", ".pyw", ".rb", ".erb", ".rake", ".go", ".rs",
	".java", ".kt", ".kts", ".scala", ".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hxx", ".cs", ".swift", ".sh", ".bash", ".zsh",
	".fish", ".ps1", ".bat", ".cmd", ".env", ".ini", ".cfg", ".conf", ".config", ".properties", ".sql", ".graphql", ".gql", ".proto",
	".vue", ".svelte", ".astro", ".ejs", ".hbs", ".pug", ".jade", ".php", ".pl", ".pm", ".lua", ".r", ".dart", ".ex", ".exs",
	".erl", ".hrl", ".clj", ".cljs", ".cljc", ".edn", ".hs", ".lhs", ".elm", ".ml", ".mli", ".f", ".f90", ".f95", ".for",
	".cmake", ".make", ".makefile", ".gradle", ".sbt", ".rst", ".adoc", ".asciidoc", ".org", ".tex", ".latex", ".lock", ".log", ".diff", ".patch",
]);

export interface RuleOptions {
	rulesDir: string;
	cwd: string;
	home: string;
	scope: "Project" | "User" | "Managed";
	/** Undefined selects unconditional files; a target selects only matching conditional files. */
	filePath?: string;
	/** Select every conditional file, whatever its globs (the auto-mode classifier's instructions). */
	allConditional?: boolean;
	processed?: Set<string>;
	/** Normal CLI user rules allow external includes; project/managed rules need approval. */
	includeExternal?: boolean;
	/** Independent mode excludes Claude locations before reading or following their imports. */
	allowPath?: (path: string) => boolean;
	/**
	 * The directory a project file belongs to (`<dir>` for `<dir>/.claude/CLAUDE.md`).
	 * A file linked out of both it and the cwd is an external include, like an import.
	 */
	ownerDir?: string;
}

/** A text extension, or none: checked for the name read and, through a link, the file it points to. */
function textExtension(path: string): boolean {
	const ext = extname(path).toLowerCase();
	return !ext || TEXT_EXTENSIONS.has(ext);
}

/** lJ: parent first, separate parsed imports, canonical dedupe, depths zero through four. */
export function readRuleInstructions(path: string, opts: Pick<RuleOptions, "cwd" | "home" | "scope" | "processed" | "includeExternal" | "allowPath" | "ownerDir">): RuleFile[] {
	const includeExternal = opts.includeExternal ?? opts.scope === "User";
	const processed = opts.processed ?? new Set<string>();
	const realCwd = tryRealpath(opts.cwd) ?? opts.cwd;
	const inside = (target: string) => isPathAtOrUnder(target, realCwd);
	const realOwner = opts.ownerDir === undefined ? undefined : tryRealpath(opts.ownerDir) ?? opts.ownerDir;
	const load = (path: string, depth = 0, parent?: string): RuleFile[] => {
		touch(path);
		const key = tryRealpath(path);
		if (key) touch(key);
		if (!key || depth >= 5 || processed.has(comparablePath(key)) || (opts.allowPath && (!opts.allowPath(path) || !opts.allowPath(key))) || (depth > 0 && !includeExternal && !inside(key))) return [];
		// One Code addition: a project file linked out of the project is an include the user must approve.
		const linkedOut = depth === 0 && realOwner !== undefined && !inside(key) && !isPathAtOrUnder(key, realOwner);
		if (linkedOut && !includeExternal) return [];
		try {
			const stat = statSync(key);
			if (!stat.isFile() || stat.size > MAX_INSTRUCTION_BYTES || (opts.scope === "User" && !includeExternal && (stat.nlink > 1 || (depth === 0 && isLink(path))))) return [];
			processed.add(comparablePath(key));
			if (!textExtension(path) || !textExtension(key)) return [];
			const parsed = parseRule(readFileSync(key, "utf8"));
			if (!parsed.content.trim()) return [];
			return [{ path, key, ...parsed, ...(parent ? { parent } : {}), ...(linkedOut ? { linkedFrom: path } : {}) }, ...ruleImports(parsed.content, key, opts.home).flatMap((ref) => load(ref, depth + 1, key))];
		} catch { return []; }
	};
	return load(path);
}

/**
 * Parsed walks by rules directory, scope, consent, cwd and home. Every `read`
 * attaches rules, so a walk (readdir, realpath, read, lex and YAML per file) is
 * reused while a stat of every path it looked at, imports and missing paths
 * included, still matches. Consent is part of the key: a walk made without it
 * is never served with it, or the other way round.
 */
const walks = new Map<string, { stamps: Map<string, string>; files: RuleFile[] }>();

/** o$e: readdir order, depth-first, lowercase .md only; canonical identities stop link cycles. */
export function discoverRules(opts: RuleOptions): RuleFile[] {
	const base = opts.scope === "Project" ? dirname(dirname(opts.rulesDir)) : opts.cwd;
	const select = (files: RuleFile[]) =>
		files
			.filter((file) => (opts.allConditional ? Boolean(file.globs) : opts.filePath === undefined ? !file.globs : ruleMatches(file.globs, opts.filePath, base)))
			.map((file) => ({ ...file }));
	// A shared dedupe set or a path filter makes the walk depend on its caller: never cached.
	if (opts.processed || opts.allowPath || touched) return select(walkRules(opts));
	const key = JSON.stringify([opts.rulesDir, opts.scope, opts.includeExternal ?? opts.scope === "User", opts.cwd, opts.home]);
	const cached = walks.get(key);
	if (cached && [...cached.stamps].every(([path, stamp]) => signature(path) === stamp)) return select(cached.files);
	const stamps = new Map<string, string>();
	touched = stamps;
	let files: RuleFile[];
	try { files = walkRules(opts); } finally { touched = undefined; }
	if (walks.size >= 256) walks.clear();
	walks.set(key, { stamps, files });
	return select(files);
}

function walkRules(opts: RuleOptions): RuleFile[] {
	const includeExternal = opts.includeExternal ?? opts.scope === "User";
	const visited = new Set<string>();
	const processed = opts.processed ?? new Set<string>();
	const realCwd = tryRealpath(opts.cwd) ?? opts.cwd;
	const inside = (path: string) => isPathAtOrUnder(path, realCwd);
	const walk = (dir: string, linkedFrom?: string): RuleFile[] => {
		touch(dir);
		const real = tryRealpath(dir);
		if (real) touch(real);
		if (!real || visited.has(comparablePath(real))) return [];
		// o2n/Tgt allow external user rules. o$e's J1n gate checks a linked
		// .claude parent only on the cwd/ancestor walk, not on nested directories.
		const linkedProjectParent = opts.scope === "Project" && isPathAtOrUnder(opts.cwd, dirname(dirname(dir))) && isLink(dirname(dir));
		if (!includeExternal && !inside(real) && (isLink(dir) || linkedProjectParent)) return [];
		visited.add(comparablePath(real));
		const files: RuleFile[] = [];
		try {
			for (const entry of readdirSync(real, { withFileTypes: true })) {
				const path = join(real, entry.name);
				touch(path);
				const key = tryRealpath(path);
				if (!key || (!includeExternal && key !== path && !inside(key))) continue;
				const stat = entry.isSymbolicLink() ? statSync(key) : entry;
				const source = linkedFrom ? join(linkedFrom, entry.name) : join(dir, entry.name);
				if (stat.isDirectory()) files.push(...walk(key, source !== key ? source : undefined));
				else if (stat.isFile() && entry.name.endsWith(".md")) {
					files.push(...readRuleInstructions(key, { ...opts, processed }).map((file) =>
						file.key === key && source !== key ? { ...file, linkedFrom: source } : file,
					));
				}
			}
			return files;
		} catch { return []; }
	};
	return walk(opts.rulesDir);
}
