/**
 * The fixture profile's text: every group the contract names, each string a
 * marker naming its place (`[group.member]`, with any arguments after it), so
 * a base test sees where the base put a word without depending on any
 * product's wording. Text the base parses or relies on has real structure
 * where it must (the classifier ruleset's headings).
 *
 * Paths here are relative to `profile/`: the base suite runs on a copy of
 * the repository with this folder in place of One Code's profile
 * (scripts/test-base.sh).
 */

import type { ProfileText } from "../extensions/sdk/profile.ts";

/** A marker with the arguments the base passed, so a test can see them placed. */
export function mark(path: string, ...args: unknown[]): string {
	const shown = args.map((arg) => (typeof arg === "string" ? arg : Array.isArray(arg) ? arg.map(String).join(", ") : typeof arg === "object" && arg !== null ? JSON.stringify(arg) : String(arg)));
	return shown.length > 0 ? `[${path} ${shown.join(" | ")}]` : `[${path}]`;
}

export const systemPrompt: NonNullable<ProfileText["systemPrompt"]> = {
	lead: (session) => [mark("systemPrompt.lead", session)],
	tail: (session) => [mark("systemPrompt.tail", session)],
	memory: (dir, session) => mark("systemPrompt.memory", dir, session),
};

export const notebook: NonNullable<ProfileText["notebook"]> = {
	pathAlias: "[notebook.pathAlias]",
	description: "[notebook.description]",
	searchKeywords: ["[notebook.searchKeywords]"],
	params: {
		path: "[notebook.params.path]",
		notebook_path: "[notebook.params.notebook_path]",
		edit_mode: "[notebook.params.edit_mode]",
		cell_id: "[notebook.params.cell_id]",
		new_source: "[notebook.params.new_source]",
		cell_type: "[notebook.params.cell_type]",
	},
};

export const askUser: NonNullable<ProfileText["askUser"]> = {
	description: (form) => mark("askUser.description", form),
	promptSnippet: "[askUser.promptSnippet]",
	params: {
		questions: "[askUser.params.questions]",
		question: "[askUser.params.question]",
		header: "[askUser.params.header]",
		options: "[askUser.params.options]",
		multiSelect: "[askUser.params.multiSelect]",
		label: "[askUser.params.label]",
		optionDescription: "[askUser.params.optionDescription]",
		preview: "[askUser.params.preview]",
	},
};

export const tasks: NonNullable<ProfileText["tasks"]> = {
	descriptions: {
		task_create: "[tasks.descriptions.task_create]",
		task_get: "[tasks.descriptions.task_get]",
		task_list: "[tasks.descriptions.task_list]",
		task_update: "[tasks.descriptions.task_update]",
	},
	params: {
		create: {
			subject: "[tasks.params.create.subject]",
			description: "[tasks.params.create.description]",
			activeForm: "[tasks.params.create.activeForm]",
			metadata: "[tasks.params.create.metadata]",
		},
		get: {
			taskId: "[tasks.params.get.taskId]",
		},
		update: {
			subject: "[tasks.params.update.subject]",
			description: "[tasks.params.update.description]",
			activeForm: "[tasks.params.update.activeForm]",
			metadata: "[tasks.params.update.metadata]",
			taskId: "[tasks.params.update.taskId]",
			status: "[tasks.params.update.status]",
			addBlocks: "[tasks.params.update.addBlocks]",
			addBlockedBy: "[tasks.params.update.addBlockedBy]",
			owner: "[tasks.params.update.owner]",
		},
	},
	searchKeywords: ["[tasks.searchKeywords]"],
};

export const worktree: NonNullable<ProfileText["worktree"]> = {
	descriptions: {
		enter_worktree: (configDir) => mark("worktree.descriptions.enter_worktree", configDir),
		exit_worktree: "[worktree.descriptions.exit_worktree]",
	},
	params: {
		enter: {
			path: "[worktree.params.enter.path]",
			name: "[worktree.params.enter.name]",
		},
		exit: {
			action: "[worktree.params.exit.action]",
			discard_changes: "[worktree.params.exit.discard_changes]",
		},
	},
	searchKeywords: {
		enter_worktree: ["[worktree.searchKeywords.enter_worktree]"],
		exit_worktree: ["[worktree.searchKeywords.exit_worktree]"],
	},
};

export const webFetch: NonNullable<ProfileText["webFetch"]> = {
	description: (form) => mark("webFetch.description", form),
	params: {
		url: "[webFetch.params.url]",
		prompt: "[webFetch.params.prompt]",
		offset: "[webFetch.params.offset]",
		max_chars: (defaultChars) => mark("webFetch.params.max_chars", defaultChars),
	},
	searchKeywords: ["[webFetch.searchKeywords]"],
	reader: {
		system: "[webFetch.reader.system]",
		user: (p) => mark("webFetch.reader.user", p),
	},
};

