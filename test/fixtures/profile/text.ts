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

/**
 * An object argument as JSON, but with the NUL character left raw: the base
 * finds where a value lands in a text by passing a NUL hole and searching for
 * it (lib/profile/template-probe.ts), which an escaped `\u0000` would hide.
 */
function shownObject(arg: object): string {
	return JSON.stringify(arg).replaceAll("\\u0000", "\u0000");
}

/** A marker with the arguments the base passed, so a test can see them placed. */
export function mark(path: string, ...args: unknown[]): string {
	const shown = args.map((arg) => (typeof arg === "string" ? arg : Array.isArray(arg) ? arg.map(String).join(", ") : typeof arg === "object" && arg !== null ? shownObject(arg) : String(arg)));
	return shown.length > 0 ? `[${path} ${shown.join(" | ")}]` : `[${path}]`;
}

export const systemPrompt: NonNullable<ProfileText["systemPrompt"]> = {
	scratchpadMoved: (p) => mark("systemPrompt.scratchpadMoved", p),
	lead: (session) => [mark("systemPrompt.lead", session)],
	tail: (session) => [mark("systemPrompt.tail", session)],
	memory: (dir, session) => mark("systemPrompt.memory", dir, session),
	toolList: (tools, guidelines) => mark("systemPrompt.toolList", tools, guidelines),
	cwdLine: (cwd) => mark("systemPrompt.cwdLine", cwd),
};

