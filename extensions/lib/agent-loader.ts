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
import { DefaultResourceLoader, type InlineExtension, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { PermissionBridge } from "../permissions/subagent-gate.ts";
import { permissionGateFactory } from "./permission-gate.ts";

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

/** The canonical model/auth runtime, shared across all agents in a run (building one per agent is expensive). */
export function createSharedModelRuntime(agentDir: string): Promise<ModelRuntime> {
	return ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
	});
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
	 * prompts bubbled to the user); when absent (workflow runner, headless), the gate
	 * uses its fail-closed local fallback. A getter so it can be read lazily — the
	 * bridge may not be published yet when the loader is built.
	 */
	getPermissionBridge?: () => PermissionBridge | undefined;
}

/** Build and `reload()` a resource loader for an in-process agent session. */
export async function buildAgentLoader(options: AgentLoaderOptions): Promise<DefaultResourceLoader> {
	const loader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir: options.agentDir,
		noExtensions: true,
		extensionFactories: [
			permissionGateFactory(options.cwd, os.homedir(), options.neverGate, options.getPermissionBridge),
			...(options.extraFactories ?? []),
		],
		...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
		...(options.extraExtensionPaths ? { additionalExtensionPaths: options.extraExtensionPaths } : {}),
	});
	await loader.reload();
	return loader;
}