export const webSearch: NonNullable<ProfileText["webSearch"]> = {
	description: (form) => mark("webSearch.description", form),
	params: {
		query: "[webSearch.params.query]",
		allowed_domains: "[webSearch.params.allowed_domains]",
		blocked_domains: "[webSearch.params.blocked_domains]",
	},
	searchKeywords: ["[webSearch.searchKeywords]"],
};

export const nativeWeb: NonNullable<ProfileText["nativeWeb"]> = {
	fetch: {
		system: "[nativeWeb.fetch.system]",
		user: (p) => mark("nativeWeb.fetch.user", p),
	},
	searchSystem: "[nativeWeb.searchSystem]",
};

export const sessionTitle: NonNullable<ProfileText["sessionTitle"]> = {
	system: "[sessionTitle.system]",
	user: (sessionText) => mark("sessionTitle.user", sessionText),
};

export const init: NonNullable<ProfileText["init"]> = {
	prompt: (file) => mark("init.prompt", file),
};

export const btw: NonNullable<ProfileText["btw"]> = {
	question: (question) => mark("btw.question", question),
};

export const recap: NonNullable<ProfileText["recap"]> = {
	prompt: "[recap.prompt]",
};

export const effort: NonNullable<ProfileText["effort"]> = {
	ultracodeOn: "[effort.ultracodeOn]",
	ultracodeOff: "[effort.ultracodeOff]",
};

export const planMode: NonNullable<ProfileText["planMode"]> = {
	descriptions: {
		enter_plan_mode: (form) => mark("planMode.descriptions.enter_plan_mode", form),
		exit_plan_mode: "[planMode.descriptions.exit_plan_mode]",
	},
	reminder: (p) => mark("planMode.reminder", p),
};

export const skill: NonNullable<ProfileText["skill"]> = {
	description: "[skill.description]",
	promptSnippet: "[skill.promptSnippet]",
	params: {
		skill: "[skill.params.skill]",
		args: "[skill.params.args]",
		list: "[skill.params.list]",
	},
};

export const mcp: NonNullable<ProfileText["mcp"]> = {
	resources: {
		descriptions: {
			list_mcp_resources: "[mcp.resources.descriptions.list_mcp_resources]",
			read_mcp_resource: "[mcp.resources.descriptions.read_mcp_resource]",
			read_mcp_resource_dir: "[mcp.resources.descriptions.read_mcp_resource_dir]",
		},
		params: {
			list: {
				server: "[mcp.resources.params.list.server]",
			},
			read: {
				server: "[mcp.resources.params.read.server]",
				uri: "[mcp.resources.params.read.uri]",
			},
			dir: {
				server: "[mcp.resources.params.dir.server]",
				uri: "[mcp.resources.params.dir.uri]",
			},
		},
		searchKeywords: ["[mcp.resources.searchKeywords]"],
	},
};

export const lsp: NonNullable<ProfileText["lsp"]> = {
	description: "[lsp.description]",
	params: {
		path: "[lsp.params.path]",
		severity: "[lsp.params.severity]",
	},
};

export const background: NonNullable<ProfileText["background"]> = {
	cron: {
		createDescription: (p) => mark("background.cron.createDescription", p),
		createParams: (p) => ({
			cron: mark("background.cron.createParams.cron", p),
			prompt: mark("background.cron.createParams.prompt", p),
			recurring: mark("background.cron.createParams.recurring", p),
			durable: mark("background.cron.createParams.durable", p),
		}),
		listDescription: "[background.cron.listDescription]",
		deleteDescription: "[background.cron.deleteDescription]",
		deleteIdParam: "[background.cron.deleteIdParam]",
	},
	wakeup: {
		description: "[background.wakeup.description]",
		params: {
			delaySeconds: "[background.wakeup.params.delaySeconds]",
			reason: "[background.wakeup.params.reason]",
			prompt: "[background.wakeup.params.prompt]",
			stop: "[background.wakeup.params.stop]",
			noop: "[background.wakeup.params.noop]",
		},
	},
	monitor: {
		description: "[background.monitor.description]",
		params: (p) => ({
			command: mark("background.monitor.params.command", p),
			description: mark("background.monitor.params.description", p),
			persistent: mark("background.monitor.params.persistent", p),
			timeoutMs: mark("background.monitor.params.timeoutMs", p),
			ws: mark("background.monitor.params.ws", p),
		}),
	},
	tasks: {
		outputDescription: "[background.tasks.outputDescription]",
		outputParams: {
			taskId: "[background.tasks.outputParams.taskId]",
			block: "[background.tasks.outputParams.block]",
			timeout: "[background.tasks.outputParams.timeout]",
		},
		stopDescription: "[background.tasks.stopDescription]",
		stopParams: {
			taskId: "[background.tasks.stopParams.taskId]",
		},
	},
	loop: {
		skillBody: (p) => mark("background.loop.skillBody", p),
		tick: (tick) => mark("background.loop.tick", tick),
		loopFileTick: (p) => mark("background.loop.loopFileTick", p),
		withPreamble: (p) => mark("background.loop.withPreamble", p),
		foldNote: (p) => mark("background.loop.foldNote", p),
	},
};

