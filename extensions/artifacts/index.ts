/**
 * artifacts extension — Claude Code's Artifact tool, kept on this machine: the
 * model writes a self-contained HTML page, `artifact` stores it under
 * `~/.onecode/artifacts/` with every earlier version kept (store.ts) and opens
 * it in the user's browser. `/artifacts` browses, opens, exports and deletes
 * them. Deferred behind tool_search; the page rules are the bundled
 * `artifact-design` skill. Decision: `working-docs/decisions/tools.md`
 * ("Artifacts").
 */

import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
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
import {
	type ArtifactMeta,
	artifactsRoot,
	deleteArtifact,
	exportArtifact,
	fileUrl,
	galleryPath,
	getArtifact,
	listArtifacts,
	listLine,
	pagePath,
	publishArtifact,
	publishProblem,
	resolveArtifactRef,
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

const DESCRIPTION = `Publish a self-contained HTML page as an artifact: a page saved on this machine under ~/.onecode/artifacts/ and opened in the user's default browser. Use it when a page would be clearer than terminal text (a report, a visual explainer, a comparison, a diagram), or when the user will use the page rather than only read it (a dashboard, a small tool, a game). Advice the user will act on right away in the code they are working on belongs in your reply, not in an artifact.

Before writing the page, load the \`artifact-design\` skill with the skill tool; it holds the page rules (title, both themes, phone-width layout, libraries). Write the page to one .html file (your scratchpad when there is one), then publish it with \`file_path\`. Keep it self-contained: inline the CSS and JS, load a library only as a pinned script from cdnjs.cloudflare.com or cdn.jsdelivr.net, fonts only from Google Fonts, and embed images as data: URIs. Only the one file is stored, so a relative link to another local file breaks.

Actions (\`action\`, publish when omitted):
- publish: stores \`file_path\` as a new artifact and opens it in the browser. Publishing the same file again updates that artifact in place as a new version; earlier versions are kept. To update an artifact from an earlier session, pass its \`id\` (from list). \`description\` is one sentence for the gallery; \`title\` is the fallback for a page with no <title>.
- list: the saved artifacts, newest first, with ids and links.
- open: shows an existing artifact (\`id\`) in the browser again, or the gallery of all artifacts when no id is given.
- delete: removes an artifact and all its versions, only when the user asks; the user confirms it.

The browser shows the page under a bar with Download, Copy file path, the earlier versions and a link to the gallery, so the page needs no download or navigation controls of its own. An update does not reopen the browser: tell the user to refresh the tab. When no browser can be opened (an SSH session, no display), give the user the link. The page is opened from a file: URL, so browser storage may be shared with other local pages or unavailable: wrap every localStorage read and write in try/catch and make the page work without it. There is no runtime API: the page cannot call Claude or keep shared state.

Never publish a page that impersonates a real person or organization, fabricated records presented as genuine, or a form that collects credentials or payment details.`;

/** `artifacts.autoOpen` in ~/.onecode/settings.json; true unless set to false. */
function autoOpenEnabled(): boolean {
	const settings = readJsonFile<{ artifacts?: { autoOpen?: unknown } }>(oneCodeSettingsPath(homedir()));
	return settings?.artifacts?.autoOpen !== false;
}

/** Open a page the store built: why it was not opened, or undefined when it was. */
async function showInBrowser(path: string): Promise<string | undefined> {
	const reason = noDisplayReason();
	if (reason) return reason;
	return (await launchOpener(openerPlan(fileUrl(path)))) ? undefined : "the browser could not be started";
}

/** The tool result's line about the browser. */
async function browserNote(path: string): Promise<string> {
	const failed = await showInBrowser(path);
	return failed ? `No browser was opened: ${failed}. Give the user the link.` : "Opened it in the user's default browser.";
}

/** The /artifacts status line after opening `path`. */
async function notifyOpened(ctx: ExtensionContext, path: string, name: string): Promise<void> {
	const failed = await showInBrowser(path);
	if (failed) ctx.ui.notify(`No browser was opened (${failed}): ${path}`, "warning");
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

export default function artifactsExtension(pi: ExtensionAPI) {
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
		description: DESCRIPTION,
		parameters: Type.Object({
			action: Type.Optional(StringEnum(["publish", "list", "open", "delete"] as const, { description: "What to do. Defaults to publish." })),
			file_path: Type.Optional(Type.String({ description: "publish: the .html file to store." })),
			title: Type.Optional(Type.String({ description: "publish: the fallback title for a page with no <title>." })),
			description: Type.Optional(Type.String({ description: "publish: one sentence shown under the title in the gallery." })),
			id: Type.Optional(Type.String({ description: "The artifact to update (publish), open or delete: its id, or the file URL publish returned." })),
			url: Type.Optional(Type.String({ description: "Alias of `id` (Claude Code's name for it)." })),
			limit: Type.Optional(Type.Number({ description: "list: the maximum number of artifacts to return (default 25)." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const root = artifactsRoot();
			const action = params.action ?? "publish";
			const ref = params.id ?? params.url;
			const resolved = ref === undefined ? undefined : resolveArtifactRef(root, ref);
			if (ref !== undefined && !resolved) {
				return textResult(`No artifact matches "${ref}". Run the artifact tool with action "list" to see the ids.`, {}, true);
			}

			if (action === "list") {
				const all = listArtifacts(root);
				if (all.length === 0) return textResult("No artifacts yet.");
				const limit = Math.max(1, Math.floor(params.limit ?? 25));
				const shown = all.slice(0, limit);
				const more = all.length > shown.length ? `\n(${all.length - shown.length} more not shown; raise \`limit\` to see them.)` : "";
				return textResult(`${all.length} artifact${all.length === 1 ? "" : "s"}, newest first:\n${shown.map((meta) => listLine(root, meta, homedir())).join("\n")}${more}\nGallery: ${fileUrl(galleryPath(root))}`);
			}

			if (action === "open") {
				if (!resolved) {
					writeGallery(root);
					return textResult(`Gallery: ${fileUrl(galleryPath(root))}\n${await browserNote(galleryPath(root))}`);
				}
				return textResult(`${fileUrl(viewerPath(root, resolved))}\n${await browserNote(viewerPath(root, resolved))}`);
			}

			if (action === "delete") {
				if (!resolved) return textResult("Pass the `id` of the artifact to delete.", {}, true);
				const meta = getArtifact(root, resolved);
				if (!meta) return textResult(`No artifact has the id "${resolved}".`, {}, true);
				if (!ctx.hasUI) {
					return textResult("Deleting an artifact needs the user's confirmation, and this session cannot ask. Tell the user to delete it with /artifacts.", {}, true);
				}
				const approved = await confirmDelete(ctx, meta, signal);
				if (signal?.aborted) return textResult("The operation was aborted; the artifact was not deleted.", {}, true);
				if (!approved) return textResult("The user declined; the artifact was not deleted.", {}, true);
				deleteArtifact(root, resolved);
				return textResult(`Deleted the artifact ${meta.id} ("${meta.title}").`);
			}

			if (!params.file_path) return textResult("`file_path` is required: the .html file to publish.", {}, true);
			const sourcePath = resolveToolPath(params.file_path, ctx.cwd);
			let bytes: number;
			try {
				const stat = statSync(sourcePath);
				if (!stat.isFile()) return textResult(`${sourcePath} is not a file. Pass the path of the .html page to publish.`, {}, true);
				bytes = stat.size;
			} catch {
				return textResult(`${sourcePath} does not exist. Write the page to that path first, then publish it.`, {}, true);
			}
			const problem = publishProblem(root, sourcePath, bytes);
			if (problem) return textResult(problem, {}, true);

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
				return textResult(`Publishing failed: ${(error as Error).message}`, {}, true);
			}
			const { meta, created } = result;
			const viewer = viewerPath(root, meta.id);
			const url = fileUrl(viewer);
			const lines = [
				created
					? `Published "${meta.title}" as the artifact ${meta.id}.`
					: `Updated the artifact ${meta.id} ("${meta.title}") to version ${meta.version}; earlier versions are kept.`,
				`Link: ${url}`,
				`File: ${pagePath(root, meta.id)}`,
			];
			if (!created) lines.push("The browser was not reopened: tell the user to refresh the tab that shows it.");
			else if (!autoOpenEnabled()) lines.push(`Opening the browser is off (artifacts.autoOpen is false in ${tildify(oneCodeSettingsPath(homedir()), homedir())}). Give the user the link.`);
			else lines.push(await browserNote(viewer));
			lines.push(`Gallery of all artifacts: ${fileUrl(galleryPath(root))}`);
			const details: PublishDetails = { id: meta.id, version: meta.version, path: viewer, created };
			return textResult(lines.join("\n"), details);
		},
	});

	pi.events.emit(DEFER_CHANNEL, { name: "artifact", keywords: ["artifact", "html", "page", "browser", "report", "dashboard", "visualize", "publish"] });

	registerLocalCommand(pi, "artifacts", {
		description: "Browse, open, export or delete saved artifacts",
		handler: async (_args: string, ctx: ExtensionContext) => {
			const root = artifactsRoot();
			const all = listArtifacts(root);
			if (!ctx.hasUI) {
				ctx.ui.notify(all.length ? all.map((meta) => listLine(root, meta, homedir())).join("\n") : "No artifacts yet.", "info");
				return;
			}
			const GALLERY = "Open the gallery in the browser";
			const labels = new Map<string, ArtifactMeta>();
			for (const meta of all) labels.set(`${uiTitle(meta)}  (v${meta.version}, ${meta.id})`, meta);
			const picked = await ctx.ui.select(all.length ? `${all.length} artifact${all.length === 1 ? "" : "s"}` : "No artifacts yet", [GALLERY, ...labels.keys()]);
			if (!picked) return;
			if (picked === GALLERY) {
				writeGallery(root);
				await notifyOpened(ctx, galleryPath(root), "the artifact gallery");
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
				await notifyOpened(ctx, viewerPath(root, meta.id), uiTitle(meta));
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
