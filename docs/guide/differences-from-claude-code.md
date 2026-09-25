# Differences from Claude Code

[← One Code user guide](README.md)

One Code recreates Claude Code's workflow on the pi agent harness with your
choice of model. Most of what you know carries over. This page lists what
is deliberately different, what isn't provided, and the known limitations,
so nothing surprises you.

## What is the same

- Your `CLAUDE.md`, skills, commands, agents, plugins, hooks, permission
  rules, and MCP configuration are read from the same files, in the same
  formats. See [Bring your Claude Code setup](bring-your-claude-code-setup.md).
- The system prompt, the context block, the compaction instruction, the
  auto-mode classifier ruleset, and the recap prompt are Claude Code's own,
  adapted where a provider requires it.
- Memory lives in Claude Code's own folder, so both tools share it.
- Auto mode is the default permission mode, with Claude Code's two-stage
  classifier.
- Subagents, forks, worktree isolation, plan mode, structured tasks,
  background shells, and `ultracode` workflows behave as they do in Claude
  Code.

## What is different by design

| Area | Claude Code | One Code |
|---|---|---|
| Models | Anthropic models. | Any provider pi supports, switchable mid-session, with a different model per role. |
| Tool names on the wire | PascalCase (`Read`, `Bash`). | snake_case (`read`, `bash`); `Agent` and `SendMessage` keep their names. Claude Code names still work in rules and hook matchers. |
| Permission-mode key | shift+tab. | ctrl+q; alt+m on Windows and WSL. pi reserves shift+tab for the reasoning-effort dial and, on Windows, ctrl+q for queuing a follow-up. |
| Task-list key | ctrl+t. | alt+t, or `/tasks show` and `/tasks hide`. pi reserves ctrl+t for thinking blocks. |
| Where auto mode's classifier runs | On Anthropic's API server, through a request field the endpoint must support; the local classifier is a fallback only until about October 23, 2026 ([LiteLLM's notes](https://docs.litellm.ai/blog/claude-code-server-side-auto-mode)). | In the harness, on a model from your own provider, so auto mode works with any provider. |
| Deleting files in auto mode | The whole project directory is trusted. | A delete is approved only when git can recover the file; otherwise the classifier decides. |
| Approving a call auto mode denied | `/permissions` tells the model permission was granted; the retry is judged again. | The approval lets that exact call run once without the classifier. |
| Auto-mode built-in rules | A section's built-in rules can be switched off. | Always in effect; your rules only add to them. |
| Workspace directories | Reads, edits in accept-edits mode, and auto-mode writes. | Reads and accept-edits edits. Auto-mode writes there go to the classifier, and credential files there still prompt. |
| Bypass mode | Protected paths stay protected. | Bypass mode bypasses everything, including protected paths. |
| First-run consent for auto mode | Asked once. | Not asked. Auto mode is on from the first session. |
| OS sandbox | Paired with auto mode. | None. Run One Code in a container for OS-level isolation. |
| Cost display | Main conversation. | All-in: subagents, classifier, reader, and recap calls included. |
| Web search | Anthropic's search. | The provider's own search when it has one, else Brave, Tavily, or a keyless fallback. |
| Reasoning effort | Fixed per model. | A slider from `off` to `max`, plus `ultracode`. |
| Session storage | `~/.claude`. | `~/.onecode` for One Code's state and the bundled app's pi state. `~/.claude` is read-only except for memory. |
| Update command | `/upgrade`. | A daily check that shows an install-aware upgrade hint. |
| Config editing | `/config`, `/hooks`, `/statusline`. | Settings files, plus `/doctor` to see what is in effect. |

## Tools that are not provided

These Claude Code tools depend on Anthropic-hosted or desktop services and
have no equivalent here: `Artifact`, `ReportFindings`,
`ShareOnboardingGuide`, `PushNotification`, `RemoteTrigger`, `DesignSync`,
`EndConversation`, and `SendFeedback`. Scheduling within a session is
available through the cron tools, `/loop`, and `schedule_wakeup`;
scheduled cloud sessions aren't.

The `Agent` tool's remote isolation option isn't implemented.

## Commands that are not provided

Claude Code commands with no One Code or pi counterpart: `/cost` (the
footer shows cost instead), `/status`, `/vim`, `/terminal-setup`, `/bug`,
`/help`, `/rewind`, `/hooks`, `/ide`, `/install-github-app`,
`/statusline`, `/privacy-settings`, and `/upgrade`. pi's `/changelog` and
`/settings` cover part of `/release-notes` and `/config`. `/review` is
available through the `commit-commands` plugin when installed.

## Skills that are not bundled

One Code bundles four of Claude Code's built-in skills: `simplify`,
`code-review`, `security-review`, and `fewer-permission-prompts`. It does
not bundle the skills that need Claude Code's hosted or desktop surfaces
(`design`, `dataviz`, the `artifact-*` guides, and the publishers), the
account and desktop skills (`update-config`, `keybindings-help`,
`claude-in-chrome`, `debug`, `usage`, `schedule`, `batch`,
`claude-code-guide`), the run-skill generators, or the `claude-api`
reference. See
[Skills not bundled](skills-plugins-and-mcp.md#skills-not-bundled).

## Hooks

Eight events are supported: `PreToolUse`, `PostToolUse`,
`UserPromptSubmit`, `Stop`, `SessionStart`, `SessionEnd`, `PreCompact`, and
`PostCompact`. `Notification`, `SubagentStop`, and `PermissionRequest` are
not. Hook types other than `command` are skipped. A hook can block an
action but never pre-approve one. See [Hooks](hooks.md).

## Settings keys that are ignored

The `env` block is read only for `CLAUDE_CODE_SUBAGENT_MODEL`, and only
from user and managed scope. `includeCoAuthoredBy`, `apiKeyHelper`, `forceLoginMethod`,
`cleanupPeriodDays`, and `spinnerTipsEnabled` aren't read. Run
`/doctor report` to see, per file, which keys were used, ignored, or
refused.

## Prompt layout on Anthropic models

Claude Code delivers part of its reminder stack to Opus and Sonnet as a
system-role message after the first user message. pi's message model can't
express that, so One Code uses the layout Claude Code uses for Haiku on
every model. The content is the same; only the placement differs.

## Platform support

- **macOS and Linux** are developed and verified. **WSL** works the same
  way.
- **Native Windows** follows Claude Code's shape: Git for Windows is
  optional, PowerShell is the primary shell tool when it is enabled (on by
  default on Windows, `CLAUDE_CODE_USE_POWERSHELL_TOOL=0` turns it off), and
  your `PowerShell(...)` rules, `CLAUDE_CODE_GIT_BASH_PATH`, and per-hook
  `shell` field work unchanged. The PowerShell tool's description is Claude
  Code's own text. What differs: One Code has no PowerShell command parser
  yet, so in auto mode every PowerShell command that isn't on Claude Code's
  read-only cmdlet list goes to the classifier (Claude Code auto-approves
  more in-project work), and the git-recoverability shortcut for in-project
  deletes is bash-only. Verified on CI runners and through a `pwsh` on
  macOS; a real Windows desktop has not been driven end to end yet. See
  [Windows](windows.md).

## Provider notes

- End-to-end verification has focused on Anthropic, OpenAI, and OpenRouter.
  Other providers are less exercised.
- Some models reject options that others accept. One Code sends minimal
  options to its side calls (classifier, recap, reader) for this reason. A
  provider incompatibility in a side call fails closed: a classifier that
  can't answer blocks the action.
- Prompt-cache lifetime and pricing are the provider's. The extended
  one-hour cache applies to Anthropic; other providers use their own
  values.

## Known issues

- A write or edit tool can reach a file that only a `Bash` deny rule
  protects, because in-project writes take the deterministic fast path in
  auto mode and aren't classified. Write `deny` rules for the write tools
  as well. This is documented and accepted rather than fixed.
- GLM-5.3 and GLM-5.3 Flash, used as the classifier, approve a request to
  back up the project to an unnamed outside location that the ruleset says
  to block.
- Running a skill in a one-shot run (`-p '/simplify'`) delivers the skill
  but starts no model turn, so the process exits without doing anything.
  Interactive sessions are unaffected.
- The reasoning effort set with `/effort` doesn't persist across
  restarts; the model chosen with `/model` does. To save a level, open
  pi's `/thinking` picker and press **ctrl+s**, or pass `--thinking`.
- A subagent spawn that is blocked before it starts can leave its requested
  run name reserved; a retry with the same name is renamed automatically.
- Under pi's RPC transport, `SessionStart` hooks fire twice per `/clear`.
- A background subagent started before `/clear` can report its cost into
  the new session's footer total.
- `/lsp` diagnostics from a subagent's edits surface in the parent's
  context, not the subagent's. This matches Claude Code.
- Subagents run in-process. A subagent that stops responding is stopped
  after 30 minutes, and an out-of-memory condition affects the whole
  process.
- MCP servers that use server-sent events (`type: "sse"`) are untested.
  Stdio and HTTP transports are verified. The OAuth flow is implemented but
  has had limited live testing.
- Plugin marketplaces support git and local sources only; npm and pip
  sources, version pinning, dependency resolution, and enterprise
  blocklists aren't implemented.

Open work is tracked in the project's issue tracker on GitHub.
