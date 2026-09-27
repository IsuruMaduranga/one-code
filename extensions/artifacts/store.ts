/**
 * The local artifact store (pure fs, no pi imports): self-contained HTML pages
 * the model publishes, kept under `~/.onecode/artifacts/` and viewed in the
 * user's own browser through `file:` URLs. One Code's counterpart of Claude
 * Code's hosted Artifact tool (`working-docs/decisions/tools.md`, "Artifacts").
 *
 *   artifacts/index.html                 the gallery (gallery.ts), rewritten on every change
 *   artifacts/<id>/index.html            the current version
 *   artifacts/<id>/view.html             the page under a viewer bar (viewer.ts), what the browser opens
 *   artifacts/<id>/meta.json             title, description, source path, project, version
 *   artifacts/<id>/download.js           the current page as a script payload (see gallery.ts)
 *   artifacts/<id>/versions/v<N>.html    every earlier version, never rewritten
 *   artifacts/<id>/versions/v<N>.js      its download payload
 *
 * The meta files are the only source of truth; the gallery is regenerated from
 * them, so two sessions publishing at once cannot leave it naming a missing
 * page for longer than the next write.
 *
 * Publishing the same source file again updates that artifact in place, as
 * Claude Code's republish-by-path does; an artifact from an earlier session is
 * updated by passing its id.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, extname, join, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readJsonFile, writeJsonAtomic, writeTextAtomic } from "../lib/atomic-write.ts";
import { comparablePath, isPathAtOrUnder, oneCodeStateDir, tildify } from "../lib/paths.ts";
import { renderDownloadPayload, renderGallery } from "./gallery.ts";
import { renderViewer } from "./viewer.ts";

export interface ArtifactMeta {
	id: string;
	title: string;
	description?: string;
	/** The absolute path the page was last published from. */
	sourcePath: string;
	/** The project (git root, else cwd) of the session that first published it. */
	project?: string;
	createdAt: string;
	updatedAt: string;
	/** The current version's number; versions/v1 … v<version - 1> hold the earlier ones. */
	version: number;
}

/** Claude Code's page size limit for a published artifact. */
export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HTML_EXTENSIONS = new Set([".html", ".htm"]);

/** `~/.onecode/artifacts`, honouring `ONECODE_STATE_DIR`. */
export function artifactsRoot(env: Record<string, string | undefined> = process.env, home?: string): string {
	return join(oneCodeStateDir(env, home), "artifacts");
}

function isArtifactId(id: string): boolean {
	return ID_PATTERN.test(id);
}

export function pagePath(root: string, id: string): string {
	return join(root, id, "index.html");
}

/** The page with the viewer bar over it, what the browser opens. */
export function viewerPath(root: string, id: string): string {
	return join(root, id, "view.html");
}

export function versionPath(root: string, id: string, version: number): string {
	return join(root, id, "versions", `v${version}.html`);
}

export function galleryPath(root: string): string {
	return join(root, "index.html");
}

export function fileUrl(path: string): string {
	return pathToFileURL(path).href;
}

/** A lowercase, hyphenated slug of `text`, at most 40 characters; "page" when nothing survives. */
export function slugify(text: string): string {
	const slug = text
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/, "");
	return slug || "page";
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** The page's `<title>` text, entity-decoded and whitespace-collapsed, or undefined. */
export function pageTitle(html: string): string | undefined {
	const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
	if (!match) return undefined;
	const text = match[1]
		.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, name: string) => {
			if (name[0] === "#") {
				const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
				return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
			}
			return ENTITIES[name.toLowerCase()] ?? whole;
		})
		.replace(/\s+/g, " ")
		.trim();
	return text || undefined;
}

