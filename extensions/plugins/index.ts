/**
 * plugins extension — Claude Code plugin support.
 *
 * Reads `~/.claude/plugins/installed_plugins.json`, then publishes each
 * plugin's resources so the other extensions can use them:
 *
 *   agents/      → the subagent tool, as `<plugin>:<agent>`
 *   skills/      → the skill tool, as `<plugin>:<skill>`
 *   commands/    → slash commands, as `/<plugin>:<command>`
 *   .mcp.json    → the MCP client
 *
 * Everything is namespaced the way Claude Code namespaces it, so two plugins can
 * both ship a `commit` command. This extension only owns the slash commands and
 * the `/plugins` listing; the other consumers call `discoverPlugins()` for
 * themselves, because module state is not shared between extension files.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverPlugins, type Plugin } from "../lib/plugins.ts";
import { findShellPlaceholders, replaceShellPlaceholders, substituteArguments } from "./template.ts";

const run = promisify(execFile);
const SHELL_TIMEOUT_MS = 30_000;

async function expandTemplate(body: string, args: string, cwd: string): Promise<string> {
	const withArgs = substituteArguments(body, args);
	const commands = [...new Set(findShellPlaceholders(withArgs))];
	if (commands.length === 0) return withArgs;

	const outputs = new Map<string, string>();
	await Promise.all(
		commands.map(async (command) => {
			try {
				const { stdout, stderr } = await run(command, {
					cwd,
					shell: true,
					timeout: SHELL_TIMEOUT_MS,
					maxBuffer: 2 * 1024 * 1024,
				});
				outputs.set(command, (stdout || stderr || "").trim());
			} catch (error) {
				const detail = error as { stdout?: string; stderr?: string; message?: string };
				outputs.set(command, (detail.stdout || detail.stderr || detail.message || "command failed").trim());
			}
		}),
	);
	return replaceShellPlaceholders(withArgs, outputs);
}

export default function pluginsExtension(pi: ExtensionAPI) {
	const claudeDir = join(os.homedir(), ".claude");
	const discovered = discoverPlugins(claudeDir);

	for (const command of discovered.commands) {
		const plugin = discovered.plugins.find((p) => p.name === command.plugin);
		if (plugin) registerPluginCommand(pi, plugin, command.name, command.path);
	}

	pi.registerCommand("plugins", {
		description: "List installed Claude Code plugins and what they contribute",
		handler: async (_args, ctx) => {
			if (discovered.plugins.length === 0) {
				ctx.ui.notify("No Claude Code plugins installed (~/.claude/plugins/installed_plugins.json).", "info");
				return;
			}
			const lines = discovered.plugins.map((plugin) => {
				const summary = discovered.byPlugin.get(plugin.name);
				const parts: string[] = [];
				if (summary?.agents) parts.push("agents");
				if (summary?.skills) parts.push(`${summary.skills} skill${summary.skills === 1 ? "" : "s"}`);
				if (summary?.commands) parts.push(`${summary.commands} command${summary.commands === 1 ? "" : "s"}`);
				if (summary?.mcp) parts.push("mcp");
				return `${plugin.name}${plugin.version && plugin.version !== "unknown" ? ` ${plugin.version}` : ""} — ${parts.join(", ") || "nothing usable"}`;
			});
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

function registerPluginCommand(pi: ExtensionAPI, plugin: Plugin, name: string, path: string): void {
	let description = `Command from the ${plugin.name} plugin`;
	let argumentHint: string | undefined;
	try {
		const { frontmatter } = parseFrontmatter(readFileSync(path, "utf-8")) as {
			frontmatter?: Record<string, unknown>;
		};
		if (typeof frontmatter?.description === "string") description = frontmatter.description;
		if (typeof frontmatter?.["argument-hint"] === "string") argumentHint = frontmatter["argument-hint"];
	} catch {
		// Fall back to the generic description.
	}

	pi.registerCommand(name, {
		description: argumentHint ? `${description} (${argumentHint})` : description,
		handler: async (args, ctx) => {
			let body: string;
			try {
				const parsed = parseFrontmatter(readFileSync(path, "utf-8")) as { body: string };
				body = parsed.body;
			} catch (error) {
				ctx.ui.notify(`Could not read ${path}: ${(error as Error).message}`, "error");
				return;
			}
			const expanded = await expandTemplate(body, args, ctx.cwd);
			// Deliver as a user turn, which is how Claude Code runs a command template.
			pi.sendUserMessage(expanded);
		},
	});
}
