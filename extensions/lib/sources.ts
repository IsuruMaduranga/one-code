/**
 * Where a product reads beyond the base's own locations: the profile's source
 * provider (decisions/bi-fork.md, "Claude Code compatibility is One Code's
 * profile code", "The provider's shape"). The provider opens one view per
 * session; every part of it is optional, and the base keeps its own list for
 * any part a view leaves out. One Code's provider adds Claude Code's files,
 * and with its config mode set to independent it opens a view that only keeps
 * Claude Code's locations out.
 *
 * Pure: no pi imports. The provider module is named by path in the profile
 * and loaded on first use (lib/profile.ts `sourceProvider`).
 */

import type { InstructionView } from "./instructions.ts";
import { sourceProvider } from "./profile.ts";

/** One session's view of the provider's sources. */
export interface SourceView {
	/** Whether the base may read `path` at all: an instruction file, an import. Absent: every path. */
	allowPath?(path: string): boolean;
	/** The product's instruction files, reshaping the base's lists (lib/instructions.ts). Absent: the base's lists. */
	instructions?: InstructionView;
}

/** A profile's source provider: the module `Profile.sources` names exports one as `sources`. */
export interface SourceProvider {
	/** A view for the settings in force now; a session keeps one from its startup block to its next refresh. */
	open(opts: { home: string }): SourceView;
}

/** The active profile's view for `home`, or the base's own (an empty view) when it has no provider. */
export function openSources(home: string): SourceView {
	return sourceProvider()?.open({ home }) ?? {};
}

/** `view.allowPath`, or every path when the view sets none. */
export function allowPathOf(view: SourceView): (path: string) => boolean {
	return view.allowPath ? (path) => view.allowPath!(path) : () => true;
}
