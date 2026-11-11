/**
 * The artifact tool's words. The extension decides what happened. The
 * profile words the tool itself (`ArtifactsText`: description, parameters);
 * its results and refusals are here (`artifactsResultText`). The store's
 * rules (the 16 MB cap, the .html extension, versions) reach the words as
 * values.
 */


/** Why no browser opened: an SSH session, no graphical display, or the opener failed. */
export type NoBrowser = "ssh" | "noDisplay" | "launchFailed";

/** Why a page was not published. */
export type PublishProblem =
	| { kind: "noPath" }
	| { kind: "missing"; path: string }
	| { kind: "notFile"; path: string }
	| { kind: "notHtml"; path: string }
	/** The page is one of the store's own files. */
	| { kind: "insideStore"; path: string }
	| { kind: "empty"; path: string }
	| { kind: "tooLarge"; path: string; bytes: number; maxBytes: number }
	/** The id to update names no artifact (it went away after it was resolved). */
	| { kind: "unknownId"; id: string }
	/** The store failed; `osMessage` is the system's message. */
	| { kind: "failed"; osMessage: string };

/** One artifact as a list shows it. */
export interface ShownArtifact {
	id: string;
	title: string;
	version: number;
	/** Its last update, `YYYY-MM-DD HH:MM` in UTC. */
	updated: string;
	/** Its project, tildified. */
	project?: string;
	/** The viewer page's file: URL. */
	url: string;
}

/** What the publish result says about the browser. */
export type PublishBrowser =
	/** An update: the tab that shows it needs a refresh. */
	| { kind: "notReopened" }
	/** `artifacts.autoOpen` is false in the settings file at `settingsPath`. */
	| { kind: "autoOpenOff"; settingsPath: string }
	| { kind: "tried"; failed?: NoBrowser };

/** Another session holds the store, or changed it under this call. */
export type StoreBusy =
	| { kind: "creating" }
	| { kind: "publishing"; id: string }
	| { kind: "deletedWhilePublishing"; id: string }
	| { kind: "takenOver"; id: string }
	| { kind: "deleting"; id: string };

export interface ArtifactsText {
	description: string;
	params: { action: string; filePath: string; title: string; description: string; id: string; url: string; limit: string };
}

/** The group's results, refusals and notes, which the base words (`artifactsResultText`). */
export interface ArtifactsResultText {
	/** Thrown by the store; the tool reports it as the failure's own message. */
	storeBusy(busy: StoreBusy): string;
	/** An `id` or `url` that names no artifact. */
	noMatch(p: { ref: string }): string;
	emptyList: string;
	listLine(artifact: ShownArtifact): string;
	list(p: { total: number; shown: ShownArtifact[]; galleryUrl: string }): string;
	/** Why no browser opened, as a clause; also in the /artifacts notice. */
	noBrowserReason(reason: NoBrowser): string;
	/** `open` without an id: the gallery; `failed` when no browser opened. */
	openedGallery(p: { url: string; failed?: NoBrowser }): string;
	/** `open` with an id; `failed` when no browser opened. */
	opened(p: { url: string; failed?: NoBrowser }): string;
	deleteNeedsId: string;
	unknownForDelete(p: { id: string }): string;
	/** A one-shot run cannot ask the user to confirm a delete. */
	deleteNeedsUser: string;
	deleteAborted: string;
	deleteDeclined: string;
	deleted(p: { id: string; title: string }): string;
	publishProblem(problem: PublishProblem): string;
	published(p: { id: string; title: string; version: number; created: boolean; url: string; file: string; galleryUrl: string; browser: PublishBrowser }): string;
}

const NO_BROWSER: Record<NoBrowser, string> = {
	ssh: "this session runs over SSH",
	noDisplay: "no graphical display is available",
	launchFailed: "the browser could not be started",
};

const browserNote = ({ failed }: { failed?: NoBrowser }) =>
	failed ? `No browser was opened: ${NO_BROWSER[failed]}. Give the user the link.` : "Opened it in the user's default browser.";

