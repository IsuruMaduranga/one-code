/**
 * skill extension — Claude Code's Skill tool.
 *
 * pi's own mechanism lists skills in the system prompt and expects the model to
 * `read` the SKILL.md path. Claude Code instead exposes a `skill` tool that
 * returns the skill's instructions as a tool result. This adds that tool, so a
 * skill can be invoked by name — including plugin skills as `<plugin>:<skill>`.
 *
 * Skills discovered by pi (which includes `~/.claude/skills` and
 * `.claude/skills` thanks to the claude-compat extension) are read from
 * `before_agent_start`'s systemPromptOptions rather than rediscovered here.
 */

import { readFileSync } from "node:fs";
import os from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { pluginRoot } from "../lib/plugin-root.ts";
import { defaultDiscoverRoots, discoverPlugins } from "../lib/plugins.ts";
import { CONTEXT_ORDER, REMINDER_CHANNEL } from "../lib/reminders.ts";
import {
	nextSkillState,
	readSkillStates,
	setSkillState,
	type SkillScope,
	type SkillState,
	skillListingVisibility,
	skillOverrideKey,
	skillStateFor,
} from "../lib/skill-overrides.ts";
import { estimateSkillTokens, scanSkills, scopeForPath } from "../lib/skill-scan.ts";
import { recordUsage } from "../lib/usage-tracker.ts";
import { boundedDockHeight, ccToolRenderers, safeThemeBold, safeThemePaint, truncateLine } from "../lib/tui-render.ts";
import { decodeSkillsKey } from "./panel/keys.ts";
import { renderSkillsPanel, type SkillsPaint } from "./panel/render.ts";
import { applySkillsKey, initialSkillsState, type SkillsRow, visibleRows } from "./panel/state.ts";

interface IndexedSkill {
	name: string;
	description?: string;
	path: string;
	source: "project" | "plugin";
	scope: SkillScope;
	state: SkillState;
	pluginName?: string;
}

/** Bounded dock like the /plugins panel — keeps the transcript visible above. */
const SKILLS_PANEL_MAX_HEIGHT = 24;

