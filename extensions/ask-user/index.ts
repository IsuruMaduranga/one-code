/**
 * ask-user extension — re-exports the community `pi-ask-user` package
 * (Claude Code's AskUserQuestion equivalent: structured option selection,
 * multi-select, freeform input, RPC/headless fallback).
 *
 * pi-ask-user has no package `main`; its pi manifest points at ./index.ts,
 * so we import that file directly.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import askUser from "pi-ask-user/index.ts";

export default function askUserExtension(pi: ExtensionAPI) {
	return askUser(pi);
}
