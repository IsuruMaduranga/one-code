/**
 * A minimal, in-memory stand-in for pi's ExtensionAPI/ExtensionContext, for
 * testing an extension's `index.ts` wiring (event handler sequencing, tool
 * registration, reminder/notification traffic) without a real pi runtime.
 *
 * Kept loosely typed on purpose (`as never` at the factory boundary, like the
 * existing `app-update-check.test.ts` / `model-default.test.ts` harnesses):
 * ExtensionContext has dozens of fields most extensions never touch, and a
 * fully-typed fake would need to track pi's whole interface instead of just
 * what these tests exercise.
 */

import { createEventBus, type EventBus } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";

export type FakeHandler = (event: unknown, ctx: unknown) => unknown;

export interface FakeToolDefinition {
	name: string;
	label?: string;
	description?: string;
	parameters?: unknown;
	execute: (
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<unknown>;
	[key: string]: unknown;
}

export interface FakeCommand {
	description?: string;
	handler: (args: string, ctx: unknown) => Promise<void>;
	[key: string]: unknown;
}

export interface SentMessage {
	message: { customType: string; content: unknown; display?: boolean; details?: unknown };
	options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" };
}

/** Everything an extension's `index.ts` can register or emit, captured for assertions. */
export interface FakePi {
	/** Pass this to the extension's default export: `myExtension(fakePi.pi as never)`. */
	pi: Record<string, unknown>;
	events: EventBus;
	handlers: Map<string, FakeHandler[]>;
	tools: Map<string, FakeToolDefinition>;
	commands: Map<string, FakeCommand>;
	messageRenderers: Map<string, unknown>;
	entryRenderers: Map<string, unknown>;
	sentMessages: SentMessage[];
	sentUserMessages: Array<{ content: unknown; options?: unknown }>;
	appendedEntries: Array<{ customType: string; data?: unknown }>;
	notified: string[];
	flags: Map<string, boolean | string>;
	getActiveTools: () => string[];
	setActiveTools: (names: string[]) => void;