export default function skillExtension(pi: ExtensionAPI) {
	/** pi resolves skills per turn; cache the latest list for the tool to use. */
	let piSkills: IndexedSkill[] = [];
	/** Session cwd, so project-level enabledPlugins settings apply to plugin skills. */
	let sessionCwd: string | undefined;

	pi.on("before_agent_start", (event, ctx) => {
		sessionCwd = ctx.cwd;
		const skills = event.systemPromptOptions.skills ?? [];
		piSkills = skills.map((skill) => {
			const record = skill as unknown as { name: string; description?: string; path?: string; filePath?: string };
			const path = record.path ?? record.filePath ?? "";
			return {
				name: record.name,
				description: record.description,
				path,
				source: "project" as const,
				scope: scopeForPath(path, os.homedir(), getAgentDir()),
				state: "on" as const, // resolved per index() call below
			};
		});
		// Claude Code lists skills as a <system-reminder> on the first user message
		// (its block 3), framed for the Skill tool — not in the system prompt.
		const listing = describe();
		if (listing !== "(no skills available)") {
			pi.events.emit(REMINDER_CHANNEL, {
				text: `The following skills are available for use with the Skill tool:\n\n${listing}`,
				scope: "every-turn",
				key: "skills",
				placement: "first-prepend",
				order: CONTEXT_ORDER.skills,
			});
		}
	});

	/** Description first line from a SKILL.md, for skills pi hasn't resolved yet. */
	const readDescription = (path: string): string | undefined => {
		try {
			const { frontmatter } = parseFrontmatter(readFileSync(path, "utf-8")) as {
				frontmatter?: { description?: unknown };
			};
			return typeof frontmatter?.description === "string" ? frontmatter.description : undefined;
		} catch {
			return undefined;
		}
	};

	// Per-skill availability comes from the skill-overrides store (the /skills
	// panel cycles it, the /plugins panel manages plugin skills). The listing
	// and the tool both re-read it, so a change applies live.
	//
	// During a turn, project/user skills come from `piSkills` — pi already
	// resolved them for this turn (with descriptions), so no disk scan runs on
	// the per-turn listing path. Before the first turn `piSkills` is empty, so
	// the /skills command/panel falls back to a disk scan (reading each
	// SKILL.md's frontmatter for its description) — that's the gap that made a
	// fresh session's /skills show only plugin skills.
	const index = (cwd = sessionCwd): IndexedSkill[] => {
		const agentDir = getAgentDir();
		const home = os.homedir();
		const states = readSkillStates(pluginRoot(agentDir));
		const resolved = piSkills.filter((skill) => skill.path);
		const base =
			resolved.length > 0
				? resolved
				: scanSkills(cwd ?? process.cwd(), home, agentDir, []).map((skill) => ({
						name: skill.name,
						description: readDescription(skill.path),
						path: skill.path,
						source: "project" as const,
						scope: skill.scope,
						state: "on" as const,
					}));
		const project = base.map((skill) => ({
			...skill,
			state: skillStateFor(states, skillOverrideKey(skill.scope, skill.name)),
		}));
		// Plugin skills from discoverPlugins are already filtered to enabled by
		// the same store; anything it returns is fully available (plugin skills
		// aren't governed by skillOverrides — managed via /plugins).
		const plugin = discoverPlugins(defaultDiscoverRoots(agentDir, cwd, home)).skills.map((skill) => ({
			name: skill.name,
			path: skill.path,
			source: "plugin" as const,
			scope: "plugin" as const,
			state: "on" as const,
			pluginName: skill.plugin,
		}));
		return [...project, ...plugin];
	};

	// The model's listing honors the state: "on" carries name + description,
	// "name-only" carries just the name (saving context tokens), and "user-only"
	// / "off" are hidden so the model won't auto-trigger them.
	const listingText = (skills: IndexedSkill[]): string => {
		const lines = skills.flatMap((skill) => {
			const visibility = skillListingVisibility(skill.state);
			if (visibility === "hidden") return [];
			if (visibility === "name") return [`- ${skill.name}`];
			return [`- ${skill.name}${skill.description ? `: ${skill.description.split("\n")[0]}` : ""}`];
		});
		return lines.length === 0 ? "(no skills available)" : lines.join("\n");
	};
	const describe = () => listingText(index());

	pi.registerTool({
		name: "skill",
		label: "Skill",
		...ccToolRenderers<{ skill?: string; args?: string }>("Skill", {
			title: (a) => (a ? [a.skill, a.args].filter(Boolean).join(" ") : undefined),
			// The full instruction text goes to the model; the transcript needs one line.
			result: (_r, a, isError) => (isError ? undefined : a?.skill ? `Loaded ${a.skill}` : undefined),
		}),
		description:
			"Invoke a skill.\n\nA skill is a packaged set of instructions the user or project has set up for a particular kind of task (deploy steps, a review checklist, a repo-specific workflow). Available skills appear in a system-reminder listing with one-line descriptions. When the task at hand is one a listed skill covers, call this tool first — the skill's instructions load into the turn for you to follow in place of your default approach. Users may also ask for one by name (`/<name>`, or \"slash command\"); that's a request to invoke it.\n\n- `skill`: exact name from the listing, no leading slash. Plugin skills are named `<plugin>:<skill>`.\n- `args`: optional arguments to pass through.\n\nOnly names from the listing (or that the user typed explicitly) are valid. Built-in CLI commands (`/help`, `/clear`, …) aren't skills. Use `list` to see what is available.",
		promptSnippet: "Load packaged instructions for a task (see the skills listing)",
		parameters: Type.Object({
			skill: Type.Optional(Type.String({ description: "Exact skill name, no leading slash" })),
			args: Type.Optional(Type.String({ description: "Arguments to pass through to the skill" })),
			list: Type.Optional(Type.Boolean({ description: "List available skills instead of invoking one" })),
		}),
		async execute(_toolCallId, params) {
			// `list`, or a bare call with no invoke signal, browses the catalog. A
			// call that passed `args` but no `skill` is an invocation that forgot to
			// name the skill — fail loudly rather than silently returning the
			// catalog, which a weak model reads as a non-sequitur (same archetype as
			// the subagent tool; see docs/decisions/subagents-workflows.md).
			const all = index();
			if (params.list || (!params.skill && params.args == null)) {
				return {
					content: [{ type: "text", text: `Available skills:\n${listingText(all)}` }],
					details: { skills: all.map((s) => s.name) } as Record<string, unknown>,
				};
			}
			if (!params.skill) {
				return {
					content: [
						{
							type: "text",
							text: `No \`skill\` given, but you passed \`args\` — this looks like an invocation that forgot to name the skill. Set \`skill\` to one of the names below, or call with \`list: true\` to just browse.\n\nAvailable skills:\n${listingText(all)}`,
						},
					],
					details: {} as Record<string, unknown>,
					isError: true,
				};
			}

			const wanted = params.skill.replace(/^\//, "");
			// A bare name may match a plugin skill (`<plugin>:<name>`), but only
			// when exactly one plugin ships it — otherwise resolving silently would
			// run an arbitrary one, so ask which.
			const bareMatches = all.filter((skill) => skill.name.endsWith(`:${wanted}`));
			const found =
				all.find((skill) => skill.name === wanted) ??
				all.find((skill) => skill.name.toLowerCase() === wanted.toLowerCase()) ??
				(bareMatches.length === 1 ? bareMatches[0] : undefined);

			if (!found) {
				const ambiguous = bareMatches.length > 1;
				const text = ambiguous
					? `"${params.skill}" is ambiguous — it matches ${bareMatches.map((s) => s.name).join(", ")}. Use the full \`<plugin>:${wanted}\` name.`
					: `No skill named "${params.skill}".\n\nAvailable skills:\n${listingText(all)}`;
				return {
					content: [{ type: "text", text }],
					details: {} as Record<string, unknown>,
					isError: true,
				};
			}

			// "off" is the only state that refuses invocation (matching Claude Code,
			// where invoking an off skill by name returns the skillOverrides error).
			// "user-only" is invocable — it's just hidden from the model's listing,
			// so the model won't auto-trigger it, but /skill-name still runs it.
			if (found.state === "off") {
				const where = found.source === "plugin" ? "/plugins" : "/skills";
				return {
					content: [{ type: "text", text: `Skill "${found.name}" is turned off — the user can re-enable it from ${where}.` }],
					details: { skill: found.name, state: found.state } as Record<string, unknown>,
					isError: true,
				};
			}

			let body: string;
			try {
				const parsed = parseFrontmatter(readFileSync(found.path, "utf-8")) as { body: string };
				body = parsed.body.trim();
			} catch (error) {
				return {
					content: [{ type: "text", text: `Could not read skill "${found.name}": ${(error as Error).message}` }],
					details: {} as Record<string, unknown>,
					isError: true,
				};
			}

			recordUsage(pluginRoot(getAgentDir()), "skill", found.name);

			// Resource paths in a skill are relative to its own directory, so the
			// model needs to know where it lives to read references/ or scripts/.
			const header = [
				`Skill: ${found.name}`,
				`Location: ${found.path}`,
				params.args ? `Arguments: ${params.args}` : undefined,
				"Follow these instructions for the current task.",
			]
				.filter(Boolean)
				.join("\n");

			return {
				content: [{ type: "text", text: `${header}\n\n---\n\n${body}` }],
				details: { skill: found.name, path: found.path } as Record<string, unknown>,
			};
		},
	});

	const buildSkillsRows = (cwd: string | undefined): SkillsRow[] =>
		index(cwd).map((skill) => ({
			key: skillOverrideKey(skill.scope, skill.name),
			name: skill.name,
			scope: skill.scope,
			tokens: estimateSkillTokens(skill.path),
			state: skill.state,
			locked: skill.source === "plugin",
			pluginName: skill.pluginName,
		}));

	// The /skills panel: a bounded dock (like /plugins) that cycles each
	// project/user skill through on / name-only / user-only / off, persisting to
	// the skill-overrides store live. Plugin skills show locked (managed via
	// /plugins). Pure state/render live in ./panel; this owns repaint + writes.
	const openSkillsPanel = async (ctx: ExtensionContext): Promise<void> => {
		await ctx.ui.custom<null>((tui, theme, _keybindings, done) => {
			const paint: SkillsPaint = { fg: safeThemePaint(theme), bold: safeThemeBold(theme) };
			const state = initialSkillsState();
			let rows = buildSkillsRows(ctx.cwd);
			let notice: string | undefined;
			let cache: { width: number; lines: string[] } | undefined;
			const repaint = () => {
				cache = undefined;
				tui.requestRender();
			};
			return {
				render: (width: number) => {
					if (cache?.width === width) return cache.lines;
					const termRows = (tui as { terminal: { rows: number } }).terminal.rows;
					const height = boundedDockHeight(termRows, SKILLS_PANEL_MAX_HEIGHT);
					const lines = renderSkillsPanel({ state, rows, width, height, notice }, paint).map((line) =>
						truncateLine(line, width),
					);
					cache = { width, lines };
					return lines;
				},
				handleInput: (data: string) => {
					const key = decodeSkillsKey(data);
					if (!key) return;
					const before = visibleRows(rows, state);
					const anchorKey = before[state.cursor]?.key;
					const sortBefore = state.sort;
					const effect = applySkillsKey(state, key, before);
					notice = undefined;
					if (effect?.kind === "close") {
						done(null);
						return;
					}
					if (effect?.kind === "cycle") {
						// The toggle changes only the state; token/scope/name are stable,
						// so patch the one row instead of rescanning every skill from disk.
						const next = nextSkillState(effect.row.state);
						setSkillState(pluginRoot(getAgentDir()), effect.row.key, next);
						rows = rows.map((row) => (row.key === effect.row.key ? { ...row, state: next } : row));
					} else if (effect?.kind === "locked") {
						notice = `${effect.row.name} is a plugin skill — manage it from /plugins.`;
					}
					// A sort toggle reorders the list; keep the same skill selected so a
					// following Space acts on the row the user was looking at, not the one
					// that slid into its index.
					if (state.sort !== sortBefore && anchorKey) {
						const idx = visibleRows(rows, state).findIndex((row) => row.key === anchorKey);
						if (idx >= 0) state.cursor = idx;
					}
					repaint();
				},
				invalidate: () => {
					cache = undefined;
				},
			};
		});
	};

	pi.registerCommand("skills", {
		description: "View and manage skills (on / name-only / user-only / off)",
		handler: async (_args, ctx) => {
			if (ctx.hasUI) {
				await openSkillsPanel(ctx);
				return;
			}
			// Non-interactive fallback: a flat listing with each skill's state.
			const all = index(ctx.cwd);
			if (all.length === 0) {
				ctx.ui.notify("No skills available.", "info");
				return;
			}
			const lines = all.map((skill) => {
				const label = skill.source === "plugin" ? "plugin" : skill.state;
				const desc = skill.description ? `: ${skill.description.split("\n")[0]}` : "";
				return `- ${skill.name} [${label}]${desc}`;
			});
			ctx.ui.notify(`Skills:\n${lines.join("\n")}`, "info");
		},
	});
}
