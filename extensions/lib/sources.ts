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
	/** The instruction files a user writes, in place of the base's (lib/instructions.ts `instructionTargets`). */
	instructionTargets?: InstructionTargets;
	/** The user and project config folders, in place of the product's own. Absent: the product's. */
	configDirs?: ConfigDirs;
	/**
	 * The settings ladder, lowest precedence first: gets the product's own
	 * files and returns the final list (lib/claude-settings.ts
	 * `settingsSources`). Every file in it joins the auto-mode safety floor.
	 * Absent: the product's files alone.
	 */
	settings?(base: SettingsFile[], opts: { cwd: string }): SettingsFile[];
	/** The skill folders besides pi's own, in load order: gets the base's (`.agents/skills`, user then project) and returns the final list (lib/skill-scan.ts). */
	skillDirs?(base: SkillDir[], opts: { cwd: string }): SkillDir[];
	/** Another tool's plugin install root, read only (lib/plugins.ts `DiscoverRoots`). */
	pluginsDir?: string;
	/** Another tool's MCP config files, read after pi's own `mcp.json` files, each with its scope (mcp/config.ts). */
	mcpFiles?(opts: { cwd: string }): McpFile[];
	/** Where a user adds servers in those files, for /mcp's empty message: ".mcp.json in the project, ~/.claude.json". */
	mcpWhere?: string;
	/**
	 * Another tool's global state files outside the settings ladder (One
	 * Code's provider: `~/.claude.json`). They carry permission configuration,
	 * so each joins the auto-mode safety floor; a first-run prompt the user
	 * answered there (the outside-read prompt) counts as answered.
	 */
	protectedFiles?: StateFile[];
}

/** Another tool's state file, and how /doctor names it. */
export interface StateFile {
	path: string;
	label: string;
}

/** A skill folder and the scope its skills load under. */
export interface SkillDir {
	dir: string;
	scope: "user" | "project";
}

/** An MCP config file: `user` for the user's own, `project` checked into the repository, `local` the user's for one project. */
export interface McpFile {
	path: string;
	scope: "user" | "project" | "local";
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
 * The instruction files a user writes: /memory's always-offered rows,
 * `/init`'s target, the auto-mode setup's evidence and the `# oneCodeMd`
 * preamble's name for the file above it.
 */
export interface InstructionTargets {
	/** The per-project file's name, in a project root. */
	project: string;
	/** The user's global file. */
	user: string;
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
	/** The user's switch for the provider, which /memory and /doctor show; absent, the provider is always on and no row shows. */
	switch?: SourceSwitch;
}

/**
 * The user's switch that turns a source provider off, leaving the base's own
 * locations: One Code's "Config sources" (Claude-compatible or independent).
 * It is fixed for the process; a change saved in /memory applies from the
 * next start.
 */
export interface SourceSwitch {
	/** The setting's name in /memory and /doctor: "Config sources". */
	title: string;
	/** Its key in the product's user settings file. */
	key: string;
	/** The environment variable that sets it for one run. */
	envVar: string;
	/** The two states: the value saved under `key`, the label, and what the product reads in it. */
	on: SwitchState;
	off: SwitchState;
	/** Whether the provider is on in this process. */
	running(): boolean;
	/** Whether it is on in the saved setting, for the next start. */
	saved(): boolean;
	/** Whether `envVar` sets it in this process. */
	fromEnv(): boolean;
	/** /doctor's line on what the provider reads in this process, for `home` and the process environment. */
	describe(opts: { home: string; env: Record<string, string | undefined> }): string;
	/** /doctor's warnings about what the provider would apply that the off state leaves out (an organisation policy file); none while on. */
	offWarnings?(opts: { home: string }): Array<{ text: string; fix: string }>;
}

export interface SwitchState {
	value: string;
	label: string;
	reads: string;
}

/** The profile's source switch, if its provider has one. */
export function sourceSwitch(): SourceSwitch | undefined {
	return sourceProvider()?.switch;
}

/** The switch's state for /doctor: its title, the running state's label, and what the provider reads. Undefined without a switch. */
export function sourceSwitchStatus(home: string, env: Record<string, string | undefined> = process.env): SwitchStatus | undefined {
	const sw = sourceSwitch();
	if (!sw) return undefined;
	return { title: sw.title, label: (sw.running() ? sw.on : sw.off).label, detail: sw.describe({ home, env }) };
}

export interface SwitchStatus {
	title: string;
	label: string;
	detail: string;
}

/** Whether the profile's provider is switched off in this process (One Code's independent mode). */
export function sourcesOff(): boolean {
	return sourceSwitch()?.running() === false;
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