function readMeta(root: string, id: string): ArtifactMeta | undefined {
	const meta = readJsonFile<ArtifactMeta>(join(root, id, "meta.json"));
	if (!meta || typeof meta !== "object" || meta.id !== id || !Number.isInteger(meta.version)) return undefined;
	if ([meta.title, meta.sourcePath, meta.createdAt, meta.updatedAt].some((field) => typeof field !== "string")) return undefined;
	return meta;
}

/** One artifact's meta, or undefined when the id is malformed or unknown. */
export function getArtifact(root: string, id: string): ArtifactMeta | undefined {
	return isArtifactId(id) ? readMeta(root, id) : undefined;
}

/** Every artifact with a readable meta file, most recently updated first. */
export function listArtifacts(root: string): ArtifactMeta[] {
	let names: string[];
	try {
		names = readdirSync(root);
	} catch {
		return [];
	}
	return names
		.filter(isArtifactId)
		.map((id) => readMeta(root, id))
		.filter((meta): meta is ArtifactMeta => meta !== undefined)
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

/**
 * The artifact id a reference names: a bare id, or a `file:` URL or path to
 * anything inside that artifact's folder (what `publish` returned). Undefined
 * when it names no stored artifact.
 */
export function resolveArtifactRef(root: string, ref: string): string | undefined {
	const trimmed = ref.trim();
	if (getArtifact(root, trimmed)) return trimmed;
	let path: string;
	try {
		path = trimmed.startsWith("file:") ? fileURLToPath(trimmed) : resolve(trimmed);
	} catch {
		return undefined;
	}
	if (!isInsideStore(root, path)) return undefined;
	// The first segment below the root, on comparablePath forms (ids are lowercase).
	const id = posix.relative(comparablePath(root), comparablePath(path)).split("/")[0];
	return getArtifact(root, id) ? id : undefined;
}

/** Whether `path` is inside the store (a page there cannot be published as its own source). */
function isInsideStore(root: string, path: string): boolean {
	return isPathAtOrUnder(path, root);
}

export interface PublishInput {
	/** Absolute path of the HTML file being published. */
	sourcePath: string;
	html: string;
	/** Fallback title for a page with no `<title>`. */
	title?: string;
	description?: string;
	project?: string;
	/** Update this artifact instead of the one published from `sourcePath`. */
	id?: string;
	now: Date;
	/** A short random suffix that keeps two same-titled artifacts apart. */
	suffix: () => string;
}

export interface PublishResult {
	meta: ArtifactMeta;
	created: boolean;
}

/**
 * Check a page before it is stored: the reason it cannot be published, or
 * undefined. Every reason names the fix.
 */
export function publishProblem(root: string, sourcePath: string, bytes: number): string | undefined {
	if (!HTML_EXTENSIONS.has(extname(sourcePath).toLowerCase())) {
		return `${sourcePath} is not an .html file. Write the page as a single self-contained .html file (inline CSS and JS) and publish that.`;
	}
	if (isInsideStore(root, sourcePath)) {
		return `${sourcePath} is inside the artifact store. Edit a copy in your scratchpad or the project and publish that copy, passing the artifact's id to update it in place.`;
	}
	if (bytes === 0) return `${sourcePath} is empty. Write the page first, then publish it.`;
	if (bytes > MAX_ARTIFACT_BYTES) {
		return `${sourcePath} is ${(bytes / 1024 / 1024).toFixed(1)} MB; an artifact is at most 16 MB. Move large data or media out of the page, or shrink it.`;
	}
	return undefined;
}

/** Store a page: a new artifact, or a new version of an existing one. */
export function publishArtifact(root: string, input: PublishInput): PublishResult {
	const sourcePath = resolve(input.sourcePath);
	let existing: ArtifactMeta | undefined;
	if (input.id !== undefined) {
		existing = getArtifact(root, input.id);
		if (!existing) throw new Error(`No artifact has the id "${input.id}". Run the artifact tool with action "list" to see the ids.`);
	} else {
		const key = comparablePath(sourcePath);
		existing = listArtifacts(root).find((meta) => comparablePath(meta.sourcePath) === key);
	}

	const title = pageTitle(input.html) ?? input.title?.trim() ?? existing?.title ?? basename(sourcePath, extname(sourcePath));
	const description = input.description?.trim() || existing?.description;
	const now = input.now.toISOString();
	let meta: ArtifactMeta;
	if (existing) {
		const current = pagePath(root, existing.id);
		// A size match first, so a changed page (the usual case) is never read back.
		const unchanged = existsSync(current) && statSync(current).size === Buffer.byteLength(input.html) && readFileSync(current, "utf-8") === input.html;
		if (unchanged) {
			// Same bytes: refresh the details without a version that differs from nothing.
			meta = { ...existing, title, description, sourcePath, updatedAt: now };
			writeDetails(root, meta);
			return { meta, created: false };
		}
		// Copy, never move: the current page stays in place until the atomic
		// writes below replace it, so a failed write leaves the artifact whole.
		if (existsSync(current)) {
			mkdirSync(join(root, existing.id, "versions"), { recursive: true });
			copyFileSync(current, versionPath(root, existing.id, existing.version));
			const payload = join(root, existing.id, "download.js");
			if (existsSync(payload)) copyFileSync(payload, join(root, existing.id, "versions", `v${existing.version}.js`));
		}
		meta = { ...existing, title, description, sourcePath, updatedAt: now, version: existing.version + 1 };
	} else {
		let id = `${slugify(title)}-${input.suffix()}`;
		while (existsSync(join(root, id))) id = `${slugify(title)}-${input.suffix()}`;
		meta = { id, title, description, sourcePath, project: input.project, createdAt: now, updatedAt: now, version: 1 };
	}

	writeTextAtomic(pagePath(root, meta.id), input.html);
	writeTextAtomic(join(root, meta.id, "download.js"), renderDownloadPayload(`${slugify(meta.title)}.html`, input.html));
	writeDetails(root, meta);
	return { meta, created: !existing };
}

/** Write an artifact's meta file and viewer page, then the gallery. */
function writeDetails(root: string, meta: ArtifactMeta): void {
	writeJsonAtomic(join(root, meta.id, "meta.json"), meta);
	writeTextAtomic(viewerPath(root, meta.id), renderViewer(meta, join(root, meta.id)));
	writeGallery(root);
}

/** Remove an artifact and every version of it. False when there was nothing to remove. */
export function deleteArtifact(root: string, id: string): boolean {
	if (!getArtifact(root, id)) return false;
	rmSync(join(root, id), { recursive: true, force: true });
	writeGallery(root);
	return true;
}

/** Rewrite the gallery page from the meta files. */
export function writeGallery(root: string): void {
	writeTextAtomic(galleryPath(root), renderGallery(listArtifacts(root)));
}

/** One artifact as a line of the tool's `list` output and the non-interactive /artifacts. */
export function listLine(root: string, meta: ArtifactMeta, home: string): string {
	const project = meta.project ? ` [${tildify(meta.project, home)}]` : "";
	return `- ${meta.id}: "${meta.title}" (v${meta.version}, updated ${meta.updatedAt.slice(0, 16).replace("T", " ")} UTC)${project}\n  ${fileUrl(viewerPath(root, meta.id))}`;
}

/**
 * Copy an artifact's current version to `<home>/Downloads` (`home` itself when
 * there is none) as `<slug>.html`, adding -2, -3 … rather than overwriting.
 * Returns the path written.
 */
export function exportArtifact(root: string, meta: ArtifactMeta, home: string): string {
	const downloads = join(home, "Downloads");
	const dir = existsSync(downloads) ? downloads : home;
	const base = slugify(meta.title);
	let target = join(dir, `${base}.html`);
	for (let n = 2; existsSync(target); n++) target = join(dir, `${base}-${n}.html`);
	copyFileSync(pagePath(root, meta.id), target);
	return target;
}