function publishProblem(problem: PublishProblem): string {
	switch (problem.kind) {
		case "noPath":
			return "`file_path` is required: the .html file to publish.";
		case "missing":
			return `${problem.path} does not exist. Write the page to that path first, then publish it.`;
		case "notFile":
			return `${problem.path} is not a file. Pass the path of the .html page to publish.`;
		case "notHtml":
			return `${problem.path} is not an .html file. Write the page as a single self-contained .html file (inline CSS and JS) and publish that.`;
		case "insideStore":
			return `${problem.path} is inside the artifact store. Edit a copy in your scratchpad or the project and publish that copy, passing the artifact's id to update it in place.`;
		case "empty":
			return `${problem.path} is empty. Write the page first, then publish it.`;
		case "tooLarge":
			return `${problem.path} is ${(problem.bytes / 1024 / 1024).toFixed(1)} MB; an artifact is at most ${problem.maxBytes / 1024 / 1024} MB. Move large data or media out of the page, or shrink it.`;
		case "unknownId":
			return `Publishing failed: No artifact has the id "${problem.id}". Run the artifact tool with action "list" to see the ids.`;
		case "failed":
			return `Publishing failed: ${problem.osMessage}`;
	}
}

function browserLine(browser: PublishBrowser): string {
	switch (browser.kind) {
		case "notReopened":
			return "The browser was not reopened: tell the user to refresh the tab that shows it.";
		case "autoOpenOff":
			return `Opening the browser is off (artifacts.autoOpen is false in ${browser.settingsPath}). Give the user the link.`;
		case "tried":
			return browserNote(browser);
	}
}

const listLine = (a: ShownArtifact) => `- ${a.id}: "${a.title}" (v${a.version}, updated ${a.updated} UTC)${a.project ? ` [${a.project}]` : ""}\n  ${a.url}`;

/** The base's words of the group. */
export const artifactsResultText: ArtifactsResultText = {
	storeBusy: (busy) => {
		switch (busy.kind) {
			case "creating":
				return "Another session is creating an artifact. Publish again in a moment.";
			case "publishing":
				return `Another session is publishing the artifact "${busy.id}". Publish again in a moment.`;
			case "deletedWhilePublishing":
				return `The artifact "${busy.id}" was deleted while this publish ran. Publish again to create a new one.`;
			case "takenOver":
				return `Another session took over publishing the artifact "${busy.id}". Publish again.`;
			case "deleting":
				return `Another session is publishing the artifact "${busy.id}". Delete it again in a moment.`;
		}
	},
	noMatch: ({ ref }) => `No artifact matches "${ref}". Run the artifact tool with action "list" to see the ids.`,
	emptyList: "No artifacts yet.",
	listLine,
	list: ({ total, shown, galleryUrl }) => {
		const more = total > shown.length ? `\n(${total - shown.length} more not shown; raise \`limit\` to see them.)` : "";
		return `${total} artifact${total === 1 ? "" : "s"}, newest first:\n${shown.map(listLine).join("\n")}${more}\nGallery: ${galleryUrl}`;
	},
	noBrowserReason: (reason) => NO_BROWSER[reason],
	openedGallery: ({ url, failed }) => `Gallery: ${url}\n${browserNote({ failed })}`,
	opened: ({ url, failed }) => `${url}\n${browserNote({ failed })}`,
	deleteNeedsId: "Pass the `id` of the artifact to delete.",
	unknownForDelete: ({ id }) => `No artifact has the id "${id}".`,
	deleteNeedsUser: "Deleting an artifact needs the user's confirmation, and this session cannot ask. Tell the user to delete it with /artifacts.",
	deleteAborted: "The operation was aborted; the artifact was not deleted.",
	deleteDeclined: "The user declined; the artifact was not deleted.",
	deleted: ({ id, title }) => `Deleted the artifact ${id} ("${title}").`,
	publishProblem,
	published: ({ id, title, version, created, url, file, galleryUrl, browser }) =>
		[
			created ? `Published "${title}" as the artifact ${id}.` : `Updated the artifact ${id} ("${title}") to version ${version}; earlier versions are kept.`,
			`Link: ${url}`,
			`File: ${file}`,
			browserLine(browser),
			`Gallery of all artifacts: ${galleryUrl}`,
		].join("\n"),
};
