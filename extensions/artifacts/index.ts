/**
 * artifacts extension — Claude Code's Artifact tool, kept on this machine: the
 * model writes a self-contained HTML page, `artifact` stores it under
 * `~/.onecode/artifacts/` with every earlier version kept (store.ts) and opens
 * it in the user's browser. `/artifacts` browses, opens, exports and deletes
 * them. Deferred behind tool_search; the page rules are the bundled
 * `artifact-design` skill. Decision: `working-docs/decisions/tools.md`
 * ("Artifacts").
 */

import { feature } from "../lib/feature.ts";
import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import { StringEnum } from "../lib/string-enum.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readJsonFile } from "../lib/atomic-write.ts";
import { DEFER_CHANNEL } from "../lib/deferred.ts";
import { findProjectRoot } from "../lib/git.ts";
import { registerLocalCommand } from "../lib/local-command.ts";
import { oneCodeSettingsPath } from "../lib/one-code-settings.ts";
import { launchOpener, noDisplayReason, openerPlan } from "../lib/open-browser.ts";
import { tildify } from "../lib/paths.ts";
import { sanitizeDisplayText, terminalLink } from "../lib/terminal-text.ts";
import { resolveToolPath } from "../lib/tool-path.ts";
import { ccToolRenderers } from "../lib/tui-render.ts";
import { liveTools, requireText } from "../lib/profile.ts";
import type { ArtifactsText, NoBrowser, PublishBrowser, PublishProblem } from "./text.ts";
import {
	type ArtifactMeta,
	artifactsRoot,
	deleteArtifact,
	exportArtifact,
	fileUrl,
	galleryPath,
	getArtifact,
	listArtifacts,
	ArtifactNotFoundError,
	pagePath,
	publishArtifact,
	publishProblem,
	resolveArtifactRef,
	shownArtifact,
	viewerPath,
	writeGallery,
} from "./store.ts";

interface ArtifactArgs {
	action?: string;
	file_path?: string;
	id?: string;
	url?: string;
}

/** A publish result's details: what the renderer shows. */
interface PublishDetails {
	id: string;
	version: number;
	/** The viewer page. */
	path: string;
	created: boolean;
}

/** `artifacts.autoOpen` in ~/.onecode/settings.json; true unless set to false. */
function autoOpenEnabled(): boolean {
	const settings = readJsonFile<{ artifacts?: { autoOpen?: unknown } }>(oneCodeSettingsPath(homedir()));
	return settings?.artifacts?.autoOpen !== false;
}

/** Open a page the store built: why it was not opened, or undefined when it was. */
async function showInBrowser(path: string): Promise<NoBrowser | undefined> {
	const reason = noDisplayReason();
	if (reason) return reason;
	return (await launchOpener(openerPlan(fileUrl(path)))) ? undefined : "launchFailed";
}

/** The /artifacts status line after opening `path`. */
async function notifyOpened(ctx: ExtensionContext, path: string, name: string, text: ArtifactsText): Promise<void> {
	const failed = await showInBrowser(path);
	if (failed) ctx.ui.notify(`No browser was opened (${text.noBrowserReason(failed)}): ${path}`, "warning");
	else ctx.ui.notify(`Opened ${name}`, "info");
}

function textResult(text: string, details: object = {}, isError = false) {
	return { content: [{ type: "text" as const, text }], details, ...(isError ? { isError: true } : {}) };
}

/**
 * The title for a terminal menu or notice. Titles are sanitized when stored;
 * this also guards a meta.json edited by hand.
 */
function uiTitle(meta: ArtifactMeta): string {
	return sanitizeDisplayText(meta.title);
}

/** Ask the user before deleting `meta`; the tool and /artifacts share the wording. */
async function confirmDelete(ctx: ExtensionContext, meta: ArtifactMeta, signal?: AbortSignal): Promise<boolean> {
	const versions = meta.version === 1 ? "its only version" : `all ${meta.version} versions`;
	const approved = await ctx.ui.confirm(`Delete the artifact "${uiTitle(meta)}"?`, `This permanently removes ${meta.id} and ${versions}.`, { signal });
	return approved === true && !signal?.aborted;
}

