/**
 * skill extension — Claude Code's Skill tool.
 *
 * pi's own mechanism lists skills in the system prompt and expects the model to
 * `read` the SKILL.md path. Claude Code instead exposes a `skill` tool, which
 * answers "Launching skill: <name>" with the skill's instructions beside it.
 * This adds that tool, so a skill can be invoked by name — including plugin
 * skills as `<plugin>:<skill>` — and expands a skill the user types into its
 * instructions before the model sees the message, as Claude Code does.
 *
 * Skills discovered by pi (which includes `~/.claude/skills` and
 * `.claude/skills` thanks to the claude-compat extension) are read from
 * `before_agent_start`'s systemPromptOptions rather than rediscovered here.
 */

import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { notifyOrPrint } from "../lib/headless-output.ts";
import { pluginRoot } from "../lib/plugin-root.ts";
import { defaultDiscoverRoots, discoverPlugins } from "../lib/plugins.ts";
import { awaitOneShotTurn } from "../lib/notifications.ts";
import { PROMPT_OPTIONS_CHANNEL, type PromptOptionsAnnouncement } from "../lib/prompt-options.ts";
import { CONTEXT_ORDER, REMINDER_CHANNEL } from "../lib/reminders.ts";
import {
	nextSkillState,
	readSkillStates,
	setSkillState,
	type SkillScope,
	type SkillState,
	skillOverrideKey,
	skillStateFor,
} from "../lib/skill-overrides.ts";
import { BUNDLED_SKILLS_DIR, estimateSkillTokens, promptTemplateNames, scanSkills, scopeForPath } from "../lib/skill-scan.ts";
import { resolveModelTier } from "../lib/model-tier.ts";
import { readUsage, recordUsage, usageKey } from "../lib/usage-tracker.ts";
import { boundedDockHeight, ccToolRenderers, safeThemeBold, safeThemePaint, truncateLine } from "../lib/tui-render.ts";
import {
	bareSkillMatches,
	launchingSkill,
	missingArgumentsNote,
	parseSkillCommand,
	redactOffSkillMessages,
	resolveSkill,
	SKILL_INVOCATION_TYPE,
	type SkillInvocationDetails,
	skillCommandCandidates,
	skillPromptText,
	typedSkillContent,
	withoutDuplicateSkillCommands,
} from "./invoke.ts";
import { codeReviewBody } from "./code-review.ts";
import { decodeSkillsKey } from "./panel/keys.ts";
import { frontmatterFlag, skillListingBudget, skillListingText, usageScore } from "./listing.ts";
import { renderSkillsPanel, type SkillsPaint } from "./panel/render.ts";
import { applySkillsKey, initialSkillsState, type SkillsRow, visibleRows } from "./panel/state.ts";
import { announceArgumentHint, type CommandHint, frontmatterCommandHint } from "../lib/argument-hints.ts";
import { parseSlashCommand, SKILL_BODY_CHANNEL, type SkillBodyQuery, SLASH_EXPAND_CHANNEL, type SlashExpandQuery } from "../lib/skill-body.ts";
import { parseFrontmatterLoosely } from "../lib/frontmatter.ts";
import { registerLocalCommand } from "../lib/local-command.ts";

interface IndexedSkill {
	name: string;
	description?: string;
	path: string;
	source: "project" | "plugin";
	scope: SkillScope;
	state: SkillState;
	pluginName?: string;
	/** The `when_to_use` frontmatter, which Claude Code lists after the description. */
	whenToUse?: string;
	/**
	 * A plugin command (`<plugin>:<command>`): listed for the model and
	 * loadable through the tool, as in Claude Code; typed, it stays the
	 * plugins extension's command.
	 */
	kind?: "command";
	/**
	 * Frontmatter `disable-model-invocation: true`: only the user starts it (a
	 * typed `/<name>`); it is left out of the model's listing and the `skill`
	 * tool refuses it, as Claude Code's Skill tool does.
	 */
	disableModelInvocation?: boolean;
}


/** Bounded dock like the /plugins panel — keeps the transcript visible above. */
const SKILLS_PANEL_MAX_HEIGHT = 24;

const BUNDLED_ROOT = resolve(BUNDLED_SKILLS_DIR);
/** A skill in One Code's own catalog, like one built into Claude Code: listed last, kept whole over budget, no folder named. */
const isBundled = (path: string): boolean => resolve(path).startsWith(BUNDLED_ROOT + sep);
const CODE_REVIEW_PATH = join(BUNDLED_ROOT, "code-review", "SKILL.md");
const CODE_REVIEW_CELLS = join(BUNDLED_ROOT, "code-review", "cells");

