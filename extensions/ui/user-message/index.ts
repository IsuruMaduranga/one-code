/**
 * user-message extension: how the transcript shows a user message. It owns
 * the one Markdown transformer for user messages (lib/ui/user-message.ts has
 * the pipeline and why there is one): a notification that opened a turn
 * shows its headline, a typed command its command line, and with the
 * branding feature on the message gets Claude Code's `❯` pointer. It
 * answers USER_MARKDOWN_CHANNEL with the same rewrite, for a row another
 * extension draws as a user message.
 *
 * Required: the first two rewrites are what makes the harness's own text in
 * a user message readable, so they must not depend on a cosmetic feature a
 * profile can turn off. Display only; requests are untouched.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { feature } from "../../lib/profile/feature.ts";
import { featureEnabled } from "../../lib/profile/profile.ts";
import { paintedUserMarker, USER_MARKDOWN_CHANNEL, type UserMarkdownQuery, userMessageMarkdown } from "../../lib/ui/user-message.ts";

function userMessageExtension(pi: ExtensionAPI) {
	// The pointer is branding's look: on with the feature, painted from the
	// live theme pi hands the session.
	const marked = featureEnabled("branding");
	let theme: unknown;
	pi.on("session_start", (_event, ctx) => {
		theme = ctx.ui.theme;
	});
	const show = (markdown: string): string => userMessageMarkdown(markdown, marked ? paintedUserMarker(theme) : undefined);
	pi.registerMarkdownTransformer((markdown, context) => (context.messageType === "user" ? show(markdown) : markdown));
	// The same rewrite for a row another extension draws as a user message (a
	// skill typed after the first turn, tools/skill/index.ts).
	pi.events.on(USER_MARKDOWN_CHANNEL, (data) => {
		(data as UserMarkdownQuery).transform = show;
	});
}

export default feature("user-message", userMessageExtension);
