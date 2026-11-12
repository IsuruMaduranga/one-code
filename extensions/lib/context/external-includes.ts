/**
 * The project-scoped consent for instruction files that import files outside
 * the project; pure fs/text, no pi imports. The words name the project's
 * instruction file as the caller gives it (lib/context/instructions.ts
 * `instructionTargets()`: AGENTS.md, or the source provider's names).
 */
import { brand } from "../profile/brand.mjs";
import { readJsonFile } from "../core/atomic-write.ts";
import { productProjectRoot, productProjectSettingsPathFor, readSettingsForWrite, writeSettings } from "../profile/product-settings.ts";
import { comparablePath, tildify } from "../profile/paths.ts";
import { escapeControlText } from "../ui/terminal-text.ts";

export const externalIncludesTitle = (file: string): string => `Allow external ${file} file imports?`;
export const EXTERNAL_INCLUDES_YES = "Yes, allow external imports";
export const EXTERNAL_INCLUDES_NO = "No, disable external imports";
export const externalIncludesSetting = (file: string): string => `External ${file} includes`;
/**
 * `/config` with nothing to show. Claude Code's /config is a full settings
 * panel and hides this row when there are no external includes; ours holds
 * only this row so far (decisions/tools.md), so the empty case names where
 * the other settings live instead of ending the command.
 */
export const externalIncludesNone = (file: string): string =>
	`No external ${file} includes in this project, so /config has nothing to change. Other settings: /settings (pi's settings), /model, /permissions, /memory.`;
/** `/config` without a terminal to ask in. */
export const externalIncludesNeedsUi = (file: string): string => `/config requires an interactive UI to change external ${file} include approval.`;
/** The `/config` command's description. */
export const externalIncludesCommand = (file: string): string => `Configure external ${file} includes for this project`;
/** The answer could not be written. */
export const externalIncludesNotSaved = (file: string, error: unknown): string => `Could not remember external ${file} include approval: ${String(error)}`;

export interface ExternalIncludesApproval {
	approved: boolean;
	warningShown: boolean;
}

/**
 * The project root an answer was given for. The settings file's slug is lossy
 * (`my_app` and `my-app` share one file), so the answer counts only for this
 * exact root; an answer recorded without one is asked again.
 */
const APPROVAL_ROOT_KEY = "claudeMdExternalIncludesRoot";

/** Only the product's out-of-checkout project state grants consent, never merged project settings. */
export function readExternalIncludesApproval(cwd: string, home: string): ExternalIncludesApproval {
	const root = productProjectRoot(cwd);
	const file = readJsonFile<Record<string, unknown>>(productProjectSettingsPathFor(root, home));
	const recorded = file?.[APPROVAL_ROOT_KEY];
	if (!file || typeof recorded !== "string" || comparablePath(recorded) !== comparablePath(root)) return { approved: false, warningShown: false };
	return {
		approved: file.hasClaudeMdExternalIncludesApproved === true,
		warningShown: file.hasClaudeMdExternalIncludesWarningShown === true,
	};
}

/** Both answers are remembered, and cover future imports, not just the files in the preview. */
export function persistExternalIncludesApproval(cwd: string, home: string, approved: boolean): void {
	const root = productProjectRoot(cwd);
	const path = productProjectSettingsPathFor(root, home);
	writeSettings(path, {
		...readSettingsForWrite(path),
		hasClaudeMdExternalIncludesApproved: approved,
		hasClaudeMdExternalIncludesWarningShown: true,
		[APPROVAL_ROOT_KEY]: root,
	});
}

/** The dialog text; pi's plain select carries the body in its multiline title, including over RPC. */
export function externalIncludesDialog(paths: string[], home: string, file: string, importers: string): string {
	const shown = paths.length <= 8 ? paths : paths.slice(0, 6);
	const hidden = paths.length - shown.length;
	const preview = shown.map((path) => `  ${escapeControlText(tildify(path, home))}`);
	if (hidden) preview.push(`  … +${hidden} ${hidden === 1 ? "import" : "imports"} not shown.`, "  Yes covers those too, plus any this project adds later.");
	return [
		externalIncludesTitle(file),
		`This project's ${importers} imports files outside the current working directory. Never allow this for third-party repositories.`,
		...(paths.length ? [`External imports:\n${preview.join("\n")}`] : []),
		`Important: Only use ${brand.name} with files you trust. Accessing untrusted files may pose security risks.`,
	].join("\n\n");
}
