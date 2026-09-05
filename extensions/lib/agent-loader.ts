/**
 * Shared in-process agent wiring: the one place that builds a pi
 * `ModelRuntime` and a `DefaultResourceLoader` for an agent session that runs
 * inside this process. Used by both the workflow runner
 * (`extensions/workflow/agent-session.ts`) and the subagent runner.
 *
 * Loaders are built with `noExtensions: true` so a child never auto-discovers
 * the whole One Code package (which would recurse into the subagent/workflow
 * tools and re-init UI/MCP/LSP). Fidelity is added back deliberately:
 * `permissionGateFactory` is always attached (a child has no permission
 * extension otherwise); callers pass `extraFactories` (e.g. claude-context,
 * file-tracker) and `extraExtensionPaths` (curated stateless tool providers)
 * for what they need. `extensionFactories` and `additionalExtensionPaths` are
 * both loaded even under `noExtensions`.
 */

import os from "node:os";
import { join } from "node:path";
import {
	type AgentSession,
	type CreateAgentSessionOptions,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionError,
	type InlineExtension,
	ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { HookBridge } from "../hooks/subagent-bridge.ts";
import type { PermissionBridge } from "../permissions/subagent-gate.ts";
import { withShortCacheRetention } from "./cache-retention.ts";
import { hookGateFactory } from "./hook-gate.ts";
import { permissionGateFactory } from "./permission-gate.ts";
import { worktreeGuardFactory } from "./worktree-isolation.ts";

/** The last assistant message's text (the value an agent run returns). */
export function finalAssistantText(messages: AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		const content = (message as { content: unknown }).content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			const text = content
				.filter((b): b is { type: "text"; text: string } => (b as { type?: string }).type === "text")
				.map((b) => b.text)
				.join("");
			if (text.trim()) return text;
		}
	}
	return "";
}

/**
 * The canonical model/auth runtime, shared across all agents in a run (building
 * one per agent is expensive). Children are tight loops, so it answers every
 * auth with the provider's 5-minute cache TTL rather than the main session's
 * 1-hour one (lib/cache-retention.ts).
 */
export async function createSharedModelRuntime(agentDir: string): Promise<ModelRuntime> {
	const runtime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
	});
	return withShortCacheRetention(runtime);
}

export interface AgentLoaderOptions {
	cwd: string;
	agentDir: string;
	/** Per-agent system prompt (an agent's own prompt, or a fork's inherited one). */
	systemPrompt?: string;
	/** Inline factories to attach alongside the permission gate (claude-context, file-tracker, injected tools). */
	extraFactories?: InlineExtension[];
	/** CLI-style extension entrypoints to load (curated stateless tool providers). Loaded even under noExtensions. */
	extraExtensionPaths?: string[];
	/** Tool names the permission gate must never gate (runtime-injected tools). */
	neverGate?: Set<string>;
	/**
	 * The parent permissions extension's decision closure. When present, the child's
	 * permission gate routes every tool call through it (mode inheritance, classifier,
	 * prompts bubbled to the user); when absent (headless runs with no publishing
	 * parent), the gate uses its fail-closed local fallback. A getter so it can be
	 * read lazily — the bridge may not be published yet when the loader is built.
	 */
	getPermissionBridge?: () => PermissionBridge | undefined;
	/**
	 * The parent hooks extension's bridge (hooks/subagent-bridge.ts). When present,
	 * the user's PreToolUse/PostToolUse hooks run for the child's tool calls, before
	 * the guards and the permission gate (Claude Code runs hooks inside subagents).
	 * A getter, read per call, like the permission bridge.
	 */
	getHookBridge?: () => HookBridge | undefined;
	/** Resolves a child session id to its agent type, for the hook payload's `agent_type`. */
	agentTypeOf?: (sessionId: string | undefined) => string | undefined;
	/**
	 * Stop pi from appending CLAUDE.md/AGENTS.md to the child's system prompt. Set
	 * by a caller whose child session loads the `claude-context` extension, which
	 * injects the `# claudeMd` reminder itself — otherwise the child carried the
	 * project instructions twice (review S10).
	 */
	noContextFiles?: boolean;
}

