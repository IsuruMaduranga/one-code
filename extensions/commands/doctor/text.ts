/**
 * What the doctor extension needs from a profile (types only): the prompt
 * `/doctor fix` sends the model. The report it attaches is the same text the
 * panel shows the user (report.ts), passed in rendered; the base runs the
 * checks.
 */

export interface FixPromptInput {
	/** The rendered deterministic report, plain text. */
	reportText: string;
	install: "app" | "pi-package";
	productVersion: string;
	/** pi's sessions root, `<agentDir>/sessions` (other projects' directories live here — out of scope). */
	sessionsDir: string;
	/**
	 * THIS run's session directory: the project's directory under it, the only
	 * transcripts the permission gate lets a session read (Claude Code's own
	 * rule); with no saved session (`--no-session`), the run's private folder
	 * the gate reads instead (lib/request/persisted-output.ts projectSessionsDir).
	 */
	sessionDir: string;
	/** False when the run saves no session, so `sessionDir` holds no transcripts. */
	sessionPersisted: boolean;
	productSettingsPath: string;
	productProjectSettingsPath: string;
	/** True when auto mode is writing `auto-mode-decisions.jsonl` next to the session files. */
	decisionLogEnabled: boolean;
	/** True when the profile's source provider is switched off (One Code's independent mode, lib/profile/sources.ts `sourcesOff`). */
	sourcesOff?: boolean;
	/** The key that cycles permission modes, as the TUI names it. */
	modeCycleKey: string;
	/** The commands that upgrade each install. */
	upgradeCommands: { npm: string; brew: string; "pi-package": string };
}

export interface DoctorText {
	fixPrompt(input: FixPromptInput): string;
}