export default function skillExtension(pi: ExtensionAPI) {
	/** pi resolves skills per turn; cache the latest list for the tool to use. */
	let piSkills: IndexedSkill[] = [];
	/** Session cwd, so project-level enabledPlugins settings apply to plugin skills. */
	let sessionCwd: string | undefined;
	/** The session's model: its context window sizes the listing, its tier picks code-review's body. */
	let sessionModel: Model<Api> | undefined;

	/**
	 * True once a `prompt()` has run (the only path that emits
	 * before_agent_start). Until then an idle skill delivery goes out as a user
	 * message: pi's `sendMessage(…, {triggerTurn})` skips that preamble, so a
	 * session opening with `/loop …` or `/simplify` ran its first request
	 * without our system prompt or reminder stack (lib/notifications.ts,
	 * "First turn of a session"; upstream_prs.md #17). Later turns get the
	 * prompt from system-prompt's context_with_system handler (idle-turn.ts).
	 */
	let prompted = false;

	// A factory re-run builds each session's instance, so this is belt and braces
	// (lib/notifications.ts resets its twin the same way).
	pi.on("session_start", (_event, ctx) => {
		prompted = false;
		announcedSkills = false;
		sessionUsage = undefined;
		sessionModel = ctx.model;
	});
	pi.on("model_select", (event) => {
		sessionModel = event.model;
	});
	/** Index the skills pi resolved for this turn and list them for the model. */
	const adoptPiSkills = (skills: unknown[], cwd: string) => {
		sessionCwd = cwd;
		piSkills = skills.map((skill) => {
			const record = skill as unknown as { name: string; description?: string; path?: string; filePath?: string; disableModelInvocation?: boolean };
			const path = record.path ?? record.filePath ?? "";
			return {
				name: record.name,
				description: record.description,
				path,
				source: "project" as const,
				scope: scopeForPath(path, os.homedir(), getAgentDir()),
				state: "on" as const, // resolved per index() call below
				// pi reads only a YAML `true`; Claude Code also takes the string "true".
				disableModelInvocation: record.disableModelInvocation === true || (path ? readModelInvocationDisabled(path) : false),
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
	};
	pi.on("before_agent_start", (event, ctx) => {
		prompted = true;
		sessionModel = ctx.model ?? sessionModel;
		adoptPiSkills(event.systemPromptOptions.skills ?? [], ctx.cwd);
	});
	// The first turn a background completion opens (lib/prompt-options.ts)
	// carries the same listing a typed first prompt would.
	// The first announcement wins, as in system-prompt: both describe one turn.
	let announcedSkills = false;
	pi.events.on(PROMPT_OPTIONS_CHANNEL, (data) => {
		const announced = data as PromptOptionsAnnouncement | undefined;
		const skills = (announced?.options as { skills?: unknown[] } | undefined)?.skills;
		if (prompted || announcedSkills || !announced?.cwd || !Array.isArray(skills)) return;
		announcedSkills = true;
		adoptPiSkills(skills, announced.cwd);
	});

	/**
	 * Description from a SKILL.md frontmatter, for skills pi hasn't resolved (the
	 * pre-first-turn scan) and for plugin skills (discoverPlugins carries none).
	 * Cached per path: the listing is rebuilt every turn and a description is
	 * stable for the session anyway (the listing must stay byte-stable for the
	 * cache prefix).
	 */
	const frontmatterCache = new Map<string, Record<string, unknown> | undefined>();
	/** A SKILL.md's frontmatter, read once per path: the description and the argument hint come from it. */
	const readFrontmatter = (path: string): Record<string, unknown> | undefined => {
		if (frontmatterCache.has(path)) return frontmatterCache.get(path);
		let frontmatter: Record<string, unknown> | undefined;
		try {
			frontmatter = parseFrontmatterLoosely(readFileSync(path, "utf-8")).frontmatter;
		} catch {
			frontmatter = undefined;
		}
		frontmatterCache.set(path, frontmatter);
		return frontmatter;
	};
	const readDescription = (path: string): string | undefined => {
		const description = readFrontmatter(path)?.description;
		return typeof description === "string" ? description : undefined;
	};
	const readWhenToUse = (path: string): string | undefined => {
		const whenToUse = readFrontmatter(path)?.when_to_use;
		return typeof whenToUse === "string" && whenToUse.trim() ? whenToUse : undefined;
	};

	/**
	 * A SKILL.md's `disable-model-invocation` flag, read apart from the
	 * description cache and again whenever the file changes: a flag added
	 * mid-session must stop the model loading the skill, while the listing's
	 * descriptions stay byte-stable.
	 */
	const invocationFlagCache = new Map<string, { mtimeMs: number; disabled: boolean }>();
	const readModelInvocationDisabled = (path: string): boolean => {
		let mtimeMs = -1;
		try {
			mtimeMs = statSync(path).mtimeMs;
		} catch {
			// Unreadable: parsed (and failed) below, cached under -1.
		}
		const cached = invocationFlagCache.get(path);
		if (cached && cached.mtimeMs === mtimeMs) return cached.disabled;
		let disabled = false;
		try {
			disabled = frontmatterFlag(parseFrontmatterLoosely(readFileSync(path, "utf-8")).frontmatter?.["disable-model-invocation"]);
		} catch {
			// No file, no flag.
		}
		invocationFlagCache.set(path, { mtimeMs, disabled });
		return disabled;
	};

	/** A SKILL.md's `argument-hint`, the prompt's placeholder after its command (lib/argument-hints.ts). */
	const readArgumentHint = (path: string): CommandHint | undefined => frontmatterCommandHint(readFrontmatter(path));

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
	//
	// The order is Claude Code's: project and user skills, then plugin commands
	// and plugin skills, then the bundled catalog.
	/** Every listable entry; `withCommands: false` leaves out plugin commands (and their frontmatter reads). */
	const index = (cwd = sessionCwd, withCommands = true): IndexedSkill[] => {
		const agentDir = getAgentDir();
		const home = os.homedir();
		const states = readSkillStates(pluginRoot(agentDir));
		const resolved = piSkills.filter((skill) => skill.path);
		const base =
			resolved.length > 0
				? resolved
				: scanSkills(cwd ?? process.cwd(), home, agentDir, [], BUNDLED_SKILLS_DIR).map((skill) => ({
						name: skill.name,
						description: readDescription(skill.path),
						path: skill.path,
						source: "project" as const,
						scope: skill.scope,
						state: "on" as const,
						disableModelInvocation: readModelInvocationDisabled(skill.path),
					}));
		const project = base.map((skill) => ({
			...skill,
			whenToUse: readWhenToUse(skill.path),
			state: skillStateFor(states, skillOverrideKey(skill.scope, skill.name)),
		}));
		// Plugin skills from discoverPlugins are already filtered to enabled by
		// the same store; anything it returns is fully available (plugin skills
		// aren't governed by skillOverrides — managed via /plugins).
		const discovered = discoverPlugins(defaultDiscoverRoots(agentDir, cwd, home));
		const plugin = discovered.skills.map((skill) => ({
			name: skill.name,
			description: readDescription(skill.path),
			whenToUse: readWhenToUse(skill.path),
			path: skill.path,
			source: "plugin" as const,
			scope: "plugin" as const,
			state: "on" as const,
			pluginName: skill.plugin,
			disableModelInvocation: readModelInvocationDisabled(skill.path),
		}));
		// A plugin command is listed when it describes itself, as in Claude Code.
		const commands = !withCommands ? [] : discovered.commands.flatMap((command) => {
			const description = readDescription(command.path);
			const whenToUse = readWhenToUse(command.path);
			if (!description?.trim() && !whenToUse) return [];
			return [
				{
					name: command.name,
					description,
					whenToUse,
					path: command.path,
					source: "plugin" as const,
					scope: "plugin" as const,
					state: "on" as const,
					pluginName: command.plugin,
					kind: "command" as const,
					disableModelInvocation: readModelInvocationDisabled(command.path),
				},
			];
		});
		return [...project.filter((skill) => !isBundled(skill.path)), ...commands, ...plugin, ...project.filter((skill) => isBundled(skill.path))];
	};
	/** Skills proper: the /skills panel and the typed forms leave plugin commands to the plugins extension. */
	const skillsOnly = (cwd = sessionCwd): IndexedSkill[] => index(cwd, false);

	/**
	 * Usage as the session found it: read once, so the listing's ranking (and
	 * with it message 1 of the cached prefix) does not move when a skill is
	 * used mid-session or a day's decay crosses a threshold.
	 */
	let sessionUsage: { usage: ReturnType<typeof readUsage>; now: Date } | undefined;

	/** The listing, within Claude Code's budget for the session model's context window. */
	const describe = () => {
		sessionUsage ??= { usage: readUsage(pluginRoot(getAgentDir())), now: new Date() };
		const { usage, now } = sessionUsage;
		const skills = index().map((skill) => ({
			...skill,
			bundled: isBundled(skill.path),
			usage: usageScore(usage[usageKey(skill.kind ?? "skill", skill.name)], now),
		}));
		return skillListingText(skills, skillListingBudget(sessionModel?.contextWindow));
	};

	pi.registerTool({
		name: "skill",
		label: "Skill",
		...ccToolRenderers<{ skill?: string; args?: string }>("Skill", {
			title: (a) => (a ? [a.skill, a.args].filter(Boolean).join(" ") : undefined),
			// The skill's text goes to the model; the transcript needs one line.
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
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// `list`, or a bare call with no invoke signal, browses the catalog. A
			// call that passed `args` but no `skill` is an invocation that forgot to
			// name the skill — fail loudly rather than silently returning the
			// catalog, which a weak model reads as a non-sequitur (same archetype as
			// the subagent tool; see working-docs/decisions/subagents-workflows.md).
			const all = index();
			if (params.list || (!params.skill && params.args == null)) {
				return {
					content: [{ type: "text", text: `Available skills:\n${skillListingText(all)}` }],
					details: { skills: all.map((s) => s.name) } as Record<string, unknown>,
				};
			}
			if (!params.skill) {
				return {
					content: [
						{
							type: "text",
							text: `No \`skill\` given, but you passed \`args\` — this looks like an invocation that forgot to name the skill. Set \`skill\` to one of the names below, or call with \`list: true\` to just browse.\n\nAvailable skills:\n${skillListingText(all)}`,
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
			const bareMatches = bareSkillMatches(all, wanted);
			const found = resolveSkill(all, wanted);

			if (!found) {
				const ambiguous = bareMatches.length > 1;
				const text = ambiguous
					? `"${params.skill}" is ambiguous — it matches ${bareMatches.map((s) => s.name).join(", ")}. Use the full \`<plugin>:${wanted}\` name.`
					: `No skill named "${params.skill}".\n\nAvailable skills:\n${skillListingText(all)}`;
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

			// Only the user may start a skill marked `disable-model-invocation`
			// (a typed `/<name>` runs through deliverSkill, not this tool).
			if (found.disableModelInvocation) {
				return {
					content: [{ type: "text", text: `Skill ${wanted} cannot be used with Skill tool due to disable-model-invocation` }],
					details: { skill: found.name } as Record<string, unknown>,
					isError: true,
				};
			}

			let promptText: string;
			try {
				const parsed = parseFrontmatterLoosely(readFileSync(found.path, "utf-8")) as { body: string };
				const { body, args } = skillBody(found, parsed.body.trim(), params.args?.trim() ?? "", ctx.cwd, ctx.model);
				promptText = skillPromptText(body, args, baseDirFor(found));
			} catch (error) {
				return {
					content: [{ type: "text", text: `Could not read skill "${found.name}": ${(error as Error).message}` }],
					details: {} as Record<string, unknown>,
					isError: true,
				};
			}

			recordUsage(pluginRoot(getAgentDir()), found.kind ?? "skill", found.name);

			// A skill that takes arguments, called without any, returns its
			// no-argument body; say so, since a model previewing the skill would
			// otherwise follow it (invoke.ts missingArgumentsNote).
			const hint = params.args?.trim() ? undefined : readArgumentHint(found.path);
			const hintText = hint?.hint ?? hint?.argNames?.map((name) => `<${name}>`).join(" ");
			const note = hintText ? missingArgumentsNote(hintText) : undefined;

			// Claude Code's shape: the result says the skill is launching, and its
			// text follows as a block of its own.
			return {
				content: [
					{ type: "text", text: launchingSkill(found.name) },
					{ type: "text", text: note ? `${note.before}\n\n${promptText}\n\n${note.after}` : promptText },
				],
				details: { skill: found.name, path: found.path } as Record<string, unknown>,
			};
		},
	});

	/**
	 * A skill's body and the arguments still to append: a generated body
	 * (lib/skill-body.ts, `/loop`) carries its arguments, a file's does not.
	 * The bundled code-review picks its body by tier and effort (code-review.ts).
	 */
	const skillBody = (found: IndexedSkill, fileBody: string, args: string, cwd: string, model = sessionModel): { body: string; args: string } => {
		if (found.kind === "command") return { body: fileBody, args };
		if (resolve(found.path) === CODE_REVIEW_PATH) {
			try {
				const review = codeReviewBody(CODE_REVIEW_CELLS, resolveModelTier(model), pi.getThinkingLevel(), args);
				return { body: review.body, args: review.args };
			} catch {
				// A cell file missing from an install: the SKILL.md body (the medium cell) still reviews.
			}
		}
		const query: SkillBodyQuery = { skill: found.name, path: found.path, args, cwd };
		pi.events.emit(SKILL_BODY_CHANNEL, query);
		return query.body !== undefined ? { body: query.body, args: "" } : { body: fileBody, args };
	};
	/** The folder Claude Code names before a skill's text; none for One Code's own catalog. */
	const baseDirFor = (found: IndexedSkill): string | undefined => (found.kind === "command" || isBundled(found.path) ? undefined : dirname(found.path));

	// A fired scheduled prompt that is a skill's slash command runs that skill,
	// as Claude Code's queue runs a fired `/babysit-prs` (lib/skill-body.ts).
	pi.events.on(SLASH_EXPAND_CHANNEL, (data) => {
		const query = data as SlashExpandQuery;
		const command = parseSlashCommand(query.text);
		if (!command) return;
		const found = resolveSkill(skillsOnly(query.cwd), command.name.replace(/^skill:/, ""));
		if (!found || found.state === "off") return;
		let fileBody: string;
		try {
			fileBody = stripFrontmatter(readFileSync(found.path, "utf-8")).trim();
		} catch {
			return;
		}
		recordUsage(pluginRoot(getAgentDir()), "skill", found.name);
		const { body, args } = skillBody(found, fileBody, command.args, query.cwd);
		query.expanded = typedSkillContent(found.name, command.args, skillPromptText(body, args, baseDirFor(found))).join("");
	});

	/**
	 * Run a resolved skill the way a user-typed command does: refuse an "off"
	 * skill (in EVERY mode — falling through would hand `/skill:` to pi's native
	 * expansion, which knows nothing of the overrides store and would run it; a
	 * one-shot run gets the refusal on stderr instead of a UI notice, never as
	 * silent execution), else deliver Claude Code's typed-skill message (the
	 * command breadcrumb and the skill's text) as a hidden custom message: the
	 * model receives it as a user message (convertToLlm maps a custom message
	 * to one regardless of `display`), but nothing renders and no `skill` call
	 * is needed. Shared by the `/skill:<name>` interception, the typed
	 * `/<plugin>:<skill>` form and the bare `/<name>` commands.
	 */
	const deliverSkill = async (
		found: IndexedSkill,
		args: string,
		ctx: ExtensionContext & { waitForIdle?: () => Promise<void> },
		extra: { images?: Array<{ type: "image"; data: string; mimeType: string }>; streamingBehavior?: "steer" | "followUp"; input?: string } = {},
	): Promise<"handled" | "unavailable"> => {
		if (found.state === "off") {
			const where = found.source === "plugin" ? "/plugins" : "/skills";
			notifyOrPrint(ctx, `Skill "${found.name}" is turned off — enable it from ${where} to run it.`, "warning");
			return "handled";
		}
		let fileBody: string;
		try {
			fileBody = stripFrontmatter(readFileSync(found.path, "utf-8")).trim();
		} catch {
			return "unavailable";
		}
		recordUsage(pluginRoot(getAgentDir()), "skill", found.name);
		const { body, args: bodyArgs } = skillBody(found, fileBody, args, ctx.cwd, ctx.model);
		// Claude Code's typed-skill message: the command breadcrumb, then the
		// skill's text; any attached images ride after them.
		const [breadcrumb, text] = typedSkillContent(found.name, args, skillPromptText(body, bodyArgs, baseDirFor(found)));
		const content = [{ type: "text" as const, text: breadcrumb }, { type: "text" as const, text }, ...(extra.images ?? [])];
		if (!prompted && !extra.streamingBehavior) {
			pi.sendUserMessage(content);
			await awaitOneShotTurn(ctx);
			return "handled";
		}
		pi.sendMessage(
			{
				customType: SKILL_INVOCATION_TYPE,
				content,
				display: false,
				details: { skill: found.name, args, ...(extra.input !== undefined ? { input: extra.input } : {}) } satisfies SkillInvocationDetails,
			},
			{ triggerTurn: true, ...(extra.streamingBehavior ? { deliverAs: extra.streamingBehavior } : {}) },
		);
		// The turn we just triggered rides a fire-and-forget pi.sendMessage. In a
		// one-shot run (-p, --mode json) pi disposes the session the moment this
		// command/input handler returns, so without blocking the process would exit
		// before that turn ran — the skill would load with no agent response (issue
		// #1; real Claude Code runs the turn). Block until it settles there.
		await awaitOneShotTurn(ctx);
		return "handled";
	};

	// A user-typed `/skill:<name>` normally runs pi's own expansion, which submits
	// the skill's `<skill>` block as a *user message* — so loading a skill shows in
	// the transcript as a new user turn. Intercept it here, suppress pi's
	// expansion (return "handled"), and deliver through deliverSkill. An unknown
	// name, an ambiguous plugin match, or an unreadable file falls through to
	// pi's native handling. Since pi 0.86.0 (faa9863cb) this also runs for a
	// message queued mid-turn and for RPC steer/followUp (`streamingBehavior` is
	// set), so an off skill is refused before it enters the queue. On older pi
	// those paths skip `input`; the context-hook redaction below covers them.
	//
	// A typed `/<plugin>:<skill>` has no command of its own (plugin skills get
	// no bare alias), so it reached the model as text and the model called
	// `skill`; it is expanded here too, as Claude Code expands it. Only an exact
	// plugin-skill name is taken; anything else stays the user's text.
	pi.on("input", async (event, ctx) => {
		const typed = parseSkillCommand(event.text);
		const plugin = typed ? undefined : typedPluginSkill(event.text);
		const cmd = typed ?? plugin?.command;
		if (!cmd) return { action: "continue" };
		const found = plugin?.skill ?? resolveSkill(skillsOnly(), cmd.name);
		if (!found) return { action: "continue" };
		const outcome = await deliverSkill(found, cmd.args, ctx, {
			images: event.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined,
			streamingBehavior: event.streamingBehavior,
			input: event.text,
		});
		return { action: outcome === "handled" ? "handled" : "continue" };
	});

	/** A typed `/<plugin>:<skill> [args]` naming a plugin skill exactly, and that skill. */
	const typedPluginSkill = (text: string): { command: { name: string; args: string }; skill: IndexedSkill } | undefined => {
		if (!text.startsWith("/")) return undefined;
		const command = parseSlashCommand(text);
		if (!command?.name.includes(":")) return undefined;
		const skill = skillsOnly().find((candidate) => candidate.source === "plugin" && candidate.name === command.name);
		return skill ? { command, skill } : undefined;
	};

	// Claude Code invokes a user/project skill as a bare `/<name>` (only plugin
	// skills carry a `<plugin>:` prefix); pi registers `/skill:<name>`. Register
	// each project/user/bundled skill as a bare extension command too, so
	// `/simplify` works and autocompletes. pi runs extension commands before the
	// `input` hook and before its own `/skill:`/template expansion — in prompt(),
	// so interactive, `-p` and RPC alike — and emits session_start before it
	// builds the autocomplete list, so aliases registered here are listed. A name
	// another command already owns is skipped (pi would rename BOTH to `name:1`/
	// `name:2`), as are pi's built-ins (matched by literal text before extensions
	// see them) and `.claude/commands` templates (pi resolves those per turn,
	// AFTER session_start, so they are pre-scanned from disk here — otherwise a
	// bare skill command would shadow a same-named template for the whole
	// session); those skills keep only their `/skill:` form. Commands can never
	// be unregistered, so the handler resolves the skill afresh at invocation:
	// a skill deleted or turned off since registration is refused, never run.
	const registeredSkillCommands = new Set<string>();
	const registerSkillCommands = (cwd: string | undefined, skills: IndexedSkill[] = skillsOnly(cwd)) => {
		let taken: string[];
		try {
			taken = pi.getCommands().map((command) => command.name);
		} catch {
			return; // not bound yet (load time) — session_start retries
		}
		const templates = promptTemplateNames(cwd ?? process.cwd(), os.homedir(), getAgentDir());
		for (const skill of skillCommandCandidates(skills, [...taken, ...templates, ...registeredSkillCommands])) {
			registeredSkillCommands.add(skill.name);
			const hint = readArgumentHint(skill.path);
			if (hint) announceArgumentHint(pi, skill.name, hint);
			pi.registerCommand(skill.name, {
				description: skill.description ? `${skill.description} (skill)` : `Run the ${skill.name} skill`,
				handler: async (args, ctx) => {
					const found = resolveSkill(skillsOnly(ctx.cwd), skill.name);
					if (!found || (await deliverSkill(found, args.trim(), ctx)) === "unavailable") {
						notifyOrPrint(ctx, `Skill "${skill.name}" is no longer available (its SKILL.md was removed or is unreadable).`, "error");
					}
				},
			});
		}
	};
	pi.on("session_start", (_event, ctx) => {
		const skills = skillsOnly(ctx.cwd);
		registerSkillCommands(ctx.cwd, skills);
		// pi lists every skill a second time as `/skill:<name>`; drop that entry
		// where the bare command exists (withoutDuplicateSkillCommands).
		if (ctx.hasUI && ctx.mode === "tui") {
			ctx.ui.addAutocompleteProvider((current) => ({
				...current,
				getSuggestions: async (lines, cursorLine, cursorCol, options) => {
					const suggestions = await current.getSuggestions(lines, cursorLine, cursorCol, options);
					if (!suggestions) return suggestions;
					const items = withoutDuplicateSkillCommands(suggestions.items, suggestions.prefix, registeredSkillCommands);
					return items.length > 0 ? { ...suggestions, items } : null;
				},
				applyCompletion: (...args) => current.applyCompletion(...args),
				...(current.shouldTriggerFileCompletion ? { shouldTriggerFileCompletion: (...args) => current.shouldTriggerFileCompletion!(...args) } : {}),
			}));
		}
		// pi's own `/skill:<name>` form, which pi lists only after the first turn.
		for (const skill of skills) {
			const hint = skill.source === "plugin" ? undefined : readArgumentHint(skill.path);
			if (hint) announceArgumentHint(pi, `skill:${skill.name}`, hint);
		}
	});
	// pi's per-turn resolution (frontmatter `name`, description required) can
	// surface skills the pre-turn disk scan missed; late registrations still
	// execute (autocomplete lists them after a /reload). Gated on an unseen
	// name so the steady state costs one Set lookup per skill per turn, not a
	// re-index (before_agent_start runs every turn).
	pi.on("before_agent_start", (_event, ctx) => {
		if (piSkills.some((skill) => !registeredSkillCommands.has(skill.name))) registerSkillCommands(ctx.cwd);
	});

	// FALLBACK for pi < 0.86.0 (plan.md "Fallbacks for older pi"; delete it
	// when the peer floor reaches 0.86.0). Before faa9863cb, pi's steer() and
	// followUp() expanded `/skill:<name>` natively WITHOUT firing an `input`
	// event (queued interactive messages after the first, RPC steer/followUp),
	// so a turned-off skill's instructions could land in the session history.
	// On 0.86+ the `input` handler above refuses them first, so this finds
	// nothing to redact and returns undefined.
	// Strip them from every outgoing request instead — the wire copy carries the
	// refusal notice, the session file keeps the original bytes, and untouched
	// requests return undefined so the message array stays byte-identical
	// (prompt-cache stable). Override states are read lazily, only when a
	// message actually contains a `<skill>` block.
	pi.on("context", (event) => {
		let states: Map<string, string> | undefined;
		const isOff = (name: string) => {
			states ??= new Map(index().map((skill) => [skill.name, skill.state]));
			return states.get(name) === "off";
		};
		const redacted = redactOffSkillMessages(event.messages, isOff);
		return redacted ? { messages: redacted } : undefined;
	});

	const buildSkillsRows = (cwd: string | undefined): SkillsRow[] =>
		skillsOnly(cwd).map((skill) => ({
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

	registerLocalCommand(pi, "skills", {
		description: "View and manage skills (on / name-only / user-only / off)",
		handler: async (args, ctx) => {
			if (ctx.hasUI) {
				await openSkillsPanel(ctx);
				return;
			}
			// Non-interactive fallback: a flat listing with each skill's state.
			const all = skillsOnly(ctx.cwd);
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