export const notebook: NonNullable<ProfileText["notebook"]> = {
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
	edited: (p) => mark("notebook.edited", p),
	failed: (p) => mark("notebook.failed", p),
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
	noInteractiveUi: "[askUser.noInteractiveUi]",
	answered: (answers) => mark("askUser.answered", answers),
	cancelled: (partial) => mark("askUser.cancelled", partial),
	declined: (questions) => mark("askUser.declined", questions),
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
	created: (task) => mark("tasks.created", task),
	details: (view) => mark("tasks.details", view),
	list: (views) => mark("tasks.list", views),
	notFound: (rawId) => mark("tasks.notFound", rawId),
	updated: (p) => mark("tasks.updated", p),
	deleted: (id) => mark("tasks.deleted", id),
	reminder: (tasks) => mark("tasks.reminder", tasks),
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
	reminder: (session) => mark("worktree.reminder", session),
	missingOnRestore: (session) => mark("worktree.missingOnRestore", session),
	activeMissing: (session) => mark("worktree.activeMissing", session),
	enter: {
		failed: (failure) => mark("worktree.enter.failed", failure),
		switched: (p) => mark("worktree.enter.switched", p),
		created: (p) => mark("worktree.enter.created", p),
	},
	exit: {
		noSession: "[worktree.exit.noSession]",
		kept: (p) => mark("worktree.exit.kept", p),
		notCreatedHere: (session) => mark("worktree.exit.notCreatedHere", session),
		removeRefused: (p) => mark("worktree.exit.removeRefused", p),
		removeFailed: (osMessage) => mark("worktree.exit.removeFailed", osMessage),
		branchDeleteFailed: (p) => mark("worktree.exit.branchDeleteFailed", p),
		removed: (session) => mark("worktree.exit.removed", session),
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
	urlRejected: (problem) => mark("webFetch.urlRejected", problem),
	cancelled: (url) => mark("webFetch.cancelled", url),
	failed: (p) => mark("webFetch.failed", p),
	redirect: (p) => mark("webFetch.redirect", p),
	header: (p) => mark("webFetch.header", p),
	page: {
		before: "[webFetch.page.before]",
		after: "[webFetch.page.after]",
		title: (title) => mark("webFetch.page.title", title),
	},
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
	cancelled: (query) => mark("webSearch.cancelled", query),
	nativeAnswer: (p) => mark("webSearch.nativeAnswer", p),
	providerAnswer: (p) => mark("webSearch.providerAnswer", p),
	chainResults: (p) => mark("webSearch.chainResults", p),
	attempt: (attempt) => mark("webSearch.attempt", attempt),
	failed: (p) => mark("webSearch.failed", p),
	nativeFellBack: (reason) => mark("webSearch.nativeFellBack", reason),
	providerFailed: (p) => mark("webSearch.providerFailed", p),
};

export const nativeWeb: NonNullable<ProfileText["nativeWeb"]> = {
	fetch: {
		system: "[nativeWeb.fetch.system]",
		user: (p) => mark("nativeWeb.fetch.user", p),
	},
	searchSystem: "[nativeWeb.searchSystem]",
	fallback: (fallback) => mark("nativeWeb.fallback", fallback),
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
	stubReason: "[btw.stubReason]",
};

export const recap: NonNullable<ProfileText["recap"]> = {
	prompt: "[recap.prompt]",
	stubReason: "[recap.stubReason]",
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
	entered: (planFile) => mark("planMode.entered", planFile),
	notInPlanMode: "[planMode.notInPlanMode]",
	emptyPlan: (planFile) => mark("planMode.emptyPlan", planFile),
	noApprover: (planFile) => mark("planMode.noApprover", planFile),
	approved: (p) => mark("planMode.approved", p),
	exited: (planFile) => mark("planMode.exited", planFile),
	reattached: (p) => mark("planMode.reattached", p),
};

export const skill: NonNullable<ProfileText["skill"]> = {
	withBaseDir: (p) => mark("skill.withBaseDir", p),
	description: "[skill.description]",
	promptSnippet: "[skill.promptSnippet]",
	params: {
		skill: "[skill.params.skill]",
		args: "[skill.params.args]",
		list: "[skill.params.list]",
	},
	listingHeader: "[skill.listingHeader]",
	readableListing: (p) => mark("skill.readableListing", p),
	available: (listing) => mark("skill.available", listing),
	noName: (listing) => mark("skill.noName", listing),
	notFound: (p) => mark("skill.notFound", p),
	ambiguous: (p) => mark("skill.ambiguous", p),
	off: (p) => mark("skill.off", p),
	userOnly: (name) => mark("skill.userOnly", name),
	manualOnly: (name) => mark("skill.manualOnly", name),
	readFailed: (p) => mark("skill.readFailed", p),
	launching: (name) => mark("skill.launching", name),
	missingArguments: (hint) => ({
		before: mark("skill.missingArguments.before", hint),
		after: mark("skill.missingArguments.after", hint),
	}),
};

export const mcp: NonNullable<ProfileText["mcp"]> = {
	needsAuthentication: (p) => mark("mcp.needsAuthentication", p),
	instructions: (servers) => mark("mcp.instructions", servers),
	instructionsCut: (head) => mark("mcp.instructionsCut", head),
	failed: (servers) => mark("mcp.failed", servers),
	failure: (failure) => mark("mcp.failure", failure),
	notices: {
		recovered: (names) => mark("mcp.notices.recovered", names),
		connected: (servers) => mark("mcp.notices.connected", servers),
		dropped: (names) => mark("mcp.notices.dropped", names),
		refreshFailed: (p) => mark("mcp.notices.refreshFailed", p),
		toolsChanged: (p) => mark("mcp.notices.toolsChanged", p),
	},
	tool: {
		description: (p) => mark("mcp.tool.description", p),
		descriptionCut: (p) => mark("mcp.tool.descriptionCut", p),
		notConnected: (server) => mark("mcp.tool.notConnected", server),
		gone: (p) => mark("mcp.tool.gone", p),
		schemaChanged: (name) => mark("mcp.tool.schemaChanged", name),
		callFailed: (osMessage) => mark("mcp.tool.callFailed", osMessage),
	},
	content: {
		imageUndecodable: (p) => mark("mcp.content.imageUndecodable", p),
		resource: (uri) => mark("mcp.content.resource", uri),
		other: (type) => mark("mcp.content.other", type),
		binaryResource: (p) => mark("mcp.content.binaryResource", p),
	},
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
		unknownServer: (p) => mark("mcp.resources.unknownServer", p),
		line: (p) => mark("mcp.resources.line", p),
		none: "[mcp.resources.none]",
		readFailed: (p) => mark("mcp.resources.readFailed", p),
		directoryEntry: (p) => mark("mcp.resources.directoryEntry", p),
		directoryEmpty: "[mcp.resources.directoryEmpty]",
		directoryFailed: (p) => mark("mcp.resources.directoryFailed", p),
	},
};

