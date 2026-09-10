/**
 * doctor extension — `/doctor`, One Code's setup checkup.
 *
 * Claude Code has two: `claude doctor` (a read-only terminal diagnostics
 * screen) and the in-session `/doctor` (a model-driven checkup skill that reads
 * the same diagnostics and fixes what it finds). One Code mirrors both: bare
 * `/doctor` is the checkup, as in Claude Code, with the harness's measured
 * report attached to the prompt; `/doctor report` shows that report alone, and
 * bare `/doctor` falls back to it when no model can run — the first-session
 * state ("no provider is ready") this command exists for. docs/decisions/doctor.md.
 *
 *   /doctor                  the checkup: the report goes to the model inside Claude Code's
 *                            doctor prompt, adapted (falls back to the report when no model can run)
 *   /doctor report           the measured report alone (a scrollable panel in the TUI, plain text elsewhere)
 *   /doctor presets          the three model presets for this provider
 *   /doctor preset <name>    apply one: main model, subagent default, classifier
 *
 * `onecode doctor` (the app's CLI subcommand) prints the same report without a
 * session — see cli.ts. Thin wiring: every check lives in the pure modules.
 */

import * as os from "node:os";
import { join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getAgentDir,
	VERSION as PI_VERSION,
} from "@earendil-works/pi-coding-agent";
import { loadAutoModeConfig, persistClassifierModel } from "../auto-mode/config.ts";
import { configuredCapabilityKey, loadCapabilitySnapshot, refreshCapabilitySnapshot, snapshotIsStale } from "../lib/capability-index.ts";
import { MCP_STATUS_CHANNEL, MCP_STATUS_REQUEST_CHANNEL, type McpStatusEvent } from "../lib/mcp-status.ts";
import { sessionOutlivesTurn } from "../lib/notifications.ts";
import { modelSpec } from "../lib/model-policy.ts";
import { oneCodeProjectSettingsPath, oneCodeSettingsPath } from "../lib/one-code-settings.ts";
import { oneCodeStateDir } from "../lib/paths.ts";
import { CLASSIFIER_SETTING_CHANGED_CHANNEL, SUBAGENT_DEFAULT_CHANGED_CHANNEL } from "../lib/settings-channels.ts";
import { boundedDockHeight, safeThemeBold, safeThemePaint, truncateLine } from "../lib/tui-render.ts";
import { PERMISSION_STATUS_CHANNEL, type PermissionStatus } from "../permissions/modes.ts";
import { persistSubagentModel } from "../subagents/default-model.ts";
import { buildDoctorReport, oneCodeVersion } from "./build.ts";
import { doctorFixPrompt } from "./fix-prompt.ts";
import { computePresets, describePresetChanges, findPreset, PRESET_NAMES, presetsSection } from "./presets.ts";
import { type DoctorReport, renderDoctorReport, renderDoctorText, renderSection } from "./report.ts";
import { lookupLatestVersion } from "./update-lookup.ts";
import { applyDoctorKey, decodeDoctorKey, renderDoctorViewer, visibleBodyRows } from "./viewer.ts";

/** Rows the panel may take; the terminal's own height caps it (boundedDockHeight). */
export const DOCTOR_PANEL_MAX_HEIGHT = 40;

