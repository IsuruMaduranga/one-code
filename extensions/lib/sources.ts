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

import os from "node:os";
import { join } from "node:path";
import type { InstructionView } from "./instructions.ts";
import { oneCodeStateDir } from "./paths.ts";
import { sourceProvider } from "./profile.ts";

/** One session's view of the provider's sources. */
export interface SourceView {
	/** Whether the base may read `path` at all: an instruction file, an import. Absent: every path. */
	allowPath?(path: string): boolean;
	/** The product's instruction files, reshaping the base's lists (lib/instructions.ts). Absent: the base's lists. */
	instructions?: InstructionView;
	/** The user and project config folders, in place of the product's own. Absent: the product's. */
	configDirs?: ConfigDirs;
	/**
	 * The settings ladder, lowest precedence first: gets the product's own
	 * files and returns the final list (lib/claude-settings.ts
	 * `settingsSources`). Every file in it joins the auto-mode safety floor.
	 * Absent: the product's files alone.
	 */
	settings?(base: SettingsFile[], opts: { cwd: string }): SettingsFile[];
}

/**
 * One settings file of the ladder, by role rather than by the tool it
 * belongs to. The precedence logic stays in the base; each consumer keeps
 * the files its keys may come from by these fields.
 */
export interface SettingsFile {
	path: string;
	/**
	 * `user`: the user's own, for every project. `project`: checked into the
	 * repository. `local`: the user's, for one project (another tool's sits in
	 * the checkout; the product's in its state dir). `managed`: organisation
	 * policy, highest authority.
	 */
	scope: "user" | "project" | "local" | "managed";
	/** `product`: the harness's own file, which it may write. `borrowed`: another tool's, never written. */
	owner: "product" | "borrowed";
	/**
	 * The user file holding the keys a user edits by hand (`defaultMode`, MCP
	 * approvals, hooks, `env`). The base marks the product's user file when
	 * the list has none.
	 */
	primary?: boolean;
	/** How the file is named to the user, such as "managed settings". */
	label: string;
}

/**
 * Where agents, commands, workflows, `loop.md`, the memory folder and
 * worktrees live: `user` is a folder, `project` the folder's name inside a
 * project root. The project name reaches the model in tool descriptions, so
 * it must hold for the whole process.
 */
export interface ConfigDirs {
	user: string;
	project: string;
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

/** The config folders for `home`: the provider's, else the product's own state dir and `.onecode`. */
export function configDirs(home: string = os.homedir()): ConfigDirs {
	return openSources(home).configDirs ?? { user: oneCodeStateDir(process.env, home), project: ".onecode" };
}

/** The user-level config folder (agents, commands, workflows, the memory folder). */
export function userConfigDir(home: string): string {
	return configDirs(home).user;
}

/** The project-level config folder's name. */
export function projectConfigDirName(): string {
	return configDirs().project;
}

/** The project-level counterpart of `userConfigDir`: `<cwd>/<project config folder>`. */
export function projectConfigDir(cwd: string): string {
	return join(cwd, projectConfigDirName());
}

/** `view.allowPath`, or every path when the view sets none. */
export function allowPathOf(view: SourceView): (path: string) => boolean {
	return view.allowPath ? (path) => view.allowPath!(path) : () => true;
}