export const lsp: NonNullable<ProfileText["lsp"]> = {
	description: "[lsp.description]",
	params: {
		path: "[lsp.params.path]",
		severity: "[lsp.params.severity]",
	},
	projectCodeReason: (command) => mark("lsp.projectCodeReason", command),
	cancelled: "[lsp.cancelled]",
	noServer: (p) => mark("lsp.noServer", p),
	notConfigured: "[lsp.notConfigured]",
	failure: (failure) => mark("lsp.failure", failure),
	diagnostics: {
		none: "[lsp.diagnostics.none]",
		summary: (p) => mark("lsp.diagnostics.summary", p),
		line: (p) => mark("lsp.diagnostics.line", p),
		more: (count) => mark("lsp.diagnostics.more", count),
	},
	newDiagnostics: {
		entry: (diagnostic) => mark("lsp.newDiagnostics.entry", diagnostic),
		section: (p) => mark("lsp.newDiagnostics.section", p),
		more: (count) => mark("lsp.newDiagnostics.more", count),
		cut: (head) => mark("lsp.newDiagnostics.cut", head),
		block: (body) => mark("lsp.newDiagnostics.block", body),
	},
};

export const hooks: NonNullable<ProfileText["hooks"]> = {
	additionalContext: (p) => mark("hooks.additionalContext", p),
	blockReason: (block) => mark("hooks.blockReason", block),
	preToolUseBlocked: (p) => mark("hooks.preToolUseBlocked", p),
	postToolUseBlocked: (p) => mark("hooks.postToolUseBlocked", p),
	stopBlocked: (p) => mark("hooks.stopBlocked", p),
	fileChangedByHook: (p) => mark("hooks.fileChangedByHook", p),
};

export const memory: NonNullable<ProfileText["memory"]> = {
	indexNearLimit: (limits) => mark("memory.indexNearLimit", limits),
	indexOverLimit: (limits) => mark("memory.indexOverLimit", limits),
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
		created: (p) => mark("background.cron.created", p),
		createFailed: (failure) => mark("background.cron.createFailed", failure),
		list: (p) => mark("background.cron.list", p),
		deleted: (p) => mark("background.cron.deleted", p),
		unknownJob: (p) => mark("background.cron.unknownJob", p),
		neverFires: "[background.cron.neverFires]",
		notOwner: (p) => mark("background.cron.notOwner", p),
		blockingRunRefusal: "[background.cron.blockingRunRefusal]",
		storeMissing: "[background.cron.storeMissing]",
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
		scheduled: (p) => mark("background.wakeup.scheduled", p),
		missing: (field) => mark("background.wakeup.missing", field),
		agedOut: "[background.wakeup.agedOut]",
		stopped: (p) => mark("background.wakeup.stopped", p),
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
		startFailed: (failure) => mark("background.monitor.startFailed", failure),
		started: (p) => mark("background.monitor.started", p),
		ranToEnd: (p) => mark("background.monitor.ranToEnd", p),
		noEvents: "[background.monitor.noEvents]",
		noOutput: "[background.monitor.noOutput]",
		spoolLost: (p) => mark("background.monitor.spoolLost", p),
		earlierTruncated: "[background.monitor.earlierTruncated]",
		moreLines: (p) => mark("background.monitor.moreLines", p),
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
		unknownTask: (p) => mark("background.tasks.unknownTask", p),
		taskLine: (task) => mark("background.tasks.taskLine", task),
		noOutputYet: "[background.tasks.noOutputYet]",
		clippedHeader: (p) => mark("background.tasks.clippedHeader", p),
		alreadyEnded: (p) => mark("background.tasks.alreadyEnded", p),
		residentEnded: (p) => mark("background.tasks.residentEnded", p),
		stopRequested: (p) => mark("background.tasks.stopRequested", p),
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
	storeBusy: (busy) => mark("artifacts.storeBusy", busy),
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
	noMatch: (p) => mark("artifacts.noMatch", p),
	emptyList: "[artifacts.emptyList]",
	listLine: (artifact) => mark("artifacts.listLine", artifact),
	list: (p) => mark("artifacts.list", p),
	noBrowserReason: (reason) => mark("artifacts.noBrowserReason", reason),
	openedGallery: (p) => mark("artifacts.openedGallery", p),
	opened: (p) => mark("artifacts.opened", p),
	deleteNeedsId: "[artifacts.deleteNeedsId]",
	unknownForDelete: (p) => mark("artifacts.unknownForDelete", p),
	deleteNeedsUser: "[artifacts.deleteNeedsUser]",
	deleteAborted: "[artifacts.deleteAborted]",
	deleteDeclined: "[artifacts.deleteDeclined]",
	deleted: (p) => mark("artifacts.deleted", p),
	publishProblem: (problem) => mark("artifacts.publishProblem", problem),
	published: (p) => mark("artifacts.published", p),
};

