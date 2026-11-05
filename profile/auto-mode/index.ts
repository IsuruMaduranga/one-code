/**
 * One Code's auto-mode text for the session model (the profile's
 * `text.autoMode`): Claude Code's auto-mode note with One Code's tool names,
 * its retry note verbatim (findings §33), and One Code's block reasons.
 */

import type { AutoModeText, ClassifierBlock, FloorTarget } from "../../extensions/auto-mode/text.ts";

const OPUS_NOTE =
	"While auto mode is active:\n\n" +
	"You can do much of your work through the bash tool when it is the simpler route: read files with cat, head, or sed -n, search with grep and find, and make small, mechanical file changes with sed, heredocs, or short scripts instead of the dedicated read, edit, or write tools. " +
	"The choice is yours: prefer edit or write when a shell edit would be fragile, such as exact or multi-line replacements, or sed/awk flags that differ between GNU and BSD/macOS.";

const FABLE_NOTE =
	"While auto mode is active:\n\n" +
	"Do your work through the bash tool wherever it can accomplish the job: read files with cat, head, or sed -n, search with grep and find, and make file changes with sed, heredocs, or short scripts, rather than using the dedicated read, edit, or write tools. " +
	"Fall back to a dedicated tool only when bash genuinely cannot do the job.";

function classifierBlock(block: ClassifierBlock): string {
	switch (block.kind) {
		case "noClassifierLeft": {
			const others = block.unusable.length > 0 ? ` ${block.unusable.map((u) => `${u.model} cannot be used (${u.error})`).join("; ")}.` : "";
			return `Auto mode has no classifier: ${block.refused.join(", ")} refused the classifier's prompt as a possible usage-policy violation.${others}`;
		}
		case "noModel":
			return "No model is available to run the auto-mode classifier.";
		case "actionTooLong":
			return `This call is ${block.chars} characters, more than the ${block.max} the auto-mode classifier reviews in full. Split it into smaller calls.`;
		case "cancelled":
			return "Auto-mode classification was cancelled.";
		case "transcriptTooLong":
			return `Classifier transcript exceeded context window (${block.model}). The action was not judged. Compact the session (/compact) and continue.`;
		case "truncated":
			return "The approval classifier's reply was cut off by its output limit before the verdict completed.";
		case "providerError":
			return `The auto-mode classifier returned no verdict (${block.summary}).`;
		case "unavailable": {
			const network = block.networkError !== undefined;
			return (
				`Auto mode could not screen this ${block.tool} call${network ? "" : " in time"} — the approval classifier${block.model ? ` (${block.model})` : ""} ` +
				`is temporarily unavailable (${network ? `network error: ${block.networkError}` : "timed out"}), so the call was not judged either way.`
			);
		}
		case "noUsableModel":
			return `No usable auto-mode classifier model (last error: ${block.lastError}).`;
		case "noSeverity":
			return "The approval classifier's reply carried no severity, so the verdict could not be read.";
		case "intentUnverified":
			return "The classifier cleared this as something the user asked for, but could not point to the user's own words asking for it.";
		case "unmatchedRule":
			return block.category
				? `The approval classifier blocked this as "${block.category}", which is not a rule that could be matched.`
				: "The approval classifier blocked this without naming a rule.";
	}
}

function floorReason({ kind, token }: FloorTarget): string {
	switch (kind) {
		case "catalog":
			return `it writes ${token}, a model catalog that decides the model tier the auto-mode checks that contain this agent depend on`;
		case "pattern":
			return `its pattern ${token} can select a file that holds the permission rules and auto-mode configuration that contain this agent`;
		case "control":
			return `it writes ${token}, which holds the permission rules and auto-mode configuration that contain this agent`;
	}
}

export const autoMode: AutoModeText = {
	systemNote: ({ firm }) => (firm ? FABLE_NOTE : OPUS_NOTE),
	permissionGranted: ({ displays }) =>
		`Permission granted for: ${displays.join(", ")}. You may now retry ${displays.length === 1 ? "this command" : "these commands"} if you would like.`,
	classifierBlock,
	floorReason,
	/** The floor re-checks a rewrite, and the classifier still judges it. */
	floorBlock: (target) => {
		const opening = `Auto mode blocked this call without consulting the classifier: ${floorReason(target)}.`;
		if (target.kind === "pattern") {
			return `${opening} A command that may touch the gate's own configuration is never auto-approved. If this is a read-only search, rewrite it without the wildcard or negated pattern (for example \`grep -r --exclude-dir=node_modules\`); otherwise ask the user to run it themselves.`;
		}
		return `${opening} Writes to the gate's own configuration are never auto-approved. Do not retry or route around this; ask the user to make the change themselves.`;
	},
};