export const artifacts: NonNullable<ProfileText["artifacts"]> = {
	description: "[artifacts.description]",
	params: {
		action: "[artifacts.params.action]",
		filePath: "[artifacts.params.filePath]",
		title: "[artifacts.params.title]",
		description: "[artifacts.params.description]",
		id: "[artifacts.params.id]",
		url: "[artifacts.params.url]",
		limit: "[artifacts.params.limit]",
	},
};

export const toolStyle: NonNullable<ProfileText["toolStyle"]> = {
	writeDescription: (form) => mark("toolStyle.writeDescription", form),
	editDescription: (p) => mark("toolStyle.editDescription", p),
};

export const compaction: NonNullable<ProfileText["compaction"]> = {
	instruction: (p) => mark("compaction.instruction", p),
	continuation: (p) => mark("compaction.continuation", p),
	standaloneSystemPrompt: "[compaction.standaloneSystemPrompt]",
};

export const workflow: NonNullable<ProfileText["workflow"]> = {
	description: (p) => mark("workflow.description", p),
	params: (p) => ({
		script: mark("workflow.params.script", p),
		name: mark("workflow.params.name", p),
		args: mark("workflow.params.args", p),
		scriptPath: mark("workflow.params.scriptPath", p),
		resumeFromRunId: mark("workflow.params.resumeFromRunId", p),
		tokenBudget: mark("workflow.params.tokenBudget", p),
		sync: mark("workflow.params.sync", p),
	}),
	promptSnippet: "[workflow.promptSnippet]",
	ultracodeReminder: "[workflow.ultracodeReminder]",
	agentPrompt: (p) => mark("workflow.agentPrompt", p),
	structuredOutputTool: {
		description: "[workflow.structuredOutputTool.description]",
	},
};

export const autoMode: NonNullable<ProfileText["autoMode"]> = {
	systemNote: (p) => mark("autoMode.systemNote", p),
};

export const classifier: NonNullable<ProfileText["classifier"]> = {
	stage2IntentAddendum: "[classifier.stage2IntentAddendum]",
	stage2DenialAddendum: "[classifier.stage2DenialAddendum]",
	reviewAddendum: "[classifier.reviewAddendum]",
	resolvedPathsNote: "[classifier.resolvedPathsNote]",
	userDenyRule: (name, spec) => mark("classifier.userDenyRule", name, spec),
	// The rule lists keep the headings and bullet form the base reads (ClassifierRuleset).
	rulesetHead: "[classifier.rulesetHead]\n\n## Environment\n",
	hardSection: "\n\n## HARD BLOCK\n- Fixture Hard Rule: [classifier.hardSection]",
	softSection: "\n\n## SOFT BLOCK\n- Fixture Soft Rule: [classifier.softSection]",
	allowSection: "\n\n## ALLOW (exceptions)\n- Fixture Allow Rule: [classifier.allowSection]",
	rulesetTail: "\n\n## Fixture tail\n[classifier.rulesetTail]",
	defaultEnvironment: ["**Fixture slot**: [classifier.defaultEnvironment]"],
	sessionContext: "[classifier.sessionContext __USERNAME__]",
	instructionsFraming: {
		prefix: "[classifier.instructionsFraming.prefix]",
		suffix: "[classifier.instructionsFraming.suffix]",
	},
	stage1Final: "[classifier.stage1Final]",
	stage2Final: "[classifier.stage2Final]",
};