export const toolStyle: NonNullable<ProfileText["toolStyle"]> = {
	writeDescription: (form) => mark("toolStyle.writeDescription", form),
	editDescription: (p) => mark("toolStyle.editDescription", p),
};

export const contextBudget: NonNullable<ProfileText["contextBudget"]> = {
	tokensLeft: (p) => mark("contextBudget.tokensLeft", p),
	clearAtNudge: "[contextBudget.clearAtNudge]",
};

export const fileTracker: NonNullable<ProfileText["fileTracker"]> = {
	toolResult: (outcome) => mark("fileTracker.toolResult", outcome),
	unread: (p) => mark("fileTracker.unread", p),
	stale: (p) => mark("fileTracker.stale", p),
	changedOnDisk: (p) => mark("fileTracker.changedOnDisk", p),
	changedByAgent: (p) => mark("fileTracker.changedByAgent", p),
	moreChanged: (p) => mark("fileTracker.moreChanged", p),
	deleted: (p) => mark("fileTracker.deleted", p),
	changedWhileAway: (p) => mark("fileTracker.changedWhileAway", p),
	restoredCall: (p) => mark("fileTracker.restoredCall", p),
	restoredResult: (p) => mark("fileTracker.restoredResult", p),
	tooLargeToRestore: (p) => mark("fileTracker.tooLargeToRestore", p),
};

export const compaction: NonNullable<ProfileText["compaction"]> = {
	instruction: (p) => mark("compaction.instruction", p),
	continuation: (p) => mark("compaction.continuation", p),
	standaloneSystemPrompt: "[compaction.standaloneSystemPrompt]",
	clearedResult: (p) => mark("compaction.clearedResult", p),
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
	refused: (refusal) => mark("workflow.refused", refusal),
	scriptProblem: (problem) => mark("workflow.scriptProblem", problem),
	callProblem: (problem) => mark("workflow.callProblem", problem),
	agentFailure: (failure) => mark("workflow.agentFailure", failure),
	runStop: (stop) => mark("workflow.runStop", stop),
	determinism: {
		random: "[workflow.determinism.random]",
		dateNoArgs: "[workflow.determinism.dateNoArgs]",
		dateCall: "[workflow.determinism.dateCall]",
		dateNow: "[workflow.determinism.dateNow]",
	},
	started: (p) => mark("workflow.started", p),
	ranToEnd: (p) => mark("workflow.ranToEnd", p),
	report: (report) => mark("workflow.report", report),
	resultTruncated: "[workflow.resultTruncated]",
	defaultAgentLabel: (p) => mark("workflow.defaultAgentLabel", p),
	notice: (notice) => mark("workflow.notice", notice),
	progress: {
		replayed: "[workflow.progress.replayed]",
		outputTokens: (p) => mark("workflow.progress.outputTokens", p),
		worktreeKept: (p) => mark("workflow.progress.worktreeKept", p),
		agentAborted: "[workflow.progress.agentAborted]",
		agentFailed: (p) => mark("workflow.progress.agentFailed", p),
	},
	agentPrompt: (p) => mark("workflow.agentPrompt", p),
	structuredNudge: "[workflow.structuredNudge]",
	structuredOutputTool: {
		description: "[workflow.structuredOutputTool.description]",
		received: "[workflow.structuredOutputTool.received]",
	},
};

export const autoMode: NonNullable<ProfileText["autoMode"]> = {
	systemNote: (p) => mark("autoMode.systemNote", p),
	permissionGranted: (p) => mark("autoMode.permissionGranted", p),
	classifierBlock: (block) => mark("autoMode.classifierBlock", block),
	floorReason: (target) => mark("autoMode.floorReason", target),
	floorBlock: (target) => mark("autoMode.floorBlock", target),
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
	blocked: (block) => mark("shell.blocked", block),
	exitCode: (p) => mark("shell.exitCode", p),
	noBackgroundShell: (p) => mark("shell.noBackgroundShell", p),
	backgroundStarted: (p) => mark("shell.backgroundStarted", p),
	finish: (end) => mark("shell.finish", end),
	failureDetail: (end) => mark("shell.failureDetail", end),
	ranToEnd: (p) => mark("shell.ranToEnd", p),
	emptyOutput: "[shell.emptyOutput]",
	earlierTruncated: "[shell.earlierTruncated]",
	spoolLost: (p) => mark("shell.spoolLost", p),
};

export const doctor: NonNullable<ProfileText["doctor"]> = {
	fixPrompt: (input) => mark("doctor.fixPrompt", input),
};

