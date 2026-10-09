/** Claude Code's project-scoped external instruction consent; pure fs/text, no pi imports. */
import { readJsonFile } from "./atomic-write.ts";
import { oneCodeProjectRoot, oneCodeProjectSettingsPath, readSettingsForWrite, writeSettings } from "./one-code-settings.ts";
import { comparablePath, tildify } from "./paths.ts";
import { escapeControlText } from "./terminal-text.ts";

export const EXTERNAL_INCLUDES_TITLE = "Allow external CLAUDE.md file imports?";
export const EXTERNAL_INCLUDES_YES = "Yes, allow external imports";
export const EXTERNAL_INCLUDES_NO = "No, disable external imports";
export const EXTERNAL_INCLUDES_SETTING = "External CLAUDE.md includes";

export interface ExternalIncludesApproval {
	approved: boolean;
	warningShown: boolean;
}

/**
 * Only One Code's out-of-checkout project state grants consent, never merged
 * project settings, and only for the repository that gave it: the file is
 * shared by every root with the same slug, so the answer names its root.
 */
export function readExternalIncludesApproval(cwd: string, home: string): ExternalIncludesApproval {
	const file = readJsonFile<Record<string, unknown>>(oneCodeProjectSettingsPath(cwd, home));
	const root = file?.claudeMdExternalIncludesRoot;
	if (typeof root !== "string" || comparablePath(root) !== comparablePath(oneCodeProjectRoot(cwd))) return { approved: false, warningShown: false };
	return {
		approved: file?.hasClaudeMdExternalIncludesApproved === true,
		warningShown: file?.hasClaudeMdExternalIncludesWarningShown === true,
	};
}

/** Both answers are remembered, and cover future imports, not just the files in the preview. */
export function persistExternalIncludesApproval(cwd: string, home: string, approved: boolean): void {
	const path = oneCodeProjectSettingsPath(cwd, home);
	writeSettings(path, {
		...readSettingsForWrite(path),
		hasClaudeMdExternalIncludesApproved: approved,
		hasClaudeMdExternalIncludesWarningShown: true,
		claudeMdExternalIncludesRoot: oneCodeProjectRoot(cwd),
	});
}

/** The dialog text; pi's plain select carries the body in its multiline title, including over RPC. */
export function externalIncludesDialog(paths: string[], home: string): string {
	const shown = paths.length <= 8 ? paths : paths.slice(0, 6);
	const hidden = paths.length - shown.length;
	const preview = shown.map((path) => `  ${escapeControlText(tildify(path, home))}`);
	if (hidden) preview.push(`  … +${hidden} ${hidden === 1 ? "import" : "imports"} not shown.`, "  Yes covers those too, plus any this project adds later.");
	return [
		EXTERNAL_INCLUDES_TITLE,
		"This project's CLAUDE.md or .claude/rules imports files outside the current working directory. Never allow this for third-party repositories.",
		...(paths.length ? [`External imports:\n${preview.join("\n")}`] : []),
		"Important: Only use One Code with files you trust. Accessing untrusted files may pose security risks.",
	].join("\n\n");
}