	/** Run every handler registered for `event`, in registration order; returns their results. */
	fire<R = unknown>(event: string, payload: unknown, ctx?: unknown): Promise<R[]>;
	/** Run every handler for `event` and return the first non-undefined result. */
	fireOne<R = unknown>(event: string, payload: unknown, ctx?: unknown): Promise<R | undefined>;
}

export function createFakePi(): FakePi {
	const events = createEventBus();
	const handlers = new Map<string, FakeHandler[]>();
	const tools = new Map<string, FakeToolDefinition>();
	const commands = new Map<string, FakeCommand>();
	const messageRenderers = new Map<string, unknown>();
	const entryRenderers = new Map<string, unknown>();
	const sentMessages: SentMessage[] = [];
	const sentUserMessages: Array<{ content: unknown; options?: unknown }> = [];
	const appendedEntries: Array<{ customType: string; data?: unknown }> = [];
	const notified: string[] = [];
	const flags = new Map<string, boolean | string>();
	let activeTools: string[] = [];

	const on = (event: string, handler: FakeHandler) => {
		const list = handlers.get(event) ?? [];
		list.push(handler);
		handlers.set(event, list);
	};

	const pi: Record<string, unknown> = {
		on,
		events,
		registerTool: (tool: FakeToolDefinition) => {
			tools.set(tool.name, tool);
		},
		registerCommand: (name: string, options: FakeCommand) => {
			commands.set(name, options);
		},
		registerShortcut: vi.fn(),
		registerFlag: vi.fn((name: string, options: { default?: boolean | string }) => {
			if (options.default !== undefined) flags.set(name, options.default);
		}),
		getFlag: (name: string) => flags.get(name),
		registerMessageRenderer: (customType: string, renderer: unknown) => {
			messageRenderers.set(customType, renderer);
		},
		registerMarkdownTransformer: vi.fn(),
		registerEntryRenderer: (customType: string, renderer: unknown) => {
			entryRenderers.set(customType, renderer);
		},
		sendMessage: (message: SentMessage["message"], options?: SentMessage["options"]) => {
			sentMessages.push({ message, options });
		},
		sendUserMessage: (content: unknown, options?: unknown) => {
			sentUserMessages.push({ content, options });
		},
		appendEntry: (customType: string, data?: unknown) => {
			appendedEntries.push({ customType, data });
		},
		setSessionName: vi.fn(),
		getSessionName: vi.fn(() => undefined),
		setLabel: vi.fn(),
		exec: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
		getActiveTools: () => activeTools,
		getAllTools: () => [],
		setActiveTools: (names: string[]) => {
			activeTools = names;
		},
		getCommands: () => [],
		setModel: vi.fn(async () => true),
		getThinkingLevel: vi.fn(() => "medium"),
		setThinkingLevel: vi.fn(),
		registerProvider: vi.fn(),
		unregisterProvider: vi.fn(),
	};

	const fire = async <R,>(event: string, payload: unknown, ctx?: unknown): Promise<R[]> => {
		const list = handlers.get(event) ?? [];
		const results: R[] = [];
		for (const handler of list) results.push((await handler(payload, ctx ?? createFakeCtx())) as R);
		return results;
	};

	return {
		pi,
		events,
		handlers,
		tools,
		commands,
		messageRenderers,
		entryRenderers,
		sentMessages,
		sentUserMessages,
		appendedEntries,
		notified,
		flags,
		getActiveTools: () => activeTools,
		setActiveTools: (names: string[]) => {
			activeTools = names;
		},
		fire,
		fireOne: async <R,>(event: string, payload: unknown, ctx?: unknown) => (await fire<R>(event, payload, ctx))[0],
	};
}

/** A loose ExtensionContext stand-in; pass overrides for what a test cares about. */
export function createFakeCtx(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const notified: Array<{ message: string; type?: string }> = [];
	const ui = {
		select: vi.fn(async () => undefined),
		confirm: vi.fn(async () => false),
		input: vi.fn(async () => undefined),
		notify: vi.fn((message: string, type?: string) => {
			notified.push({ message, type });
		}),
		onTerminalInput: vi.fn(() => () => {}),
		setStatus: vi.fn(),
		setWorkingMessage: vi.fn(),
		setWorkingVisible: vi.fn(),
		setWorkingIndicator: vi.fn(),
		setHiddenThinkingLabel: vi.fn(),
		setWidget: vi.fn(),
		setFooter: vi.fn(),
		setHeader: vi.fn(),
		setTitle: vi.fn(),
		custom: vi.fn(async () => undefined),
		pasteToEditor: vi.fn(),
		setEditorText: vi.fn(),
		getEditorText: vi.fn(() => ""),
		editor: vi.fn(async () => undefined),
		addAutocompleteProvider: vi.fn(),
		setEditorComponent: vi.fn(),
		getEditorComponent: vi.fn(() => undefined),
		theme: {},
		getAllThemes: vi.fn(() => []),
		getTheme: vi.fn(() => undefined),
		setTheme: vi.fn(() => ({ success: true })),
		getToolsExpanded: vi.fn(() => false),
		setToolsExpanded: vi.fn(),
		...(overrides.ui as Record<string, unknown> | undefined),
	};

	const sessionManager = {
		getSessionId: () => "fake-session",
		getSessionFile: () => undefined,
		getSessionDir: () => undefined,
		getBranch: () => [],
		...(overrides.sessionManager as Record<string, unknown> | undefined),
	};

	const base: Record<string, unknown> = {
		ui,
		mode: "print",
		hasUI: false,
		cwd: process.cwd(),
		sessionManager,
		modelRegistry: {},
		model: undefined,
		scopedModels: [],
		thinkingLevel: undefined,
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: undefined,
		abort: vi.fn(),
		hasPendingMessages: () => false,
		shutdown: vi.fn(),
		getContextUsage: () => undefined,
		compact: vi.fn(),
		getSystemPrompt: () => "",
		_notified: notified,
	};

	return { ...base, ...overrides, ui };
}