export default function doctorExtension(pi: ExtensionAPI) {
	let permission: PermissionStatus | undefined;
	pi.events.on(PERMISSION_STATUS_CHANNEL, (data) => {
		permission = data as PermissionStatus;
	});

	/** The mcp extension answers the request synchronously on the bus (lib/mcp-status.ts). */
	const mcpSnapshot = (): McpStatusEvent | undefined => {
		let snapshot: McpStatusEvent | undefined;
		const unsubscribe = pi.events.on(MCP_STATUS_CHANNEL, (data) => {
			snapshot = data as McpStatusEvent;
		});
		try {
			pi.events.emit(MCP_STATUS_REQUEST_CHANNEL, {});
		} finally {
			unsubscribe();
		}
		return snapshot;
	};

	const install = (): "app" | "pi-package" => (process.env.CC_VERSION ? "app" : "pi-package");

	// The Artificial Analysis snapshot behind the measured capability floor
	// (lib/capability-index.ts): refreshed at most daily, only from a session
	// that outlives the turn, never awaited in session_start (findings §15, §19),
	// inert once the session is shutting down. A failure is logged once.
	let shuttingDown = false;
	let refreshWarned = false;
	const refreshCapability = async (ctx: ExtensionContext, home: string): Promise<void> => {
		const outcome = await refreshCapabilitySnapshot({ key: configuredCapabilityKey(home), stateDir: oneCodeStateDir(process.env, home) });
		if (outcome.status === "failed" && !refreshWarned && !shuttingDown) {
			refreshWarned = true;
			try {
				ctx.ui.notify(`Capability scores not refreshed: ${outcome.error}. Automatic picks keep using the last snapshot, if any.`, "warning");
			} catch {
				// A UI hiccup must not fail the report that awaits this refresh.
			}
		}
	};
	pi.on("session_start", (_event, ctx) => {
		const home = os.homedir();
		if (!sessionOutlivesTurn(ctx.mode) || !configuredCapabilityKey(home)) return;
		if (!snapshotIsStale(loadCapabilitySnapshot(oneCodeStateDir(process.env, home)))) return;
		void refreshCapability(ctx, home).catch(() => {});
	});
	pi.on("session_shutdown", () => {
		shuttingDown = true;
	});

	const gather = async (ctx: ExtensionContext, options: { network: boolean }): Promise<DoctorReport> => {
		const home = os.homedir();
		const version = oneCodeVersion();
		// Two unrelated endpoints (npm registry, Artificial Analysis): overlap them.
		// The snapshot refresh is a no-op when fresh or keyless, bounded by FETCH_TIMEOUT_MS.
		const [latest] = options.network
			? await Promise.all([lookupLatestVersion({ install: install(), current: version, env: process.env }), refreshCapability(ctx, home)])
			: [undefined];
		return buildDoctorReport({
			env: {
				cwd: ctx.cwd,
				home,
				agentDir: getAgentDir(),
				stateDir: oneCodeStateDir(process.env, home),
				env: process.env,
				platform: process.platform,
				arch: process.arch,
				nodeVersion: process.versions.node,
				oneCodeVersion: version,
				install: install(),
				piVersion: PI_VERSION,
				latest,
			},
			registry: {
				all: ctx.modelRegistry.getAll(),
				available: ctx.modelRegistry.getAvailable(),
				authStatus: (provider) => ctx.modelRegistry.getProviderAuthStatus(provider),
				displayName: (provider) => ctx.modelRegistry.getProviderDisplayName(provider),
			},
			session: {
				model: ctx.model,
				modelSource: ctx.model ? "session" : "none",
				thinkingLevel: ctx.thinkingLevel,
				permission: permission
					? { mode: permission.mode, classifier: permission.classifier, pinned: permission.pinned, source: permission.mode === "auto" ? undefined : "set for this session" }
					: undefined,
				mcp: mcpSnapshot(),
			},
		});
	};

	const sendFix = (ctx: ExtensionContext, report: DoctorReport): boolean => {
		if (!ctx.model) {
			ctx.ui.notify("No model is available, so the checkup cannot run. Connect a provider with /login first; the report already lists what to fix.", "warning");
			return false;
		}
		const home = os.homedir();
		const prompt = doctorFixPrompt({
			reportText: renderDoctorText(report, 100),
			install: install(),
			oneCodeVersion: oneCodeVersion(),
			sessionsDir: join(getAgentDir(), "sessions"),
			oneCodeSettingsPath: oneCodeSettingsPath(home),
			oneCodeProjectSettingsPath: oneCodeProjectSettingsPath(ctx.cwd, home),
			decisionLogEnabled: loadAutoModeConfig(home).logDecisions,
		});
		pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		return true;
	};

	const showPanel = async (ctx: ExtensionCommandContext, report: DoctorReport): Promise<void> => {
		let wantFix = false;
		await ctx.ui.custom<null>((tui, theme, _keybindings, done) => {
			const paint = safeThemePaint(theme);
			const bold = safeThemeBold(theme);
			const state = { offset: 0 };
			let cache: { width: number; lines: string[] } | undefined;
			const body = (width: number) => {
				if (cache?.width === width) return cache;
				cache = { width, lines: renderDoctorReport(report, { width: width - 2, paint, bold }).map((line) => ` ${line}`) };
				return cache;
			};
			return {
				render: (width: number) => {
					const termRows = (tui as { terminal?: { rows?: number } }).terminal?.rows ?? DOCTOR_PANEL_MAX_HEIGHT;
					const height = boundedDockHeight(termRows, DOCTOR_PANEL_MAX_HEIGHT);
					const { lines } = body(width);
					return renderDoctorViewer({ lines, state, width, height, canFix: ctx.model !== undefined }, paint).map((line) => truncateLine(line, width));
				},
				handleInput: (data: string) => {
					const key = decodeDoctorKey(data);
					if (!key) return;
					const termRows = (tui as { terminal?: { rows?: number } }).terminal?.rows ?? DOCTOR_PANEL_MAX_HEIGHT;
					const visible = visibleBodyRows(boundedDockHeight(termRows, DOCTOR_PANEL_MAX_HEIGHT));
					const effect = applyDoctorKey(state, key, cache?.lines.length ?? 0, visible);
					if (effect?.kind === "fix") {
						wantFix = true;
						done(null);
						return;
					}
					if (effect?.kind === "close") {
						done(null);
						return;
					}
					tui.requestRender();
				},
				invalidate: () => {
					cache = undefined;
				},
			};
		});
		if (wantFix) sendFix(ctx, report);
	};

	const applyPreset = async (name: string, ctx: ExtensionCommandContext): Promise<void> => {
		const available = ctx.modelRegistry.getAvailable();
		const { presets, unavailable } = computePresets(available, ctx.model);
		if (unavailable === "no-model") {
			ctx.ui.notify("No model is available — connect a provider with /login first.", "warning");
			return;
		}
		if (unavailable === "no-priced-models") {
			ctx.ui.notify("No priced models on this provider, so tiers cannot be told apart and no preset can be applied. Pick models by hand with /model, /subagent and /auto-mode model.", "warning");
			return;
		}
		const preset = findPreset(presets, name);
		if (!preset) {
			ctx.ui.notify(`Unknown preset "${name}". Choose one of: ${PRESET_NAMES.join(", ")} (see /doctor presets).`, "error");
			return;
		}
		const home = os.homedir();
		const mainSwitched = !ctx.model || modelSpec(ctx.model) !== modelSpec(preset.main);
		if (mainSwitched && !(await pi.setModel(preset.main))) {
			ctx.ui.notify(`Could not switch the main model to ${modelSpec(preset.main)}; nothing was changed.`, "error");
			return;
		}
		try {
			persistSubagentModel(preset.subagents.setting === "inherit" ? "inherit" : undefined, home);
			persistClassifierModel(undefined, home);
		} catch (error) {
			const switched = mainSwitched ? ` The main model was already switched to ${modelSpec(preset.main)}; /model switches it back.` : "";
			ctx.ui.notify(`Could not save settings: ${error instanceof Error ? error.message : String(error)}.${switched}`, "error");
			return;
		}
		pi.events.emit(SUBAGENT_DEFAULT_CHANGED_CHANNEL, {});
		pi.events.emit(CLASSIFIER_SETTING_CHANGED_CHANNEL, {});
		ctx.ui.notify(
			[
				`Applied the ${preset.label} preset:`,
				...describePresetChanges(preset, mainSwitched).map((line) => `  ${line}`),
				"Saved to ~/.onecode/settings.json; the main model is remembered as pi's default.",
			].join("\n"),
			"info",
		);
	};

	/** The subcommands, with the one-line explanation the completion menu shows next to each. */
	const SUBCOMMANDS: Array<{ value: string; description: string }> = [
		{ value: "report", description: "Show the measured setup report: providers, the model each role gets, imported Claude Code config, MCP servers, dependencies" },
		{ value: "presets", description: "List the economical / balanced / maximum-quality model presets for this provider, with the models each would pick" },
		{ value: "preset economical", description: "Apply: one cheap model for the main session, subagents and the classifier" },
		{ value: "preset balanced", description: "Apply: a capable main model, cheaper automatic picks for subagents and the classifier" },
		{ value: "preset quality", description: "Apply: the strongest model for the main session and its subagents" },
	];

	pi.registerCommand("doctor", {
		description:
			"Health-check your setup and fix what's wrong (Claude Code's checkup, run by the model). Subcommands: report (the measured report only), presets, preset <economical|balanced|quality>",
		getArgumentCompletions: (prefix) => {
			const typed = prefix.trim().toLowerCase();
			return SUBCOMMANDS.filter((option) => option.value.startsWith(typed)).map((option) => ({ value: option.value, label: option.value, description: option.description }));
		},
		handler: async (args, ctx) => {
			const [verb, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			if (verb === "preset") {
				if (rest.length === 0) {
					ctx.ui.notify(`Which preset? /doctor preset <${PRESET_NAMES.join("|")}> — /doctor presets shows what each would pick.`, "warning");
					return;
				}
				await applyPreset(rest.join(" "), ctx);
				return;
			}
			if (verb === "presets") {
				const section = presetsSection(computePresets(ctx.modelRegistry.getAvailable(), ctx.model), ctx.model);
				ctx.ui.notify(renderSection(section, { width: 100 }).join("\n"), "info");
				return;
			}
			if (verb && verb !== "report") {
				ctx.ui.notify(`Unknown /doctor argument "${verb}". Use /doctor, /doctor report, /doctor presets, or /doctor preset <name>.`, "error");
				return;
			}
			// Bare `/doctor` is the checkup (Claude Code parity). Without a model it
			// cannot run, so the report — which is what explains the missing model —
			// shows instead.
			const checkup = verb === undefined;
			const report = await gather(ctx, { network: !checkup });
			if (checkup && ctx.model) {
				sendFix(ctx, report);
				return;
			}
			if (checkup) ctx.ui.notify("No model is available, so the checkup cannot run; showing the setup report instead. Connect a provider with /login, then rerun /doctor.", "warning");
			if (ctx.hasUI && ctx.mode === "tui") {
				await showPanel(ctx, report);
				return;
			}
			ctx.ui.notify(renderDoctorText(report, 100), report.ready ? "info" : "warning");
		},
	});
}
