/**
 * `onecode doctor` — the report without a session, Claude Code's `claude doctor`.
 *
 * The bundled app (app/bin.mjs) loads this file through pi's own TypeScript
 * loader (jiti) and calls `runDoctorCli` before pi's `main()` would ever run,
 * so it works on the machine the doctor exists for: one with no provider yet,
 * where pi's session bootstrap has nothing to start. Reads pi's auth and model
 * files through pi's own `ModelRuntime`/`ModelRegistry` (no network) and pi's
 * saved default model through `SettingsManager`; everything else is the same
 * `buildDoctorReport` the `/doctor` command uses.
 */

import { join } from "node:path";
import { ModelRegistry, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { oneCodeStateDir } from "../lib/paths.ts";
import { loadPermissionSettings } from "../permissions/settings.ts";
import { buildDoctorReport } from "./build.ts";
import { type DoctorReport, renderDoctorText, type SessionView } from "./report.ts";
import { lookupLatestVersion } from "./update-lookup.ts";

export interface DoctorCliOptions {
	agentDir: string;
	cwd: string;
	home: string;
	env: NodeJS.ProcessEnv;
	version: string;
	install: "app" | "pi-package";
	piVersion?: string;
	/** Report width; defaults to the terminal's columns, else 100. */
	columns?: number;
	/** Skip the registry version lookup (tests). */
	network?: boolean;
}

/** Build the report headlessly. Exported separately so tests can inspect the structure. */
export async function collectDoctorCliReport(options: DoctorCliOptions): Promise<DoctorReport> {
	const { agentDir, cwd, home, env } = options;
	// The registry lookup (network, up to 3s) overlaps the local runtime load.
	const latestPending = options.network === false ? undefined : lookupLatestVersion({ install: options.install, current: options.version, env });
	const runtime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		allowModelNetwork: false,
	});
	const registry = new ModelRegistry(runtime);
	const settings = SettingsManager.create(cwd, agentDir);

	const available = registry.getAvailable();
	const defaultProvider = settings.getDefaultProvider();
	const defaultModel = settings.getDefaultModel();
	const saved = defaultProvider && defaultModel ? registry.find(defaultProvider, defaultModel) : undefined;
	const session: SessionView = saved
		? { model: saved, modelSource: "default-setting" }
		: available[0]
			? { model: available[0], modelSource: "first-available" }
			: { modelSource: "none" };
	session.thinkingLevel = settings.getDefaultThinkingLevel();
	const permissions = loadPermissionSettings(cwd, home);
	session.permission = {
		mode: permissions.defaultMode ?? "auto",
		source: permissions.defaultMode ? "permissions.defaultMode in settings" : "One Code's default",
	};

	const latest = await latestPending;
	return buildDoctorReport({
		env: {
			cwd,
			home,
			agentDir,
			stateDir: oneCodeStateDir(env, home),
			env,
			platform: process.platform,
			arch: process.arch,
			nodeVersion: process.versions.node,
			oneCodeVersion: options.version,
			install: options.install,
			piVersion: options.piVersion,
			latest,
		},
		registry: {
			all: registry.getAll(),
			available,
			authStatus: (provider) => registry.getProviderAuthStatus(provider),
			displayName: (provider) => registry.getProviderDisplayName(provider),
		},
		session,
	});
}

/** Print the report; exit code 1 when an error-level finding means a session cannot work yet. */
export async function runDoctorCli(options: DoctorCliOptions, write: (text: string) => void = (text) => process.stdout.write(text)): Promise<number> {
	const report = await collectDoctorCliReport(options);
	const width = options.columns ?? process.stdout.columns ?? 100;
	write(`${renderDoctorText(report, Math.max(60, Math.min(width, 120)))}\n\n`);
	const where = options.install === "app" ? "an onecode session" : "a pi session";
	write(`For a full setup checkup that can also fix issues, run /doctor inside ${where}.\n`);
	write("Inside a session, /doctor report shows this report alone.\n");
	return report.findings.some((finding) => finding.level === "error") ? 1 : 0;
}