export const autoModeSetup: NonNullable<ProfileText["autoModeSetup"]> = {
	system: "[autoModeSetup.system]",
	usageOptions: ["[autoModeSetup.usageOptions]"],
	defaultsHeading: "[autoModeSetup.defaultsHeading]",
	factsHeading: "[autoModeSetup.factsHeading]",
	notes: {
		probeFailed: (what, command, error) => mark("autoModeSetup.notes.probeFailed", what, command, error),
		unreadable: (what, error) => mark("autoModeSetup.notes.unreadable", what, error),
		visibilityUnknown: "[autoModeSetup.notes.visibilityUnknown]",
		noShellHistory: "[autoModeSetup.notes.noShellHistory]",
		historyDeclined: "[autoModeSetup.notes.historyDeclined]",
		allowUnreadable: "[autoModeSetup.notes.allowUnreadable]",
	},
};

export const shell: NonNullable<ProfileText["shell"]> = {
	powershellPrimary: "[shell.powershellPrimary]",
	bashDescription: (p) => mark("shell.bashDescription", p),
	bashParams: {
		command: "[shell.bashParams.command]",
		timeout: "[shell.bashParams.timeout]",
		description: "[shell.bashParams.description]",
		run_in_background: "[shell.bashParams.run_in_background]",
	},
	powershellDescription: (p) => mark("shell.powershellDescription", p),
	powershellParams: {
		command: "[shell.powershellParams.command]",
		timeout: "[shell.powershellParams.timeout]",
		description: "[shell.powershellParams.description]",
		run_in_background: "[shell.powershellParams.run_in_background]",
	},
};

export const doctor: NonNullable<ProfileText["doctor"]> = {
	fixPrompt: (input) => mark("doctor.fixPrompt", input),
};

export const notifications: NonNullable<ProfileText["notifications"]> = {
	agentMessage: {
		opener: "[notifications.agentMessage.opener]",
		openerMidTurn: "[notifications.agentMessage.openerMidTurn]",
		guard: "[notifications.agentMessage.guard]",
	},
	midTurnNote: "[notifications.midTurnNote]",
};

export const context: NonNullable<ProfileText["context"]> = {
	productPreamble: (p) => mark("context.productPreamble", p),
	descriptors: { product: "[context.descriptors.product]", productGlobal: "[context.descriptors.productGlobal]" },
};

export const toolSearch: NonNullable<ProfileText["toolSearch"]> = {
	description: "[toolSearch.description]",
	promptSnippet: "[toolSearch.promptSnippet]",
	params: {
		query: "[toolSearch.params.query]",
		maxResults: "[toolSearch.params.maxResults]",
	},
};

export const handback: NonNullable<ProfileText["handback"]> = {
	description: "[handback.description]",
	messageParam: "[handback.messageParam]",
};

export const subagents: NonNullable<ProfileText["subagents"]> = {
	toolNamesHint: "[subagents.toolNamesHint]",
	taskAliasNote: "[subagents.taskAliasNote]",
	agentDescription: (p) => mark("subagents.agentDescription", p),
	agentPromptSnippet: "[subagents.agentPromptSnippet]",
	agentParams: {
		subagent_type: "[subagents.agentParams.subagent_type]",
		task: "[subagents.agentParams.task]",
		prompt: "[subagents.agentParams.prompt]",
		description: "[subagents.agentParams.description]",
		name: "[subagents.agentParams.name]",
		model: "[subagents.agentParams.model]",
		allow_expensive: "[subagents.agentParams.allow_expensive]",
		thinking: "[subagents.agentParams.thinking]",
		isolation: "[subagents.agentParams.isolation]",
		action: "[subagents.agentParams.action]",
	},
	nestedAgentDescription: (p) => mark("subagents.nestedAgentDescription", p),
	nestedAgentParams: {
		subagent_type: "[subagents.nestedAgentParams.subagent_type]",
		task: "[subagents.nestedAgentParams.task]",
		prompt: "[subagents.nestedAgentParams.prompt]",
		description: "[subagents.nestedAgentParams.description]",
		name: "[subagents.nestedAgentParams.name]",
	},
	sendMessageDescription: "[subagents.sendMessageDescription]",
	sendMessageParams: {
		to: "[subagents.sendMessageParams.to]",
		message: "[subagents.sendMessageParams.message]",
		summary: "[subagents.sendMessageParams.summary]",
	},
	listAgentsDescription: "[subagents.listAgentsDescription]",
	toMain: {
		description: "[subagents.toMain.description]",
		params: {
			to: "[subagents.toMain.params.to]",
			message: "[subagents.toMain.params.message]",
			summary: "[subagents.toMain.params.summary]",
		},
	},
	forkTask: (p) => mark("subagents.forkTask", p),
	delegationSteer: "[subagents.delegationSteer]",
	delegationWithdrawn: "[subagents.delegationWithdrawn]",
};

export const subagentModels: NonNullable<ProfileText["subagentModels"]> = {
	aliasTier: "[subagentModels.aliasTier]",
};