function artifactsExtension(pi: ExtensionAPI) {
	const text = requireText("artifacts");
	pi.registerTool({
		name: "artifact",
		label: "Artifact",
		// Claude Code's shape: `Artifact(page.html)` over `⎿ Published <link>`.
		...ccToolRenderers<ArtifactArgs, PublishDetails>("Artifact", {
			title: (args) => {
				const action = args?.action ?? "publish";
				if (action === "publish") return args?.file_path ? basename(args.file_path) : action;
				const target = args?.id ?? args?.url;
				return target ? `${action} ${target}` : action;
			},
			result: (result, _args, isError) => {
				const details = result.details;
				if (isError || !details?.path) return undefined;
				return details.created ? "Published" : `Updated to version ${details.version}`;
			},
			// The short path, clickable where the terminal renders OSC 8 links.
			link: (result, isError) => {
				const path = result.details?.path;
				if (isError || !path) return undefined;
				return terminalLink(tildify(path, homedir()), fileUrl(path));
			},
		}),
		description: text.description({ live: liveTools }),
		parameters: Type.Object({
			action: Type.Optional(StringEnum(["publish", "list", "open", "delete"] as const, { description: text.params.action })),
			file_path: Type.Optional(Type.String({ description: text.params.filePath })),
			title: Type.Optional(Type.String({ description: text.params.title })),
			description: Type.Optional(Type.String({ description: text.params.description })),
			id: Type.Optional(Type.String({ description: text.params.id })),
			url: Type.Optional(Type.String({ description: text.params.url })),
			limit: Type.Optional(Type.Number({ description: text.params.limit })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const root = artifactsRoot();
			const action = params.action ?? "publish";
			const ref = params.id ?? params.url;
			const resolved = ref === undefined ? undefined : resolveArtifactRef(root, ref);
			if (ref !== undefined && !resolved) {
				return textResult(text.noMatch({ ref }), {}, true);
			}

			if (action === "list") {
				const all = listArtifacts(root);
				if (all.length === 0) return textResult(text.emptyList);
				const limit = Math.max(1, Math.floor(params.limit ?? 25));
				const shown = all.slice(0, limit).map((meta) => shownArtifact(root, meta, homedir()));
				return textResult(text.list({ total: all.length, shown, galleryUrl: fileUrl(galleryPath(root)) }));
			}

			if (action === "open") {
				if (!resolved) {
					writeGallery(root);
					return textResult(text.openedGallery({ url: fileUrl(galleryPath(root)), failed: await showInBrowser(galleryPath(root)) }));
				}
				return textResult(text.opened({ url: fileUrl(viewerPath(root, resolved)), failed: await showInBrowser(viewerPath(root, resolved)) }));
			}

			if (action === "delete") {
				if (!resolved) return textResult(text.deleteNeedsId, {}, true);
				const meta = getArtifact(root, resolved);
				if (!meta) return textResult(text.unknownForDelete({ id: resolved }), {}, true);
				if (!ctx.hasUI) return textResult(text.deleteNeedsUser, {}, true);
				const approved = await confirmDelete(ctx, meta, signal);
				if (signal?.aborted) return textResult(text.deleteAborted, {}, true);
				if (!approved) return textResult(text.deleteDeclined, {}, true);
				deleteArtifact(root, resolved);
				return textResult(text.deleted({ id: meta.id, title: meta.title }));
			}

			const refuse = (problem: PublishProblem) => textResult(text.publishProblem(problem), {}, true);
			if (!params.file_path) return refuse({ kind: "noPath" });
			const sourcePath = resolveToolPath(params.file_path, ctx.cwd);
			let bytes: number;
			try {
				const stat = statSync(sourcePath);
				if (!stat.isFile()) return refuse({ kind: "notFile", path: sourcePath });
				bytes = stat.size;
			} catch {
				return refuse({ kind: "missing", path: sourcePath });
			}
			const problem = publishProblem(root, sourcePath, bytes);
			if (problem) return refuse(problem);

			let result: ReturnType<typeof publishArtifact>;
			try {
				result = publishArtifact(root, {
					sourcePath,
					html: readFileSync(sourcePath, "utf-8"),
					title: params.title,
					description: params.description,
					project: findProjectRoot(ctx.cwd) ?? ctx.cwd,
					id: resolved,
					now: new Date(),
					suffix: () => randomBytes(3).toString("hex"),
				});
			} catch (error) {
				return refuse(error instanceof ArtifactNotFoundError ? { kind: "unknownId", id: error.id } : { kind: "failed", osMessage: (error as Error).message });
			}
			const { meta, created } = result;
			const viewer = viewerPath(root, meta.id);
			const url = fileUrl(viewer);
			const browser: PublishBrowser = !created
				? { kind: "notReopened" }
				: !autoOpenEnabled()
					? { kind: "autoOpenOff", settingsPath: tildify(oneCodeSettingsPath(homedir()), homedir()) }
					: { kind: "tried", failed: await showInBrowser(viewer) };
			const details: PublishDetails = { id: meta.id, version: meta.version, path: viewer, created };
			return textResult(
				text.published({ id: meta.id, title: meta.title, version: meta.version, created, url, file: pagePath(root, meta.id), galleryUrl: fileUrl(galleryPath(root)), browser }),
				details,
			);
		},
	});

	pi.events.emit(DEFER_CHANNEL, { name: "artifact", keywords: ["artifact", "html", "page", "browser", "report", "dashboard", "visualize", "publish"] });

	registerLocalCommand(pi, "artifacts", {
		description: "Browse, open, export or delete saved artifacts",
		handler: async (_args: string, ctx: ExtensionContext) => {
			const root = artifactsRoot();
			const all = listArtifacts(root);
			if (!ctx.hasUI) {
				ctx.ui.notify(all.length ? all.map((meta) => text.listLine(shownArtifact(root, meta, homedir()))).join("\n") : text.emptyList, "info");
				return;
			}
			const GALLERY = "Open the gallery in the browser";
			const labels = new Map<string, ArtifactMeta>();
			for (const meta of all) labels.set(`${uiTitle(meta)}  (v${meta.version}, ${meta.id})`, meta);
			const picked = await ctx.ui.select(all.length ? `${all.length} artifact${all.length === 1 ? "" : "s"}` : "No artifacts yet", [GALLERY, ...labels.keys()]);
			if (!picked) return;
			if (picked === GALLERY) {
				writeGallery(root);
				await notifyOpened(ctx, galleryPath(root), "the artifact gallery", text);
				return;
			}
			const meta = labels.get(picked);
			if (!meta) return;
			const OPEN = "Open in the browser";
			const EXPORT = "Save a copy to Downloads";
			const PATH = "Show the file path";
			const DELETE = "Delete";
			const choice = await ctx.ui.select(uiTitle(meta), [OPEN, EXPORT, PATH, DELETE]);
			if (choice === OPEN) {
				await notifyOpened(ctx, viewerPath(root, meta.id), uiTitle(meta), text);
			} else if (choice === EXPORT) {
				try {
					ctx.ui.notify(`Saved ${tildify(exportArtifact(root, meta, homedir()), homedir())}`, "info");
				} catch (error) {
					ctx.ui.notify(`Could not save a copy: ${(error as Error).message}`, "error");
				}
			} else if (choice === PATH) {
				ctx.ui.notify(pagePath(root, meta.id), "info");
			} else if (choice === DELETE) {
				if (await confirmDelete(ctx, meta)) {
					deleteArtifact(root, meta.id);
					ctx.ui.notify(`Deleted ${uiTitle(meta)}`, "info");
				}
			}
		},
	});
}

export default feature("artifacts", artifactsExtension);