export const notifications: NonNullable<ProfileText["notifications"]> = {
	agentMessage: {
		opener: "[notifications.agentMessage.opener]",
		openerMidTurn: "[notifications.agentMessage.openerMidTurn]",
		guard: "[notifications.agentMessage.guard]",
		replyHint: "[notifications.agentMessage.replyHint]",
		handBackPreamble: "[notifications.agentMessage.handBackPreamble]",
	},
	agentNote: "[notifications.agentNote]",
	handBackPointer: (p) => mark("notifications.handBackPointer", p),
	handBackWarning: (p) => mark("notifications.handBackWarning", p),
	summary: (summary) => mark("notifications.summary", summary),
	preamble: {
		alone: "[notifications.preamble.alone]",
		withUserTurn: "[notifications.preamble.withUserTurn]",
	},
	oneShotSession: "[notifications.oneShotSession]",
	interactiveSession: "[notifications.interactiveSession]",
	oneShotNote: (work) => mark("notifications.oneShotNote", work),
	localCommandCaveat: "[notifications.localCommandCaveat]",
	userMessageMidTurn: (p) => mark("notifications.userMessageMidTurn", p),
};

export const toolResults: NonNullable<ProfileText["toolResults"]> = {
	empty: (p) => mark("toolResults.empty", p),
	noFilesFound: "[toolResults.noFilesFound]",
	persisted: (p) => mark("toolResults.persisted", p),
	previewHeading: (p) => mark("toolResults.previewHeading", p),
	userDenial: (p) => mark("toolResults.userDenial", p),
	secretPlaceholderWrite: "[toolResults.secretPlaceholderWrite]",
};

export const toolCallCorruption: NonNullable<ProfileText["toolCallCorruption"]> = {
	damage: (damage) => mark("toolCallCorruption.damage", damage),
	suspectBlock: (p) => mark("toolCallCorruption.suspectBlock", p),
	corruptBlock: (p) => mark("toolCallCorruption.corruptBlock", p),
};

export const context: NonNullable<ProfileText["context"]> = {
	memoryIndexCut: (p) => mark("context.memoryIndexCut", p),
	instructionsPreamble: "[context.instructionsPreamble]",
	section: (p) => mark("context.section", p),
	productPreamble: (p) => mark("context.productPreamble", p),
	nestedFile: (p) => mark("context.nestedFile", p),
	contextPreamble: "[context.contextPreamble]",
	email: (p) => mark("context.email", p),
	contextFooter: "[context.contextFooter]",
	date: (p) => mark("context.date", p),
	dateChanged: (p) => mark("context.dateChanged", p),
	environment: (env) => mark("context.environment", env),
	modelLine: (p) => mark("context.modelLine", p),
	gitStatus: (p) => mark("context.gitStatus", p),
	gitStatusClipped: (p) => mark("context.gitStatusClipped", p),
	changedSinceSnapshot: (p) => mark("context.changedSinceSnapshot", p),
	skippedInstruction: (p) => mark("context.skippedInstruction", p),
	classifierSkippedInstruction: (p) => mark("context.classifierSkippedInstruction", p),
};

export const toolSearch: NonNullable<ProfileText["toolSearch"]> = {
	description: "[toolSearch.description]",
	promptSnippet: "[toolSearch.promptSnippet]",
	params: {
		query: "[toolSearch.params.query]",
		maxResults: "[toolSearch.params.maxResults]",
	},
	result: (outcome) => mark("toolSearch.result", outcome),
	noMatch: (p) => mark("toolSearch.noMatch", p),
	toolLoaded: "[toolSearch.toolLoaded]",
	listingHead: "[toolSearch.listingHead]",
	addendumHead: "[toolSearch.addendumHead]",
	removedHead: "[toolSearch.removedHead]",
	toolsAvailable: "[toolSearch.toolsAvailable]",
	missReminder: (p) => mark("toolSearch.missReminder", p),
	withheldMiss: (p) => mark("toolSearch.withheldMiss", p),
	unavailable: (p) => mark("toolSearch.unavailable", p),
	loaderUnavailable: "[toolSearch.loaderUnavailable]",
};

export const permissions: NonNullable<ProfileText["permissions"]> = {
	refused: (refusal) => mark("permissions.refused", refusal),
	modeChanged: (p) => mark("permissions.modeChanged", p),
	autoModeActive: "[permissions.autoModeActive]",
	reviewFailed: (p) => mark("permissions.reviewFailed", p),
};

