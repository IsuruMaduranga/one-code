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
import { getAgentDir, stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { pluginRoot } from "../lib/plugin-root.ts";
import { defaultDiscoverRoots, discoverPlugins } from "../lib/plugins.ts";
import { awaitOneShotTurn } from "../lib/notifications.ts";
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
import { recordUsage } from "../lib/usage-tracker.ts";
import { boundedDockHeight, ccToolRenderers, safeThemeBold, safeThemePaint, truncateLine } from "../lib/tui-render.ts";
import {
	bareSkillMatches,
	buildSkillBlock,
	parseSkillCommand,
	redactOffSkillMessages,
	resolveSkill,
	skillCommandCandidates,
} from "./invoke.ts";
import { decodeSkillsKey } from "./panel/keys.ts";
import { skillListingText } from "./listing.ts";
import { renderSkillsPanel, type SkillsPaint } from "./panel/render.ts";
import { applySkillsKey, initialSkillsState, type SkillsRow, visibleRows } from "./panel/state.ts";
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

	/**
	 * Description from a SKILL.md frontmatter, for skills pi hasn't resolved (the
	 * pre-first-turn scan) and for plugin skills (discoverPlugins carries none).
	 * Cached per path: the listing is rebuilt every turn and a description is
	 * stable for the session anyway (the listing must stay byte-stable for the
	 * cache prefix).
	 */
	const descriptionCache = new Map<string, string | undefined>();
	const readDescription = (path: string): string | undefined => {
		if (descriptionCache.has(path)) return descriptionCache.get(path);
		const description = readDescriptionUncached(path);
		descriptionCache.set(path, description);
		return description;
	};
	const readDescriptionUncached = (path: string): string | undefined => {
		try {
			const { frontmatter } = parseFrontmatterLoosely(readFileSync(path, "utf-8")) as {
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
				: scanSkills(cwd ?? process.cwd(), home, agentDir, [], BUNDLED_SKILLS_DIR).map((skill) => ({
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
			description: readDescription(skill.path),
			path: skill.path,
			source: "plugin" as const,
			scope: "plugin" as const,
			state: "on" as const,
			pluginName: skill.plugin,
		}));
		return [...project, ...plugin];
	};

	const describe = () => skillListingText(index());

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

			let body: string;
			try {
				const parsed = parseFrontmatterLoosely(readFileSync(found.path, "utf-8")) as { body: string };
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

	/**
	 * Surface a user-facing skill message: a TUI/RPC toast where there is UI, or
	 * stderr in a one-shot run (`-p`, `--mode json`), where `ctx.ui.notify` is a
	 * no-op (pi wires no UI context there) so the message would otherwise vanish
	 * and the command would exit silently. `console.error` writes to stderr, so it
	 * never corrupts the `--mode json` event stream on stdout.
	 */
	const notifyOrPrint = (
		ctx: Pick<ExtensionContext, "hasUI" | "ui">,
		message: string,
		level: "warning" | "error",
	): void => {
		if (ctx.hasUI) ctx.ui.notify(message, level);
		else console.error(message);
	};

	/**
	 * Run a resolved skill the way a user-typed command does: refuse an "off"
	 * skill (in EVERY mode — falling through would hand `/skill:` to pi's native
	 * expansion, which knows nothing of the overrides store and would run it; a
	 * one-shot run gets the refusal on stderr instead of a UI notice, never as
	 * silent execution), else re-deliver pi's exact `<skill>` block as a hidden
	 * custom message. The model receives the same bytes pi's own expansion would
	 * submit as a user turn (convertToLlm maps a custom message to a user message
	 * regardless of `display`), but nothing renders. Shared by the `/skill:<name>`
	 * interception and the bare `/<name>` commands.
	 */
	const deliverSkill = async (
		found: IndexedSkill,
		args: string,
		ctx: ExtensionContext & { waitForIdle?: () => Promise<void> },
		extra: { images?: Array<{ type: "image"; data: string; mimeType: string }>; streamingBehavior?: "steer" | "followUp" } = {},
	): Promise<"handled" | "unavailable"> => {
		if (found.state === "off") {
			const where = found.source === "plugin" ? "/plugins" : "/skills";
			notifyOrPrint(ctx, `Skill "${found.name}" is turned off — enable it from ${where} to run it.`, "warning");
			return "handled";
		}
		let body: string;
		try {
			body = stripFrontmatter(readFileSync(found.path, "utf-8")).trim();
		} catch {
			return "unavailable";
		}
		recordUsage(pluginRoot(getAgentDir()), "skill", found.name);
		const block = buildSkillBlock({ name: found.name, filePath: found.path }, body, args);
		// Carry any attached images alongside the block, as pi's native path would.
		const content = extra.images?.length ? [{ type: "text" as const, text: block }, ...extra.images] : block;
		pi.sendMessage(
			{ customType: "one-code:skill-invocation", content, display: false, details: { skill: found.name, args } },
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
	// pi's native handling. This hook only covers prompt(); paths that expand
	// without an `input` event (steer/followUp) are caught by the context-hook
	// redaction below.
	pi.on("input", async (event, ctx) => {
		const cmd = parseSkillCommand(event.text);
		if (!cmd) return { action: "continue" };
		const found = resolveSkill(index(), cmd.name);
		if (!found) return { action: "continue" };
		const outcome = await deliverSkill(found, cmd.args, ctx, {
			images: event.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined,
			streamingBehavior: event.streamingBehavior,
		});
		return { action: outcome === "handled" ? "handled" : "continue" };
	});

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
	const registerSkillCommands = (cwd: string | undefined) => {
		let taken: string[];
		try {
			taken = pi.getCommands().map((command) => command.name);
		} catch {
			return; // not bound yet (load time) — session_start retries
		}
		const templates = promptTemplateNames(cwd ?? process.cwd(), os.homedir(), getAgentDir());
		for (const skill of skillCommandCandidates(index(cwd), [...taken, ...templates, ...registeredSkillCommands])) {
			registeredSkillCommands.add(skill.name);
			pi.registerCommand(skill.name, {
				description: skill.description ? `${skill.description} (skill)` : `Run the ${skill.name} skill`,
				handler: async (args, ctx) => {
					const found = resolveSkill(index(ctx.cwd), skill.name);
					if (!found || (await deliverSkill(found, args.trim(), ctx)) === "unavailable") {
						notifyOrPrint(ctx, `Skill "${skill.name}" is no longer available (its SKILL.md was removed or is unreadable).`, "error");
					}
				},
			});
		}
	};
	pi.on("session_start", (_event, ctx) => registerSkillCommands(ctx.cwd));
	// pi's per-turn resolution (frontmatter `name`, description required) can
	// surface skills the pre-turn disk scan missed; late registrations still
	// execute (autocomplete lists them after a /reload). Gated on an unseen
	// name so the steady state costs one Set lookup per skill per turn, not a
	// re-index (before_agent_start runs every turn).
	pi.on("before_agent_start", (_event, ctx) => {
		if (piSkills.some((skill) => !registeredSkillCommands.has(skill.name))) registerSkillCommands(ctx.cwd);
	});

	// Fail-closed backstop for the `input` interception above: pi's steer() and
	// followUp() expand `/skill:<name>` natively WITHOUT firing an `input` event
	// (queued interactive messages after the first, RPC steer/followUp), so a
	// turned-off skill's instructions can land in the session history anyway.
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

	registerLocalCommand(pi, "skills", {
		description: "View and manage skills (on / name-only / user-only / off)",
		handler: async (args, ctx) => {
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
