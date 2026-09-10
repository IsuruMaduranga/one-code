# Hooks

Hooks are shell commands that run at fixed points in a session. One Code
runs Claude Code's command hooks from your existing settings files, with
the same input, output, and exit-code contract, so hooks you wrote for
Claude Code work unchanged.

## Where hooks come from

Hooks are read from the `hooks` block of these files:

- `~/.claude/settings.json` (user scope)
- Managed settings
- `.claude/settings.json` (project scope)
- `.claude/settings.local.json` (project scope)
- Installed plugins

A project's hooks can run arbitrary code, so they run only after you
approve them once. At startup One Code lists each command from the
project's files and asks "Run this project's hooks?". The approval is
stored in `~/.onecode/hooks/project-approvals.json` with a hash of the hook
configuration, so any change asks again. Declining is remembered for the
session only. User, managed, and plugin hooks never prompt.

Only command hooks are supported. Hook entries of type `http`, `prompt`, or
`agent` are skipped with a diagnostic.

## Supported events

| Event | When it runs |
|---|---|
| `PreToolUse` | Before a tool runs. Can block the call or rewrite its input. |
| `PostToolUse` | After a tool returns. Can replace the result or add context. |
| `UserPromptSubmit` | When you submit a prompt. Can block it or add context. |
| `Stop` | When the model finishes a turn. |
| `SessionStart` | When a session starts, resumes, clears, or compacts. |
| `SessionEnd` | When a session ends. |
| `PreCompact` | Before context compaction. |
| `PostCompact` | After context compaction, with the summary. |

Claude Code's `Notification`, `SubagentStop`, and `PermissionRequest`
events are not supported. pi has no event that carries the notification
concept, and the other two are not implemented.

Hooks also run inside subagents: a `PreToolUse` hook that blocks a command
blocks it in a subagent too.

Under pi's RPC transport, `SessionStart` fires twice per `/clear`. This is
a pi behavior.

## What a hook receives

The hook's standard input is a JSON object with these fields:

| Field | Present | Meaning |
|---|---|---|
| `session_id` | Always | The session id. |
| `transcript_path` | Always | The session file, or an empty string when there is none. |
| `cwd` | Always | The working directory. |
| `hook_event_name` | Always | The event name from the table. |
| `tool_name`, `tool_input` | Tool events | The tool and its arguments. Tool names are One Code's names; see [Claude Code tool names](tools.md#claude-code-tool-names). |
| `tool_response` | `PostToolUse` | `{ content, is_error }`. |
| `prompt` | `UserPromptSubmit` | The submitted text. |
| `stop_hook_active` | `Stop` | Whether a Stop hook is already running. |
| `trigger` | Compaction events | `manual` or `auto`. |
| `custom_instructions` | `PreCompact` | Instructions passed to `/compact`. |
| `compact_summary` | `PostCompact` | The summary that replaced the context. |
| `source` | `SessionStart` | `startup`, `resume`, `clear`, or `compact`. |
| `reason` | `SessionEnd` | `clear`, `logout`, `prompt_input_exit`, or `other`. |
| `agent_id`, `agent_type` | Inside a subagent | Identify the subagent making the call. |

The hook's environment also carries `CLAUDE_PROJECT_DIR`.

Hook matchers match on the tool name. Claude Code's PascalCase names work.

## How a hook's result is read

| Outcome | Effect |
|---|---|
| Exit code 0 with JSON on stdout | The JSON is read as an envelope; see the following table. |
| Exit code 0 with other output | The hook passes. For `UserPromptSubmit` and `SessionStart`, the output is added to the model's context. |
| Exit code 2 | The action is blocked. Standard error is the reason. |
| Any other exit code | The hook passes and its output is ignored. |
| Timeout | `PreToolUse` and `UserPromptSubmit` block (fail closed). Other events pass. |
| The command could not be started | The hook passes; this is an environment problem, not a verdict. |

Envelope fields honored in a JSON result:

| Field | Effect |
|---|---|
| `continue: false` | Blocks, with `stopReason` as the reason. |
| `decision: "block"` | Blocks, with `reason` as the reason. |
| `hookSpecificOutput.permissionDecision` | `"deny"` and `"ask"` both block, with `permissionDecisionReason`. `"allow"` is read but never honored; a hook cannot pre-approve an action, and the permission gate still runs. |
| `hookSpecificOutput.updatedInput` | Replaces the tool's input (`PreToolUse`). |
| `hookSpecificOutput.updatedToolResult` | Replaces the tool's result (`PostToolUse`). |
| `hookSpecificOutput.additionalContext` | Adds text to the model's context. |
| `systemMessage` | Shown to you. |

A `PreToolUse` block stops the call before the permission gate runs, so no
approval prompt appears for a hook-blocked call.

## Debugging hooks

Set `CC_HOOKS_DEBUG=1` before launching to print each hook dispatch and its
outcome to stderr. Decisions are also appended to
`~/.onecode/hooks/hooks-decisions.jsonl` while the variable is set.

Hooks run through `/bin/sh`. On native Windows this path does not exist,
which is one reason native Windows is unsupported; use WSL.