export const handback: NonNullable<ProfileText["handback"]> = {
	description: "[handback.description]",
	messageParam: "[handback.messageParam]",
	reminder: "[handback.reminder]",
	loadFirst: "[handback.loadFirst]",
	delivered: "[handback.delivered]",
	alreadyDelivered: (p) => mark("handback.alreadyDelivered", p),
	empty: "[handback.empty]",
};

export const subagents: NonNullable<ProfileText["subagents"]> = {
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
	catalogRow: (p) => mark("subagents.catalogRow", p),
	forkRow: "[subagents.forkRow]",
	catalogList: (p) => mark("subagents.catalogList", p),
	catalogBlock: (p) => mark("subagents.catalogBlock", p),
	refused: (refusal) => mark("subagents.refused", refusal),
	runtimeProblem: (problem) => mark("subagents.runtimeProblem", problem),
	failure: (failure) => mark("subagents.failure", failure),
	noOutput: "[subagents.noOutput]",
	modelFallback: (p) => mark("subagents.modelFallback", p),
	renamed: (p) => mark("subagents.renamed", p),
	unusableTools: (p) => mark("subagents.unusableTools", p),
	worktreeRefused: (p) => mark("subagents.worktreeRefused", p),
	worktreeKept: (p) => mark("subagents.worktreeKept", p),
	worktreeRunning: (p) => mark("subagents.worktreeRunning", p),
	stats: (p) => mark("subagents.stats", p),
	inlineReport: (p) => mark("subagents.inlineReport", p),
	launched: (p) => mark("subagents.launched", p),
	launchLine: (line) => mark("subagents.launchLine", line),
	sendMessageDescription: "[subagents.sendMessageDescription]",
	sendMessageParams: {
		to: "[subagents.sendMessageParams.to]",
		message: "[subagents.sendMessageParams.message]",
		summary: "[subagents.sendMessageParams.summary]",
	},
	steered: (p) => mark("subagents.steered", p),
	nextTurn: (p) => mark("subagents.nextTurn", p),
	sentToResident: (p) => mark("subagents.sentToResident", p),
	sent: (p) => mark("subagents.sent", p),
	inlineReply: (p) => mark("subagents.inlineReply", p),
	relocated: (p) => mark("subagents.relocated", p),
	listAgentsDescription: "[subagents.listAgentsDescription]",
	noAgents: "[subagents.noAgents]",
	agentList: (p) => mark("subagents.agentList", p),
	agentRow: (p) => mark("subagents.agentRow", p),
	toMain: {
		description: "[subagents.toMain.description]",
		params: {
			to: "[subagents.toMain.params.to]",
			message: "[subagents.toMain.params.message]",
			summary: "[subagents.toMain.params.summary]",
		},
		delivered: "[subagents.toMain.delivered]",
	},
	fromSubagent: (p) => mark("subagents.fromSubagent", p),
	forkTask: (p) => mark("subagents.forkTask", p),
	parentMode: (p) => mark("subagents.parentMode", p),
	pendingClaim: (p) => mark("subagents.pendingClaim", p),
	runningAfterCompaction: (p) => mark("subagents.runningAfterCompaction", p),
	delegationSteer: "[subagents.delegationSteer]",
	delegationWithdrawn: "[subagents.delegationWithdrawn]",
	reviewTimedOut: "[subagents.reviewTimedOut]",
};

export const plugins: NonNullable<ProfileText["plugins"]> = {
	placeholderFailed: (p) => mark("plugins.placeholderFailed", p),
	noBash: "[plugins.noBash]",
	placeholderTimedOut: (p) => mark("plugins.placeholderTimedOut", p),
	outputCut: (p) => mark("plugins.outputCut", p),
};

export const subagentModels: NonNullable<ProfileText["subagentModels"]> = {
	notice: (notice) => mark("subagentModels.notice", notice),
	runsOn: (p) => mark("subagentModels.runsOn", p),
	costsMore: (p) => mark("subagentModels.costsMore", p),
	menuLine: (p) => mark("subagentModels.menuLine", p),
	defaultCostsMore: (p) => mark("subagentModels.defaultCostsMore", p),
	settingPinned: (p) => mark("subagentModels.settingPinned", p),
	refused: (p) => mark("subagentModels.refused", p),
	menu: (p) => mark("subagentModels.menu", p),
};

export const worktreeGuard: NonNullable<ProfileText["worktreeGuard"]> = {
	refusal: (refusal) => mark("worktreeGuard.refusal", refusal),
};
