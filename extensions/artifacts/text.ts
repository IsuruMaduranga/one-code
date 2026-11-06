/**
 * What the artifacts extension needs from a profile (types only). The
 * extension decides what happened; the profile words it
 * (working-docs/features/profiles/). The store's rules (the 16 MB cap, the
 * .html extension, versions) stay in the base and reach the words as values.
 */

import type { LiveTools } from "../lib/live-tools.ts";

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
	/** Thrown by the store; the tool reports it as the failure's own message. */
	storeBusy(busy: StoreBusy): string;
	description(p: { live: LiveTools }): string;
	params: { action: string; filePath: string; title: string; description: string; id: string; url: string; limit: string };
	/** An `id` or `url` that names no artifact. */
	noMatch(p: { ref: string }): string;
	emptyList: string;
	listLine(artifact: ShownArtifact): string;
	list(p: { total: number; shown: ShownArtifact[]; galleryUrl: string }): string;
	/** Why no browser opened, as a clause; also in the /artifacts notice. */
	noBrowserReason(reason: NoBrowser): string;
	/** The line about the browser after opening something; `failed` when none opened. */
	browserNote(p: { failed?: NoBrowser }): string;
	/** `open` without an id: the gallery. */
	openedGallery(p: { url: string; browserNote: string }): string;
	opened(p: { url: string; browserNote: string }): string;
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
