/**
 * One Code's artifact text (the profile's `text.artifacts`): the artifact
 * tool's description, parameters and results, and the store's refusals.
 */

import { type ToolPassages, withoutOff } from "../live-tools.ts";
import type { ArtifactsText, NoBrowser, PublishBrowser, PublishProblem, ShownArtifact } from "../../extensions/artifacts/text.ts";

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

const ARTIFACT_DESCRIPTION = `Publish a self-contained HTML page as an artifact: a page saved on this machine under ~/.onecode/artifacts/ and opened in the user's default browser. Use it when a page would be clearer than terminal text (a report, a visual explainer, a comparison, a diagram), or when the user will use the page rather than only read it (a dashboard, a small tool, a game). Advice the user will act on right away in the code they are working on belongs in your reply, not in an artifact.

Before writing the page, load the \`artifact-design\` skill with the skill tool; it holds the page rules (title, both themes, phone-width layout, libraries). Write the page to one .html file (your scratchpad when there is one), then publish it with \`file_path\`. Keep it self-contained: inline the CSS and JS, load a library only as a pinned script from cdnjs.cloudflare.com or cdn.jsdelivr.net, fonts only from Google Fonts, and embed images as data: URIs. Only the one file is stored, so a relative link to another local file breaks.

Actions (\`action\`, publish when omitted):
- publish: stores \`file_path\` as a new artifact and opens it in the browser. Publishing the same file again updates that artifact in place as a new version; earlier versions are kept. To update an artifact from an earlier session, pass its \`id\` (from list). \`description\` is one sentence for the gallery; \`title\` is the fallback for a page with no <title>.
- list: the saved artifacts, newest first, with ids and links.
- open: shows an existing artifact (\`id\`) in the browser again, or the gallery of all artifacts when no id is given.
- delete: removes an artifact and all its versions, only when the user asks; the user confirms it.

The browser shows the page under a bar with Download, Copy file path, the earlier versions and a link to the gallery, so the page needs no download or navigation controls of its own. An update does not reopen the browser: tell the user to refresh the tab. When no browser can be opened (an SSH session, no display), give the user the link. The page is opened from a file: URL, so browser storage may be shared with other local pages or unavailable: wrap every localStorage read and write in try/catch and make the page work without it. There is no runtime API: the page cannot call Claude or keep shared state.

Never publish a page that impersonates a real person or organization, fabricated records presented as genuine, or a form that collects credentials or payment details.`;

const ARTIFACT_PASSAGES: ToolPassages = {
	skill: ["\n\nBefore writing the page, load the `artifact-design` skill with the skill tool; it holds the page rules (title, both themes, phone-width layout, libraries). Write the page to one .html file (your scratchpad when there is one), then publish it with `file_path`. Keep it self-contained: inline the CSS and JS, load a library only as a pinned script from cdnjs.cloudflare.com or cdn.jsdelivr.net, fonts only from Google Fonts, and embed images as data: URIs. Only the one file is stored, so a relative link to another local file breaks."],
};

export const artifacts: ArtifactsText = {
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
	description: ({ live }) => withoutOff(ARTIFACT_DESCRIPTION, live, ARTIFACT_PASSAGES),
	params: {
		action: "What to do. Defaults to publish.",
		filePath: "publish: the .html file to store.",
		title: "publish: the fallback title for a page with no <title>.",
		description: "publish: one sentence shown under the title in the gallery.",
		id: "The artifact to update (publish), open or delete: its id, or the file URL publish returned.",
		url: "Alias of `id` (Claude Code's name for it).",
		limit: "list: the maximum number of artifacts to return (default 25).",
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
