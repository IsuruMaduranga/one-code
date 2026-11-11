/**
 * One Code's artifact text (the profile's `text.artifacts`): the artifact
 * tool's description, parameters and results, and the store's refusals.
 */

import { type ToolPassages, withoutOff } from "../../../extensions/sdk/profile.ts";
import type { ArtifactsText, LiveTools } from "../../../extensions/sdk/profile.ts";

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

/** The group, for the tools this session can have (`live`): text naming a tool that is off leaves it out. */
export const artifactsText = (live: LiveTools): ArtifactsText => ({
	description: withoutOff(ARTIFACT_DESCRIPTION, live, ARTIFACT_PASSAGES),
	params: {
		action: "What to do. Defaults to publish.",
		filePath: "publish: the .html file to store.",
		title: "publish: the fallback title for a page with no <title>.",
		description: "publish: one sentence shown under the title in the gallery.",
		id: "The artifact to update (publish), open or delete: its id, or the file URL publish returned.",
		url: "Alias of `id` (Claude Code's name for it).",
		limit: "list: the maximum number of artifacts to return (default 25).",
	},
});