/**
 * Build and `reload()` a resource loader for an in-process agent session.
 *
 * ONE LOADER PER SESSION — never cache one across sessions. `AgentSession.dispose()`
 * invalidates the loader's shared extension runtime, not just the session's
 * runner: from then on every `pi.*` call from those extension instances throws
 * the stale-ctx error and their `pi.events.on` subscriptions are gone, silently
 * (pi's handler wrappers catch the throw, and an SDK session has no error
 * listener). A cached loader therefore broke the second child of the same
 * agent type, every SendMessage resume, every workflow agent after the first,
 * and any sibling still running when one was disposed
 * (LIFECYCLE-REVIEW-2026-09-06 H3, measured). A build costs ~3 ms once the
 * extension modules are in jiti's cache, so there is nothing to save.
 */
export async function buildAgentLoader(options: AgentLoaderOptions): Promise<DefaultResourceLoader> {
	const loader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir: options.agentDir,
		noExtensions: true,
		...(options.noContextFiles ? { noContextFiles: true } : {}),
		extensionFactories: [
			// Order is load-bearing, mirroring the main session's extension order:
			// hooks first (a hook's updatedInput must be what every guard judges),
			// then the worktree git-isolation guard, then the permission gate.
			...(options.getHookBridge ? [hookGateFactory(options.getHookBridge, { agentTypeOf: options.agentTypeOf, neverGate: options.neverGate })] : []),
			worktreeGuardFactory(options.cwd),
			permissionGateFactory(options.cwd, os.homedir(), options.neverGate, options.getPermissionBridge),
			...(options.extraFactories ?? []),
		],
		...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
		...(options.extraExtensionPaths ? { additionalExtensionPaths: options.extraExtensionPaths } : {}),
	});
	await loader.reload();
	return loader;
}

export interface OpenChildSessionOptions {
	/**
	 * The loader for this one session: options to build it, or one already built
	 * by `buildAgentLoader` and never used by a session (see buildAgentLoader:
	 * a disposed session leaves its loader dead).
	 */
	loader: AgentLoaderOptions | DefaultResourceLoader;
	/** Everything else `createAgentSession` takes: cwd, model, tools, customTools, sessionManager, … */
	session: Omit<CreateAgentSessionOptions, "resourceLoader" | "sessionStartEvent">;
	/**
	 * Why the child starts — a fresh run, a resume of a persisted child session,
	 * or a fork of the parent transcript. Handlers read it the way they read pi's
	 * own (file-tracker reconstructs its read state on `resume`/`fork`).
	 */
	startReason?: "startup" | "resume" | "fork";
	/**
	 * Where a child extension's handler errors go. An SDK session has no listener
	 * of its own, so without this a throwing child handler leaves no trace.
	 */
	onError?: (error: ExtensionError) => void;
}

/**
 * Build a fresh loader, create the session on it, and START it: `createAgentSession`
 * never emits `session_start` — pi emits it only from `bindExtensions`, which the
 * CLI modes call and an SDK caller must call itself (measured, LIFECYCLE-REVIEW
 * H2; identical in 0.84.1 and 0.85.0). Until this helper existed no child ever
 * saw the event, so every child ran without `# claudeMd` (claude-context), with
 * its deferred tools eager and unlisted (tool-search), without its tier's search
 * tools (search-tools) and without read-state reconstruction on a resume
 * (file-tracker). Binding also runs the child's `resources_discover` pass, the
 * way pi's own modes do.
 */
export async function openChildSession(options: OpenChildSessionOptions): Promise<AgentSession> {
	const loader = options.loader instanceof DefaultResourceLoader ? options.loader : await buildAgentLoader(options.loader);
	const { session } = await createAgentSession({
		...options.session,
		resourceLoader: loader,
		sessionStartEvent: { type: "session_start", reason: options.startReason ?? "startup" },
	});
	await session.bindExtensions({ onError: options.onError });
	return session;
}
