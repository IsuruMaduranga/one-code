/**
 * Project instruction files for the classifier (pure fs).
 *
 * Claude Code's classifier reads the same CLAUDE.md the agent does, so an
 * instruction like "never force push" steers both at once. This asks the
 * agent's own instruction source (lib/context/instructions.ts `classifier`): the
 * base's AGENTS.md and ONECODE.md files, and what the profile's provider adds
 * (One Code's: the managed and global files, every ancestor's CLAUDE.md,
 * `.claude/CLAUDE.md`, `.claude/rules` and CLAUDE.local.md), with the same
 * external import consent and symlink confinement. One Code's provider widens
 * it, since an instruction here can only tighten: AGENTS.md loads whatever
 * `instructionFiles` picks for the agent, and every path-conditional rule
 * loads, labelled with its paths, not only those for files the agent has read
 * (the block opens the cached classifier prefix, so it must not change as the
 * session touches new paths; profile/claude-code/instructions.ts).
 *
 * These files are checked in, so they are untrusted input in a way the user's
 * own messages are not — the classifier prompt tells the model they may tighten
 * what is allowed but never widen it. That asymmetry is what makes including
 * them safe; without it, a repository could ship its own authorisation.
 */

import { type ClassifierFile, openInstructions } from "../../../lib/context/instructions.ts";
import { classifierInstructionNote, fitToWindow } from "../../../lib/context/instruction-budget.ts";
import { estimateTextTokens } from "../../../lib/models/pi-ai-estimate.ts";
import { tryRealpath } from "../../../lib/profile/paths.ts";

/**
 * Concatenated instruction files in the agent's order (managed and global,
 * then each directory from the farthest down, ONECODE.md last), each labelled
 * with its path so the classifier can tell project convention from
 * user-global preference; undefined when there are none. A file is whole, as
 * Claude Code's classifier gets the agent's CLAUDE.md (a cut would drop the
 * restrictions past it), unless the agent's window budget skips it
 * (lib/context/instruction-budget.ts, against `contextWindow`, the session model's):
 * then a note replaces it in its labelled slot, so the files that make the
 * agent survivable cannot push every call past the classifier's window. The
 * agent's files are skipped exactly as the agent skips them; the files only
 * the classifier reads (path-conditional rules, AGENTS.md beside CLAUDE.md)
 * share what the agent's loaded files leave of the half. A transcript too
 * large for that window is not judged (`decisions/auto-mode.md`). With the
 * instructions feature off the agent reads no instruction file, and
 * neither does the classifier (lib/context/instructions.ts). `agentDir`
 * is pi's (`getAgentDir()`), for its global AGENTS.md.
 */
export function loadProjectInstructions(cwd: string, home: string, contextWindow: number | undefined, agentDir: string | undefined): string | undefined {
	const instructions = openInstructions(home, agentDir);
	const files: (ClassifierFile & { key: string })[] = [];
	const seen = new Set<string>();
	const add = (file: ClassifierFile) => {
		const key = tryRealpath(file.path) ?? file.path;
		if (seen.has(key) || !file.content.trim()) return;
		seen.add(key);
		files.push({ path: file.path, content: file.content, globs: file.globs, key });
	};
	for (const file of instructions.classifier({ cwd })) add(file);

	if (files.length === 0) return undefined;
	// The agent's own fit decides its files; the files only the classifier reads
	// share what the agent's loaded ones leave of the half, the largest going first.
	const sections = instructions.sections({ cwd });
	const agentFit = fitToWindow([...sections.contextFiles, ...sections.productFiles], contextWindow);
	const realKey = (path: string) => tryRealpath(path) ?? path;
	const agentFiles = new Set([...sections.contextFiles, ...sections.productFiles].map((file) => realKey(file.path)));
	const skipped = new Map(agentFit.skipped.map((file) => [realKey(file.path), file]));
	/** A file as this prompt shows it: a skipped one is the classifier's note. */
	const render = (file: (typeof files)[number]) => {
		const over = skipped.get(file.key);
		return over ? { ...file, content: classifierInstructionNote(over.tokens, over.contextWindow) } : file;
	};
	// The agent's files count as rendered here, a skipped one at the classifier's (longer) note.
	const agentShown = files.reduce((sum, file) => (agentFiles.has(file.key) ? sum + estimateTextTokens(render(file).content) : sum), 0);
	const ownFit = fitToWindow(files.filter((file) => !agentFiles.has(file.key)), contextWindow, { used: agentShown, note: classifierInstructionNote });
	for (const file of ownFit.skipped) skipped.set(realKey(file.path), file);
	const shown = files.map(render);
	return shown.map((file) => `# ${file.path}${file.globs ? ` (applies to ${file.globs.join(", ")})` : ""}\n${file.content.trim()}`).join("\n\n");
}
